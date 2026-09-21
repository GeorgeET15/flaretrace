import { SELF } from 'cloudflare:test';
import { describe, it, expect } from 'vitest';

// ── API route validation ──────────────────────────────────────────────────────
// These tests are deterministic - they return before touching Workers AI
// or Durable Objects, so no AI mocking is required.

describe('POST /api/chat - input validation', () => {
  it('returns 400 for invalid JSON body', async () => {
    const res = await SELF.fetch('https://example.com/api/chat', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: 'not json',
    });
    expect(res.status).toBe(400);
    const data = await res.json() as Record<string, string>;
    expect(data.error).toContain('Invalid JSON');
  });

  it('returns 400 when message is missing', async () => {
    const res = await SELF.fetch('https://example.com/api/chat', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ sessionId: 'abc' }),
    });
    expect(res.status).toBe(400);
    const data = await res.json() as Record<string, string>;
    expect(data.error).toContain('message');
  });

  it('returns 400 when message is blank', async () => {
    const res = await SELF.fetch('https://example.com/api/chat', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ message: '   ', sessionId: 'abc' }),
    });
    expect(res.status).toBe(400);
  });

  it('returns 400 when sessionId is missing', async () => {
    const res = await SELF.fetch('https://example.com/api/chat', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ message: 'hello' }),
    });
    expect(res.status).toBe(400);
    const data = await res.json() as Record<string, string>;
    expect(data.error).toContain('sessionId');
  });
});

describe('GET /api/history - input validation', () => {
  it('returns 400 when sessionId query param is absent', async () => {
    const res = await SELF.fetch('https://example.com/api/history');
    expect(res.status).toBe(400);
    const data = await res.json() as Record<string, string>;
    expect(data.error).toContain('sessionId');
  });
});

describe('POST /api/summary - input validation', () => {
  it('returns 400 for invalid JSON body', async () => {
    const res = await SELF.fetch('https://example.com/api/summary', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: 'bad',
    });
    expect(res.status).toBe(400);
  });

  it('returns 400 when sessionId is missing', async () => {
    const res = await SELF.fetch('https://example.com/api/summary', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({}),
    });
    expect(res.status).toBe(400);
    const data = await res.json() as Record<string, string>;
    expect(data.error).toContain('sessionId');
  });
});

describe('Unknown API routes', () => {
  it('returns 404 for unrecognised /api/ paths', async () => {
    const res = await SELF.fetch('https://example.com/api/unknown');
    expect(res.status).toBe(404);
  });
});
