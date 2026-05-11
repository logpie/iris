// Stable content hashes for trace events and findings — the load-bearing
// piece for cross-run diff (G4). Identity is computed from the *content* of
// the event/finding, not from the run-time ULID. Two runs of the same app
// that produce the same actions and findings will hash identically.

import { createHash } from 'node:crypto';
import type { JudgeFinding } from '../judge/judge.js';
import type { TraceEvent } from './schema.js';

function sha1Short(s: string): string {
  return createHash('sha1').update(s).digest('hex').slice(0, 16);
}

// Selector normalization: strip nth-child indices (they shift when other
// siblings appear) and collapse whitespace. Keeps semantic class/id matchers.
export function normalizeSelector(sel?: string): string {
  if (!sel) return '';
  return sel
    .replace(/:nth-child\(\d+\)/g, ':nth-child(*)')
    .replace(/:nth-of-type\(\d+\)/g, ':nth-of-type(*)')
    .replace(/\s+/g, ' ')
    .trim();
}

function hostPathOf(url?: string): string {
  if (!url) return '';
  try {
    const u = new URL(url);
    return `${u.host}${u.pathname.replace(/\/$/, '')}`;
  } catch {
    return '';
  }
}

// Per-event-kind canonical payload extraction. Real payload shapes verified
// against the existing TodoMVC trace and packages/adapter-web/src/probes/.
//
// Goals:
// - Stable across re-runs of the same flow on the same app
// - Distinguishes meaningfully different actions
// - Ignores volatile fields (timeouts, run-specific IDs, generated text)
export function canonicalPayload(event: TraceEvent): string {
  const p = (event.payload ?? {}) as Record<string, unknown>;
  const args = (p.args ?? {}) as Record<string, unknown>;

  switch (event.kind) {
    case 'action': {
      const tool = p.tool as string | undefined;
      // type actions: hash the selector only — the typed text is user data
      // ("Buy groceries" vs "Test todo") that varies across runs.
      if (tool === 'type') {
        return JSON.stringify({ tool, selector: normalizeSelector(args.selector as string) });
      }
      if (tool === 'navigate') {
        return JSON.stringify({ tool, url: hostPathOf(args.url as string) });
      }
      if (tool === 'press') {
        return JSON.stringify({ tool, key: args.key });
      }
      // click / hover / scroll / wait_for etc: just selector
      return JSON.stringify({
        tool,
        selector: normalizeSelector(args.selector as string),
      });
    }
    case 'action_result':
      return JSON.stringify({ tool: p.tool, ok: p.ok });
    case 'probe_result':
      return JSON.stringify({
        probe: p.probe,
        // Hash on probe identity + presence (not specific counts/details).
        // Specific counts drift across runs (one extra console error doesn't
        // mean a different finding); presence is what matters for identity.
        any_violations:
          typeof (p.summary as { violations?: number } | undefined)?.violations === 'number' &&
          ((p.summary as { violations?: number }).violations ?? 0) > 0,
        any_errors:
          typeof (p.summary as { error_count?: number } | undefined)?.error_count === 'number' &&
          ((p.summary as { error_count?: number }).error_count ?? 0) > 0,
        any_failures:
          typeof (p.summary as { failure_count?: number } | undefined)?.failure_count ===
            'number' && ((p.summary as { failure_count?: number }).failure_count ?? 0) > 0,
      });
    case 'observation': {
      // Hash the first 120 chars of the summary, whitespace-normalized.
      const summary = ((p.summary as string) ?? '').replace(/\s+/g, ' ').trim();
      return JSON.stringify({ summary: summary.slice(0, 120) });
    }
    case 'tentative_finding':
      return JSON.stringify({
        title: ((p.title as string) ?? '').toLowerCase().replace(/\s+/g, ' ').trim(),
        category: p.category,
      });
    case 'goal_status':
      return JSON.stringify({ id: p.id, status: p.status });
    case 'preflight':
      return JSON.stringify({
        ok: p.ok,
        checks: Array.isArray(p.checks)
          ? (p.checks as Array<{ name: string; ok: boolean }>).map((c) => ({
              name: c.name,
              ok: c.ok,
            }))
          : [],
      });
    case 'evidence':
      return JSON.stringify({ kind: p.kind ?? 'screenshot' });
    case 'hypothesis':
      return JSON.stringify({
        claim: ((p.claim as string) ?? '').toLowerCase().slice(0, 80),
      });
    case 'budget_abort':
      return JSON.stringify({ reason: p.reason });
    default:
      // For run_start / run_end / etc, hash on kind alone — these are
      // structural markers, not content.
      return JSON.stringify({ kind: event.kind });
  }
}

export function eventContentHash(event: TraceEvent): string {
  return sha1Short(`${event.kind}|${event.actor}|${canonicalPayload(event)}`);
}

// ---------------------------------------------------------------------------
// Finding hash — stable identity for a finding across runs of the same app.
// Collapses adjacent severities into buckets so Judge waffling between
// nit/minor or major/blocker doesn't churn identity.
// ---------------------------------------------------------------------------

const SEV_BUCKET: Record<string, string> = {
  blocker: 'high',
  major: 'high',
  minor: 'med',
  nit: 'low',
  suggestion: 'low',
};

function normalizeTitle(t: string): string {
  return t
    .toLowerCase()
    .replace(/^[\s\d.)#]+/, '')
    .replace(/\s+/g, ' ')
    .trim();
}

export function findingHash(
  finding: Pick<JudgeFinding, 'title' | 'category' | 'severity' | 'evidence'>,
  eventIndex: Map<string, { content_hash?: string }>,
): string {
  const evHashes = finding.evidence
    .map((id) => eventIndex.get(id)?.content_hash ?? `unknown:${id}`)
    .sort();
  return sha1Short(
    `${normalizeTitle(finding.title)}|${finding.category}|${
      SEV_BUCKET[finding.severity] ?? finding.severity
    }|${evHashes.join(',')}`,
  );
}
