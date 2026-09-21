import { describe, it, expect } from 'vitest';
import {
  mergeTests,
  mergeObservations,
  mergeIncidentUpdates,
  ensureIncidentShape,
  coerceReachability,
  coerceDns,
  type ModelResponse,
} from '../src/agent';
import { INITIAL_INCIDENT } from '../src/types';

// ── coerceReachability ────────────────────────────────────────────────────────

describe('coerceReachability', () => {
  it('accepts valid statuses', () => {
    expect(coerceReachability('reachable')).toBe('reachable');
    expect(coerceReachability('unreachable')).toBe('unreachable');
    expect(coerceReachability('unknown')).toBe('unknown');
  });

  it('returns null for invalid values', () => {
    expect(coerceReachability('yes')).toBeNull();
    expect(coerceReachability(1)).toBeNull();
    expect(coerceReachability(null)).toBeNull();
    expect(coerceReachability(undefined)).toBeNull();
  });
});

// ── coerceDns ─────────────────────────────────────────────────────────────────

describe('coerceDns', () => {
  it('accepts valid statuses', () => {
    expect(coerceDns('working')).toBe('working');
    expect(coerceDns('failing')).toBe('failing');
    expect(coerceDns('unknown')).toBe('unknown');
  });

  it('returns null for invalid values', () => {
    expect(coerceDns('broken')).toBeNull();
    expect(coerceDns('')).toBeNull();
  });
});

// ── mergeTests ────────────────────────────────────────────────────────────────

describe('mergeTests', () => {
  it('appends a new test', () => {
    const result = mergeTests([], [
      { type: 'ping', target: '8.8.8.8', result: 'failure', summary: 'No reply' },
    ]);
    expect(result).toHaveLength(1);
    expect(result[0].target).toBe('8.8.8.8');
  });

  it('replaces an existing test with the same type+target', () => {
    const existing = [
      { type: 'ping' as const, target: '8.8.8.8', result: 'failure' as const, summary: 'No reply' },
    ];
    const updated = mergeTests(existing, [
      { type: 'ping', target: '8.8.8.8', result: 'success', summary: 'Reply received' },
    ]);
    expect(updated).toHaveLength(1);
    expect(updated[0].result).toBe('success');
    expect(updated[0].summary).toBe('Reply received');
  });

  it('does not replace a test with a different target', () => {
    const existing = [
      { type: 'ping' as const, target: '8.8.8.8', result: 'failure' as const, summary: 'No reply' },
    ];
    const updated = mergeTests(existing, [
      { type: 'ping', target: '192.168.1.1', result: 'success', summary: 'Reply' },
    ]);
    expect(updated).toHaveLength(2);
  });

  it('is case-insensitive for target matching', () => {
    const existing = [
      { type: 'ping' as const, target: '8.8.8.8', result: 'failure' as const, summary: 'No reply' },
    ];
    const updated = mergeTests(existing, [
      { type: 'ping', target: '8.8.8.8', result: 'success', summary: 'OK' },
    ]);
    expect(updated).toHaveLength(1);
  });

  it('ignores entries without a summary', () => {
    const result = mergeTests([], [
      { type: 'ping', target: '8.8.8.8', result: 'failure' },
    ]);
    expect(result).toHaveLength(0);
  });

  it('returns current list unchanged when rawTests is not an array', () => {
    const existing = [
      { type: 'ping' as const, target: '8.8.8.8', result: 'success' as const, summary: 'OK' },
    ];
    expect(mergeTests(existing, null)).toEqual(existing);
    expect(mergeTests(existing, undefined)).toEqual(existing);
    expect(mergeTests(existing, 'nope')).toEqual(existing);
  });
});

// ── mergeObservations ─────────────────────────────────────────────────────────

describe('mergeObservations', () => {
  it('appends new observations', () => {
    const result = mergeObservations([], ['Gateway responds to ping']);
    expect(result).toEqual(['Gateway responds to ping']);
  });

  it('does not duplicate identical observations (case-insensitive)', () => {
    const existing = ['Gateway responds to ping'];
    const result = mergeObservations(existing, ['gateway responds to ping']);
    expect(result).toHaveLength(1);
  });

  it('appends genuinely new observations', () => {
    const existing = ['Gateway responds to ping'];
    const result = mergeObservations(existing, ['No reply beyond first hop']);
    expect(result).toHaveLength(2);
  });

  it('returns current list unchanged when rawObs is not an array', () => {
    const existing = ['A fact'];
    expect(mergeObservations(existing, null)).toEqual(existing);
    expect(mergeObservations(existing, undefined)).toEqual(existing);
  });
});

// ── ensureIncidentShape ───────────────────────────────────────────────────────

describe('ensureIncidentShape', () => {
  it('returns INITIAL_INCIDENT for null/undefined input', () => {
    const result = ensureIncidentShape(null);
    expect(result.connectivity.gateway.status).toBe('unknown');
    expect(result.connectivity.internetIp.status).toBe('unknown');
    expect(result.connectivity.dns.status).toBe('unknown');
  });

  it('preserves valid connectivity fields', () => {
    const raw = {
      status: 'investigating',
      connectivity: {
        gateway:    { status: 'reachable', address: '192.168.1.1' },
        internetIp: { status: 'unreachable' },
        dns:        { status: 'unknown' },
      },
      observations: ['test'],
      testsPerformed: [],
      hypotheses: [],
      nextStep: null,
    };
    const result = ensureIncidentShape(raw);
    expect(result.connectivity.gateway.status).toBe('reachable');
    expect(result.connectivity.gateway.address).toBe('192.168.1.1');
    expect(result.connectivity.internetIp.status).toBe('unreachable');
  });

  it('falls back to unknown for invalid connectivity status values', () => {
    const raw = {
      status: 'investigating',
      connectivity: {
        gateway:    { status: 'YES' },
        internetIp: { status: 'NO' },
        dns:        { status: 'BROKEN' },
      },
      observations: [],
      testsPerformed: [],
      hypotheses: [],
      nextStep: null,
    };
    const result = ensureIncidentShape(raw);
    expect(result.connectivity.gateway.status).toBe('unknown');
    expect(result.connectivity.dns.status).toBe('unknown');
  });

  it('discards legacy string[] testsPerformed entries', () => {
    const raw = {
      status: 'investigating',
      connectivity: { gateway: { status: 'unknown' }, internetIp: { status: 'unknown' }, dns: { status: 'unknown' } },
      observations: [],
      testsPerformed: ['ping 192.168.1.1', 'traceroute 8.8.8.8'],
      hypotheses: [],
      nextStep: null,
    };
    const result = ensureIncidentShape(raw);
    expect(result.testsPerformed).toHaveLength(0);
  });
});

// ── mergeIncidentUpdates ──────────────────────────────────────────────────────

describe('mergeIncidentUpdates', () => {
  it('updates gateway status from unknown to reachable', () => {
    const update: ModelResponse = {
      reply: 'Gateway reachable.',
      gateway: { address: '192.168.1.1', status: 'reachable' },
    };
    const result = mergeIncidentUpdates(INITIAL_INCIDENT, update);
    expect(result.connectivity.gateway.status).toBe('reachable');
    expect(result.connectivity.gateway.address).toBe('192.168.1.1');
  });

  it('overwrites gateway reachable → unreachable when new evidence says so', () => {
    const incident = {
      ...INITIAL_INCIDENT,
      connectivity: {
        ...INITIAL_INCIDENT.connectivity,
        gateway: { status: 'reachable' as const, address: '192.168.1.1' },
      },
    };
    const update: ModelResponse = {
      reply: 'Now unreachable.',
      gateway: { address: '192.168.1.1', status: 'unreachable' },
    };
    const result = mergeIncidentUpdates(incident, update);
    expect(result.connectivity.gateway.status).toBe('unreachable');
  });

  it('preserves existing connectivity when no new evidence provided', () => {
    const incident = {
      ...INITIAL_INCIDENT,
      connectivity: {
        ...INITIAL_INCIDENT.connectivity,
        gateway: { status: 'reachable' as const, address: '192.168.1.1' },
      },
    };
    const update: ModelResponse = {
      reply: 'No new info about gateway.',
      internetIp: { status: 'unreachable' },
    };
    const result = mergeIncidentUpdates(incident, update);
    expect(result.connectivity.gateway.status).toBe('reachable');
    expect(result.connectivity.internetIp.status).toBe('unreachable');
  });

  it('replaces entire hypotheses list each turn', () => {
    const incident = {
      ...INITIAL_INCIDENT,
      hypotheses: ['old hypothesis'],
    };
    const update: ModelResponse = {
      reply: 'New analysis.',
      hypotheses: ['new hypothesis 1', 'new hypothesis 2'],
    };
    const result = mergeIncidentUpdates(incident, update);
    expect(result.hypotheses).toEqual(['new hypothesis 1', 'new hypothesis 2']);
    expect(result.hypotheses).not.toContain('old hypothesis');
  });

  it('clears hypotheses list when model returns empty array', () => {
    const incident = { ...INITIAL_INCIDENT, hypotheses: ['stale'] };
    const update: ModelResponse = { reply: 'Reset.', hypotheses: [] };
    const result = mergeIncidentUpdates(incident, update);
    expect(result.hypotheses).toHaveLength(0);
  });
});
