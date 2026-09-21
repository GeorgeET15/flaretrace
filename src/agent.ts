import { Agent } from 'agents';
import { MODEL, buildSystemPrompt } from './prompts';
import {
  type AgentState, type Incident, type ConnectivityState, type TestResult,
  type IncidentStatus, type ReachabilityStatus, type DnsStatus,
  type TestType, type TestOutcome,
  INITIAL_INCIDENT,
} from './types';

export type { AgentState } from './types';

export class FlareTraceAgent extends Agent<Env, AgentState> {
  initialState: AgentState = {
    messages: [],
    incident: INITIAL_INCIDENT,
  };

  async onRequest(request: Request): Promise<Response> {
    const url = new URL(request.url);

    if (request.method === 'GET'  && url.pathname === '/history') return this.onHistory();
    if (request.method === 'POST' && url.pathname === '/summary') return this.onSummary();
    if (request.method === 'POST' && url.pathname === '/chat')    return this.onChat(request);

    return json({ error: 'Not found.' }, 404);
  }

  private onHistory(): Response {
    return json({
      messages: this.state?.messages ?? [],
      incident: ensureIncidentShape(this.state?.incident),
    });
  }

  private onSummary(): Response {
    const incident = ensureIncidentShape(this.state?.incident);
    return json({ summary: formatSummary(incident) });
  }

  private async onChat(request: Request): Promise<Response> {
    let body: { message?: string };
    try { body = await request.json(); } catch { return json({ error: 'Invalid JSON body.' }, 400); }

    const message = body.message?.trim();
    if (!message) return json({ error: 'message is required.' }, 400);

    const history  = this.state?.messages ?? [];
    const incident = ensureIncidentShape(this.state?.incident);

    const userMessage = { role: 'user' as const, content: message };
    const aiMessages  = [
      { role: 'system' as const, content: buildSystemPrompt(incident) },
      ...history,
      userMessage,
    ];

    const aiParams = { messages: aiMessages, max_tokens: 900, temperature: 0.3 };
    let result: unknown;
    try {
      result = await this.env.AI.run(MODEL, aiParams);
    } catch (err: unknown) {
      const retryable = err !== null && typeof err === 'object' && 'retryable' in err
        && (err as { retryable: unknown }).retryable === true;
      if (!retryable) return json({ error: 'AI service error. Please try again.' }, 502);
      try {
        result = await this.env.AI.run(MODEL, aiParams);
      } catch {
        return json({ error: 'AI service temporarily unavailable. Please try again.' }, 503);
      }
    }

    const rawText = await extractResponseText(result);
    if (rawText === null) return json({ error: 'Unexpected response format from AI model.' }, 500);

    const parsed          = parseModelResponse(rawText);
    const responseMessage = parsed?.reply ?? rawText;
    const updatedIncident = parsed ? mergeIncidentUpdates(incident, parsed) : incident;

    const newNextStep = typeof parsed?.nextStep === 'string' && parsed.nextStep.trim()
      ? parsed.nextStep.trim()
      : null;
    const displayMessage = newNextStep
      ? `${responseMessage.trimEnd()}\n\`\`\`\n${newNextStep}\n\`\`\``
      : responseMessage;

    this.setState({
      messages: [...history, userMessage, { role: 'assistant', content: displayMessage }],
      incident: updatedIncident,
    });

    return json({ message: displayMessage, incident: updatedIncident });
  }
}

// ── Model response shape ──────────────────────────────────────────────────────

export interface ModelResponse {
  reply:         string;
  gateway?:      { address?: unknown; status?: unknown };
  internetIp?:   { address?: unknown; status?: unknown };
  dns?:          { status?: unknown };
  tests?:        unknown[];
  observations?: unknown[];
  hypotheses?:   unknown[];
  nextStep?:     unknown;
}

// ── Parsing ───────────────────────────────────────────────────────────────────

function parseModelResponse(raw: string): ModelResponse | null {
  const direct = tryParseModel(raw);
  if (direct) return direct;

  const stripped = raw.replace(/^```(?:json)?\s*/i, '').replace(/\s*```\s*$/, '').trim();
  const fenced   = tryParseModel(stripped);
  if (fenced) return fenced;

  const match = raw.match(/\{[\s\S]*\}/);
  if (match) return tryParseModel(match[0]);

  return null;
}

function tryParseModel(text: string): ModelResponse | null {
  try {
    const obj = JSON.parse(text);
    // Accept both 'reply' (new schema) and 'message' (legacy fallback)
    if (typeof obj?.reply   === 'string') return obj as ModelResponse;
    if (typeof obj?.message === 'string') return { ...obj, reply: obj.message } as ModelResponse;
    return null;
  } catch {
    return null;
  }
}

// ── Merge logic ───────────────────────────────────────────────────────────────
// Applies partial updates from the model onto the current incident state.
// Fields the model omits are preserved unchanged.

export function mergeIncidentUpdates(current: Incident, update: ModelResponse): Incident {
  return {
    status:         current.status,
    connectivity:   mergeConnectivity(current.connectivity, update),
    observations:   mergeObservations(current.observations,   update.observations),
    testsPerformed: mergeTests(current.testsPerformed, update.tests),
    hypotheses:     coerceStringArray(update.hypotheses),
    nextStep:       typeof update.nextStep === 'string' && update.nextStep.trim()
                      ? update.nextStep.trim()
                      : current.nextStep,
  };
}

function mergeConnectivity(current: ConnectivityState, update: ModelResponse): ConnectivityState {
  return {
    gateway:    mergeReachability(current.gateway,    update.gateway),
    internetIp: mergeReachability(current.internetIp, update.internetIp),
    dns:        mergeDnsField(current.dns,             update.dns),
  };
}

function mergeReachability(
  current: { address?: string; status: ReachabilityStatus },
  raw:     unknown,
): { address?: string; status: ReachabilityStatus } {
  if (typeof raw !== 'object' || raw === null) return current;
  const u      = raw as Record<string, unknown>;
  const status  = coerceReachability(u.status) ?? current.status;
  const address = typeof u.address === 'string' && u.address.trim()
    ? u.address.trim()
    : current.address;
  const out: { address?: string; status: ReachabilityStatus } = { status };
  if (address) out.address = address;
  return out;
}

function mergeDnsField(
  current: { status: DnsStatus },
  raw:     unknown,
): { status: DnsStatus } {
  if (typeof raw !== 'object' || raw === null) return current;
  const u      = raw as Record<string, unknown>;
  const status = coerceDns(u.status) ?? current.status;
  return { status };
}

// Dedup by type+target: the latest result for a given test replaces the old one.
export function mergeTests(current: TestResult[], rawTests: unknown): TestResult[] {
  if (!Array.isArray(rawTests) || rawTests.length === 0) return current;
  const updated = [...current];
  for (const raw of rawTests) {
    const coerced = coerceTestResult(raw);
    if (!coerced) continue;
    const key = `${coerced.type}:${(coerced.target ?? '').toLowerCase()}`;
    const idx = updated.findIndex(t => `${t.type}:${(t.target ?? '').toLowerCase()}` === key);
    if (idx >= 0) {
      updated[idx] = coerced;
    } else {
      updated.push(coerced);
    }
  }
  return updated;
}

// Observations are append-only but deduplicated (case-insensitive).
export function mergeObservations(current: string[], rawObs: unknown): string[] {
  if (!Array.isArray(rawObs)) return current;
  const incoming = rawObs
    .filter((o): o is string => typeof o === 'string' && o.trim().length > 0)
    .map(o => o.trim());
  const seen = new Set(current.map(o => o.toLowerCase()));
  const fresh = incoming.filter(o => !seen.has(o.toLowerCase()));
  return [...current, ...fresh];
}

// ── Validation helpers ────────────────────────────────────────────────────────

const REACHABILITY:    ReachabilityStatus[] = ['reachable', 'unreachable', 'unknown'];
const DNS_STATUSES:    DnsStatus[]          = ['working', 'failing', 'unknown'];
const INCIDENT_STATES: IncidentStatus[]     = ['investigating', 'resolved', 'escalated'];
const TEST_TYPES:      TestType[]           = ['ping', 'traceroute', 'dns', 'ip-config', 'other'];
const TEST_OUTCOMES:   TestOutcome[]        = ['success', 'failure', 'partial', 'unknown'];

export function coerceReachability(v: unknown): ReachabilityStatus | null {
  return REACHABILITY.includes(v as ReachabilityStatus) ? (v as ReachabilityStatus) : null;
}
export function coerceDns(v: unknown): DnsStatus | null {
  return DNS_STATUSES.includes(v as DnsStatus) ? (v as DnsStatus) : null;
}
function coerceIncidentStatus(v: unknown): IncidentStatus | null {
  return INCIDENT_STATES.includes(v as IncidentStatus) ? (v as IncidentStatus) : null;
}
function coerceTestResult(raw: unknown): TestResult | null {
  if (typeof raw !== 'object' || raw === null) return null;
  const r      = raw as Record<string, unknown>;
  const type   = TEST_TYPES.includes(r.type as TestType)      ? (r.type   as TestType)    : 'other';
  const result = TEST_OUTCOMES.includes(r.result as TestOutcome) ? (r.result as TestOutcome) : 'unknown';
  if (typeof r.summary !== 'string' || !r.summary.trim()) return null;
  const test: TestResult = { type, result, summary: r.summary.trim() };
  if (typeof r.target === 'string' && r.target.trim()) test.target = r.target.trim();
  return test;
}
function coerceStringArray(val: unknown): string[] {
  if (!Array.isArray(val)) return [];
  return [...new Set(
    val
      .filter((v): v is string => typeof v === 'string' && v.trim().length > 0)
      .map(v => v.trim()),
  )];
}

// ── Backward-compatibility migration ─────────────────────────────────────────
// Sessions created before Milestone 7 have:
//   { status, symptoms: string[], observations: string[], testsPerformed: string[], hypotheses, nextStep }
// We upgrade them to the new shape on first access.

export function ensureIncidentShape(raw: unknown): Incident {
  if (typeof raw !== 'object' || raw === null) return INITIAL_INCIDENT;
  const r = raw as Record<string, unknown>;

  const status = coerceIncidentStatus(r.status) ?? 'investigating';

  const conn = typeof r.connectivity === 'object' && r.connectivity !== null
    ? (r.connectivity as Record<string, unknown>)
    : {};

  const connectivity: ConnectivityState = {
    gateway:    ensureReachabilityShape(conn.gateway),
    internetIp: ensureReachabilityShape(conn.internetIp),
    dns:        ensureDnsShape(conn.dns),
  };

  // Old sessions may have string[] for testsPerformed — discard those.
  const testsPerformed: TestResult[] = Array.isArray(r.testsPerformed)
    ? r.testsPerformed.flatMap(t => {
        if (typeof t === 'string') return [];
        const c = coerceTestResult(t);
        return c ? [c] : [];
      })
    : [];

  return {
    status,
    connectivity,
    observations:   Array.isArray(r.observations)
      ? r.observations.filter((v): v is string => typeof v === 'string')
      : [],
    testsPerformed,
    hypotheses: Array.isArray(r.hypotheses)
      ? r.hypotheses.filter((v): v is string => typeof v === 'string')
      : [],
    nextStep: typeof r.nextStep === 'string' && r.nextStep ? r.nextStep : null,
  };
}

function ensureReachabilityShape(raw: unknown): { address?: string; status: ReachabilityStatus } {
  if (typeof raw !== 'object' || raw === null) return { status: 'unknown' };
  const r   = raw as Record<string, unknown>;
  const out: { address?: string; status: ReachabilityStatus } = {
    status: coerceReachability(r.status) ?? 'unknown',
  };
  if (typeof r.address === 'string' && r.address.trim()) out.address = r.address.trim();
  return out;
}

function ensureDnsShape(raw: unknown): { status: DnsStatus } {
  if (typeof raw !== 'object' || raw === null) return { status: 'unknown' };
  const r = raw as Record<string, unknown>;
  return { status: coerceDns(r.status) ?? 'unknown' };
}

// ── Incident summary formatter ────────────────────────────────────────────────
// Generates a plain-text summary from structured state — no AI call needed.

function formatSummary(incident: Incident): string {
  const { connectivity, testsPerformed, observations, hypotheses, nextStep } = incident;
  const lines: string[] = ['INCIDENT SUMMARY', ''];

  lines.push('CONNECTIVITY');
  const gw = connectivity.gateway.address
    ? `Gateway (${connectivity.gateway.address})`
    : 'Gateway';
  lines.push(`${reachSym(connectivity.gateway.status)} ${gw} — ${connectivity.gateway.status}`);
  const ip = connectivity.internetIp.address
    ? `Internet (${connectivity.internetIp.address})`
    : 'Internet';
  lines.push(`${reachSym(connectivity.internetIp.status)} ${ip} — ${connectivity.internetIp.status}`);
  lines.push(`${dnsSym(connectivity.dns.status)} DNS — ${connectivity.dns.status}`);

  if (testsPerformed.length > 0) {
    lines.push('');
    lines.push('TESTS PERFORMED');
    for (const t of testsPerformed) {
      const target = t.target ? ` ${t.target}` : '';
      lines.push(`· ${t.type}${target}: ${t.summary}`);
    }
  }

  if (observations.length > 0) {
    lines.push('');
    lines.push('EVIDENCE');
    for (const o of observations) lines.push(`· ${o}`);
  }

  if (hypotheses.length > 0) {
    lines.push('');
    lines.push('LIKELY CAUSES');
    for (const h of hypotheses) lines.push(`· ${h}`);
  }

  if (nextStep) {
    lines.push('');
    lines.push('RECOMMENDED NEXT ACTION');
    lines.push(nextStep);
  }

  return lines.join('\n');
}

function reachSym(s: ReachabilityStatus): string {
  return s === 'reachable' ? '✓' : s === 'unreachable' ? '✗' : '?';
}
function dnsSym(s: DnsStatus): string {
  return s === 'working' ? '✓' : s === 'failing' ? '✗' : '?';
}

// ── AI response extraction ────────────────────────────────────────────────────

async function extractResponseText(result: unknown): Promise<string | null> {
  if (typeof result === 'string') return result;
  if (result instanceof ReadableStream) {
    const reader  = (result as ReadableStream<Uint8Array>).getReader();
    const decoder = new TextDecoder();
    let text = '';
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      text += decoder.decode(value, { stream: true });
    }
    return text.trim() || null;
  }
  if (result !== null && typeof result === 'object') {
    const r = result as Record<string, unknown>;
    if (typeof r.response === 'string') return r.response;
    if (Array.isArray(r.choices) && r.choices.length > 0) {
      const msg = (r.choices[0] as Record<string, unknown>).message as Record<string, unknown> | undefined;
      if (msg && typeof msg.content === 'string') return msg.content;
    }
  }
  return null;
}

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}
