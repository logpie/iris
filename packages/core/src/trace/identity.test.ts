import { describe, expect, it } from 'vitest';
import { canonicalPayload, eventContentHash, findingHash, normalizeSelector } from './identity.js';
import type { TraceEvent } from './schema.js';

const ev = (
  id: string,
  kind: TraceEvent['kind'],
  payload: Record<string, unknown> = {},
): TraceEvent => ({
  v: 1,
  id,
  ts: 0,
  step: 0,
  target_kind: 'web',
  kind,
  actor: 'adapter',
  payload,
});

describe('normalizeSelector', () => {
  it('collapses nth-child indices', () => {
    expect(normalizeSelector('button:nth-child(1)')).toBe('button:nth-child(*)');
    expect(normalizeSelector('button:nth-child(99)')).toBe('button:nth-child(*)');
  });
  it('preserves class + id selectors', () => {
    expect(normalizeSelector('.todo-list li')).toBe('.todo-list li');
    expect(normalizeSelector('#login')).toBe('#login');
  });
});

describe('eventContentHash for action events', () => {
  it('hashes click events identically across runs', () => {
    const a = ev('ULID1', 'action', { tool: 'click', args: { selector: '.btn' } });
    const b = ev('ULID2', 'action', { tool: 'click', args: { selector: '.btn' } });
    expect(eventContentHash(a)).toBe(eventContentHash(b));
  });
  it('different tools produce different hashes', () => {
    const a = ev('X', 'action', { tool: 'click', args: { selector: 'div' } });
    const b = ev('X', 'action', { tool: 'type', args: { selector: 'div' } });
    expect(eventContentHash(a)).not.toBe(eventContentHash(b));
  });
  it('different selectors produce different hashes', () => {
    const a = ev('X', 'action', { tool: 'click', args: { selector: '.a' } });
    const b = ev('X', 'action', { tool: 'click', args: { selector: '.b' } });
    expect(eventContentHash(a)).not.toBe(eventContentHash(b));
  });
  it('type actions hash on selector only, ignoring text', () => {
    const a = ev('X', 'action', {
      tool: 'type',
      args: { selector: '.new-todo', text: 'Buy milk' },
    });
    const b = ev('X', 'action', {
      tool: 'type',
      args: { selector: '.new-todo', text: 'Test todo' },
    });
    expect(eventContentHash(a)).toBe(eventContentHash(b));
  });
  it('navigate actions hash on host+path, ignoring query string differences', () => {
    const a = ev('X', 'action', { tool: 'navigate', args: { url: 'https://x.com/foo?a=1' } });
    const b = ev('X', 'action', { tool: 'navigate', args: { url: 'https://x.com/foo?a=2' } });
    expect(eventContentHash(a)).toBe(eventContentHash(b));
  });
});

describe('eventContentHash for probe_result events', () => {
  it('hashes on presence/absence, not specific counts', () => {
    const a = ev('X', 'probe_result', { probe: 'axe', summary: { violations: 3 } });
    const b = ev('X', 'probe_result', { probe: 'axe', summary: { violations: 5 } });
    expect(eventContentHash(a)).toBe(eventContentHash(b));
  });
  it('distinguishes any-violations from no-violations', () => {
    const a = ev('X', 'probe_result', { probe: 'axe', summary: { violations: 0 } });
    const b = ev('X', 'probe_result', { probe: 'axe', summary: { violations: 1 } });
    expect(eventContentHash(a)).not.toBe(eventContentHash(b));
  });
  it('distinguishes probe names', () => {
    const a = ev('X', 'probe_result', { probe: 'axe', summary: { violations: 0 } });
    const b = ev('X', 'probe_result', {
      probe: 'console_errors_since',
      summary: { error_count: 0 },
    });
    expect(eventContentHash(a)).not.toBe(eventContentHash(b));
  });
});

describe('eventContentHash for observation events', () => {
  it('hashes first 120 chars whitespace-normalized', () => {
    const a = ev('X', 'observation', { summary: 'Hello\n\nworld   foo' });
    const b = ev('Y', 'observation', { summary: '  Hello world foo  ' });
    expect(canonicalPayload(a)).toBe(canonicalPayload(b));
  });
});

describe('findingHash', () => {
  it('stable across adjacent severities within same bucket', () => {
    const idx = new Map([['E1', { content_hash: 'h1' }]]);
    const a = findingHash(
      { title: 'X', category: 'bug', severity: 'blocker', evidence: ['E1'] },
      idx,
    );
    const b = findingHash(
      { title: 'X', category: 'bug', severity: 'major', evidence: ['E1'] },
      idx,
    );
    expect(a).toBe(b);
  });
  it('differs across severity buckets', () => {
    const idx = new Map([['E1', { content_hash: 'h1' }]]);
    const a = findingHash(
      { title: 'X', category: 'bug', severity: 'blocker', evidence: ['E1'] },
      idx,
    );
    const b = findingHash({ title: 'X', category: 'bug', severity: 'nit', evidence: ['E1'] }, idx);
    expect(a).not.toBe(b);
  });
  it('normalizes title leading numbers', () => {
    const idx = new Map([['E1', { content_hash: 'h1' }]]);
    const a = findingHash(
      { title: '1. Modal traps focus', category: 'a11y', severity: 'major', evidence: ['E1'] },
      idx,
    );
    const b = findingHash(
      { title: 'Modal traps focus', category: 'a11y', severity: 'major', evidence: ['E1'] },
      idx,
    );
    expect(a).toBe(b);
  });
  it('uses content hashes from event index (not raw ids)', () => {
    const idxA = new Map([['E1-ULID-A', { content_hash: 'h1' }]]);
    const idxB = new Map([['E1-ULID-B', { content_hash: 'h1' }]]);
    const a = findingHash(
      { title: 'X', category: 'bug', severity: 'major', evidence: ['E1-ULID-A'] },
      idxA,
    );
    const b = findingHash(
      { title: 'X', category: 'bug', severity: 'major', evidence: ['E1-ULID-B'] },
      idxB,
    );
    expect(a).toBe(b);
  });
  it('stable when evidence is reordered (sorted internally)', () => {
    const idx = new Map([
      ['E1', { content_hash: 'h1' }],
      ['E2', { content_hash: 'h2' }],
    ]);
    const a = findingHash(
      { title: 'X', category: 'bug', severity: 'major', evidence: ['E1', 'E2'] },
      idx,
    );
    const b = findingHash(
      { title: 'X', category: 'bug', severity: 'major', evidence: ['E2', 'E1'] },
      idx,
    );
    expect(a).toBe(b);
  });
});
