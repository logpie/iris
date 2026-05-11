import type { JudgeFinding } from '../judge/judge.js';
import type { DiffResult } from './diff.js';

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

const STYLES = `
  body {
    margin: 0;
    background: #ffffff;
    color: #1f2328;
    font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", system-ui, sans-serif;
    font-size: 15px;
    line-height: 1.55;
  }
  main { max-width: 760px; margin: 0 auto; padding: 32px 24px 80px; }
  h1 { font-size: 22px; font-weight: 600; margin: 0 0 4px; }
  h2 { font-size: 16px; font-weight: 600; margin: 32px 0 12px; }
  .meta { font-family: ui-monospace, SFMono-Regular, Menlo, monospace; font-size: 12px; color: #57606a; margin-bottom: 16px; }
  .summary {
    border-left: 3px solid #d1d9e0;
    padding: 12px 16px;
    background: #f6f8fa;
    margin: 16px 0 24px;
  }
  .summary p { margin: 0; }
  .delta-pos { color: #1a7f37; font-weight: 600; }
  .delta-neg { color: #cf222e; font-weight: 600; }
  .delta-zero { color: #57606a; }
  .findings-list { list-style: none; padding-left: 0; }
  .findings-list > li { padding: 12px 0; border-top: 1px solid #eaeef2; }
  .findings-list > li:first-child { border-top: none; }
  .sev-tag {
    font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
    font-size: 11px;
    text-transform: uppercase;
    letter-spacing: 0.05em;
    margin-right: 8px;
  }
  .sev-blocker { color: #cf222e; }
  .sev-major { color: #bf3989; }
  .sev-minor { color: #9a6700; }
  .sev-nit { color: #57606a; }
  .sev-suggestion { color: #1f6feb; }
  .fixed-section { border-left: 3px solid #1a7f37; padding-left: 16px; }
  .new-section { border-left: 3px solid #cf222e; padding-left: 16px; }
  .persistent-section { border-left: 3px solid #d1d9e0; padding-left: 16px; }
  .coverage-list { list-style: none; padding-left: 0; }
  .coverage-list li { padding: 4px 0; font-family: ui-monospace, SFMono-Regular, Menlo, monospace; font-size: 13px; }
  .empty { color: #8b949e; font-style: italic; }
`;

function deltaClass(delta: number): string {
  if (delta > 0.05) return 'delta-pos';
  if (delta < -0.05) return 'delta-neg';
  return 'delta-zero';
}

function deltaSign(delta: number): string {
  if (delta >= 0) return `+${delta.toFixed(1)}`;
  return delta.toFixed(1);
}

function renderFinding(f: JudgeFinding): string {
  return `<li>
    <span class="sev-tag sev-${escapeHtml(f.severity)}">${escapeHtml(f.severity)}</span>
    <span class="cat">${escapeHtml(f.category)}</span>
    — ${escapeHtml(f.title)}
  </li>`;
}

export function buildDiffHtml(diff: DiffResult): string {
  const overall = diff.score_delta.overall;
  const profileLines = Object.entries(diff.score_delta.by_profile)
    .map(
      ([k, v]) =>
        `<li>${escapeHtml(k)}: <span class="${deltaClass(v)}">${deltaSign(v)}</span></li>`,
    )
    .join('');
  const cov = diff.coverage_delta;
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Iris diff — ${escapeHtml(diff.curr.target)}</title>
<style>${STYLES}</style>
</head>
<body>
<main>
  <h1>Diff: ${escapeHtml(diff.prev.run_id)} → ${escapeHtml(diff.curr.run_id)}</h1>
  <p class="meta">${escapeHtml(diff.curr.target)}</p>

  <section class="summary">
    <p>Score: ${diff.prev.score.toFixed(1)} → ${diff.curr.score.toFixed(1)} <span class="${deltaClass(overall)}">(${deltaSign(overall)})</span></p>
    <p>Findings: <strong>${diff.findings.fixed.length}</strong> fixed, <strong>${diff.findings.new.length}</strong> new, <strong>${diff.findings.persistent.length}</strong> persistent.</p>
    ${profileLines ? `<p>By profile:</p><ul>${profileLines}</ul>` : ''}
  </section>

  <section class="fixed-section">
    <h2>Fixed (${diff.findings.fixed.length})</h2>
    ${
      diff.findings.fixed.length === 0
        ? '<p class="empty">No findings resolved between runs.</p>'
        : `<ul class="findings-list">${diff.findings.fixed.map(renderFinding).join('')}</ul>`
    }
  </section>

  <section class="new-section">
    <h2>New (${diff.findings.new.length})</h2>
    ${
      diff.findings.new.length === 0
        ? '<p class="empty">No new findings.</p>'
        : `<ul class="findings-list">${diff.findings.new.map(renderFinding).join('')}</ul>`
    }
  </section>

  <section class="persistent-section">
    <h2>Persistent (${diff.findings.persistent.length})</h2>
    ${
      diff.findings.persistent.length === 0
        ? '<p class="empty">No persistent findings.</p>'
        : `<ul class="findings-list">${diff.findings.persistent.map(renderFinding).join('')}</ul>`
    }
  </section>

  ${
    cov.newly_tested_goals.length + cov.no_longer_tested.length + cov.verification_changes.length >
    0
      ? `<section>
    <h2>Coverage delta</h2>
    <ul class="coverage-list">
      ${cov.newly_tested_goals.map((id) => `<li class="delta-pos">+ ${escapeHtml(id)} newly tested</li>`).join('')}
      ${cov.no_longer_tested.map((id) => `<li class="delta-neg">- ${escapeHtml(id)} no longer tested</li>`).join('')}
      ${cov.verification_changes
        .map((c) => `<li>${escapeHtml(c.id)}: ${escapeHtml(c.prev)} → ${escapeHtml(c.curr)}</li>`)
        .join('')}
    </ul>
  </section>`
      : ''
  }
</main>
</body>
</html>`;
}
