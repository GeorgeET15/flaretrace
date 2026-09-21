// ── Incident status ───────────────────────────────────────────────────────────
export type IncidentStatus = 'investigating' | 'resolved' | 'escalated';

// ── Normalized connectivity state ─────────────────────────────────────────────
// Each sub-field holds a single replaceable status. New explicit evidence
// overwrites the previous value; omitting a field preserves it.
export type ReachabilityStatus = 'reachable' | 'unreachable' | 'unknown';
export type DnsStatus          = 'working'   | 'failing'    | 'unknown';

export interface ConnectivityState {
  gateway:    { address?: string; status: ReachabilityStatus };
  internetIp: { address?: string; status: ReachabilityStatus };
  dns:        { status: DnsStatus };
}

// ── Structured test results ───────────────────────────────────────────────────
// Deduped by type+target: repeating a test replaces the previous result.
export type TestType    = 'ping' | 'traceroute' | 'dns' | 'ip-config' | 'other';
export type TestOutcome = 'success' | 'failure' | 'partial' | 'unknown';

export interface TestResult {
  type:    TestType;
  target?: string;
  result:  TestOutcome;
  summary: string;
}

// ── Main incident type ────────────────────────────────────────────────────────
export interface Incident {
  status:         IncidentStatus;
  connectivity:   ConnectivityState;     // normalized; each field is replaceable
  observations:   string[];             // append-only human-readable notes
  testsPerformed: TestResult[];         // deduped by type+target; latest wins
  hypotheses:     string[];             // replaced entirely each turn
  nextStep:       string | null;
}

export interface AgentState {
  messages:  Array<{ role: 'user' | 'assistant'; content: string }>;
  incident:  Incident;
}

export const INITIAL_INCIDENT: Incident = {
  status:       'investigating',
  connectivity: {
    gateway:    { status: 'unknown' },
    internetIp: { status: 'unknown' },
    dns:        { status: 'unknown' },
  },
  observations:   [],
  testsPerformed: [],
  hypotheses:     [],
  nextStep:       null,
};
