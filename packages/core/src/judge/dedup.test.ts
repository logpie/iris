import { describe, expect, it } from 'vitest';
import { type TentativeFinding, dedupFindings } from './dedup.js';

function mk(
  overrides: Partial<TentativeFinding> &
    Pick<TentativeFinding, 'title' | 'category' | 'severity_hint'>,
): TentativeFinding {
  return {
    event_id: 'E1',
    title: overrides.title,
    category: overrides.category,
    severity_hint: overrides.severity_hint,
    evidence_event_ids: overrides.evidence_event_ids ?? ['T1'],
    rationale: overrides.rationale ?? 'r',
    ...(overrides.where !== undefined ? { where: overrides.where } : {}),
  };
}

describe('dedupFindings', () => {
  it('groups identical findings into one group', () => {
    const ts: TentativeFinding[] = [
      mk({
        title: 'Login fails',
        category: 'bug',
        severity_hint: 'major',
        where: { url: '/login', selector: '#submit' },
        evidence_event_ids: ['T1'],
      }),
      mk({
        title: 'Login fails',
        category: 'bug',
        severity_hint: 'major',
        where: { url: '/login', selector: '#submit' },
        evidence_event_ids: ['T2'],
      }),
    ];
    const groups = dedupFindings(ts);
    expect(groups).toHaveLength(1);
    expect(groups[0]?.members).toHaveLength(2);
    expect(groups[0]?.merged_evidence_event_ids).toEqual(['T1', 'T2']);
  });

  it('keeps differing categories in separate groups', () => {
    const ts: TentativeFinding[] = [
      mk({ title: 'X', category: 'bug', severity_hint: 'major' }),
      mk({ title: 'X', category: 'a11y', severity_hint: 'major' }),
    ];
    const groups = dedupFindings(ts);
    expect(groups).toHaveLength(2);
  });

  it('keeps differing where in separate groups', () => {
    const ts: TentativeFinding[] = [
      mk({ title: 'X', category: 'bug', severity_hint: 'major', where: { url: '/a' } }),
      mk({ title: 'X', category: 'bug', severity_hint: 'major', where: { url: '/b' } }),
    ];
    const groups = dedupFindings(ts);
    expect(groups).toHaveLength(2);
  });

  it('case-insensitive and whitespace-insensitive title matching', () => {
    const ts: TentativeFinding[] = [
      mk({ title: 'Login Fails', category: 'bug', severity_hint: 'major' }),
      mk({ title: 'login   fails', category: 'bug', severity_hint: 'major' }),
    ];
    const groups = dedupFindings(ts);
    expect(groups).toHaveLength(1);
  });

  it('dedupes evidence ids within a group', () => {
    const ts: TentativeFinding[] = [
      mk({ title: 'X', category: 'bug', severity_hint: 'major', evidence_event_ids: ['T1', 'T2'] }),
      mk({ title: 'X', category: 'bug', severity_hint: 'major', evidence_event_ids: ['T2', 'T3'] }),
    ];
    const groups = dedupFindings(ts);
    expect(groups[0]?.merged_evidence_event_ids).toEqual(['T1', 'T2', 'T3']);
  });

  it('preserves order across groups (insertion order)', () => {
    const ts: TentativeFinding[] = [
      mk({ title: 'A', category: 'bug', severity_hint: 'major' }),
      mk({ title: 'B', category: 'bug', severity_hint: 'major' }),
      mk({ title: 'A', category: 'bug', severity_hint: 'major' }),
    ];
    const groups = dedupFindings(ts);
    expect(groups).toHaveLength(2);
    expect(groups[0]?.members[0]?.title).toBe('A');
    expect(groups[1]?.members[0]?.title).toBe('B');
  });
});
