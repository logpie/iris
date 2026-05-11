import type { DiffResult } from './diff.js';

function escapeMd(s: string): string {
  return s.replace(/\|/g, '\\|');
}

function severitySign(sev: string): string {
  switch (sev) {
    case 'blocker':
      return '!!';
    case 'major':
      return '! ';
    case 'minor':
      return '. ';
    case 'nit':
      return '. ';
    case 'suggestion':
      return '? ';
    default:
      return '  ';
  }
}

export function buildDiffMd(diff: DiffResult): string {
  const lines: string[] = [];
  lines.push(`# Iris diff: ${diff.prev.run_id} → ${diff.curr.run_id}`);
  lines.push('');
  lines.push(`Target: ${diff.curr.target}`);
  lines.push('');
  lines.push(
    `Score: ${diff.prev.score.toFixed(1)} → ${diff.curr.score.toFixed(1)} (${
      diff.score_delta.overall >= 0 ? '+' : ''
    }${diff.score_delta.overall.toFixed(1)})`,
  );
  lines.push('');
  lines.push(
    `Findings: ${diff.findings.fixed.length} fixed, ${diff.findings.new.length} new, ${diff.findings.persistent.length} persistent.`,
  );
  lines.push('');

  if (diff.findings.fixed.length > 0) {
    lines.push('## Fixed');
    for (const f of diff.findings.fixed) {
      lines.push(
        `- ${severitySign(f.severity)}${escapeMd(f.title)} (${f.category}, ${f.severity})`,
      );
    }
    lines.push('');
  }
  if (diff.findings.new.length > 0) {
    lines.push('## New');
    for (const f of diff.findings.new) {
      lines.push(
        `- ${severitySign(f.severity)}${escapeMd(f.title)} (${f.category}, ${f.severity})`,
      );
    }
    lines.push('');
  }
  if (diff.findings.persistent.length > 0) {
    lines.push('## Persistent');
    for (const f of diff.findings.persistent) {
      lines.push(
        `- ${severitySign(f.severity)}${escapeMd(f.title)} (${f.category}, ${f.severity})`,
      );
    }
    lines.push('');
  }

  const cov = diff.coverage_delta;
  if (
    cov.newly_tested_goals.length > 0 ||
    cov.no_longer_tested.length > 0 ||
    cov.verification_changes.length > 0
  ) {
    lines.push('## Coverage delta');
    if (cov.newly_tested_goals.length > 0)
      lines.push(`- Newly tested: ${cov.newly_tested_goals.join(', ')}`);
    if (cov.no_longer_tested.length > 0)
      lines.push(`- No longer tested: ${cov.no_longer_tested.join(', ')}`);
    for (const c of cov.verification_changes) {
      lines.push(`- ${c.id}: ${c.prev} → ${c.curr}`);
    }
    lines.push('');
  }

  return lines.join('\n');
}
