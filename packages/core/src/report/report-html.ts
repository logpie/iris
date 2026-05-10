import type { ReportJson } from './report-json.js';

export function buildReportHtml(report: ReportJson): string {
  const passClass = report.headline.threshold_passed ? 'pass' : 'fail';
  const findingsHtml = report.findings
    .map(
      (f) => `
    <div class="finding sev-${f.severity}">
      <div class="finding-header">
        <span class="finding-id">${escapeHtml(f.id)}</span>
        <span class="finding-sev">${escapeHtml(f.severity)}</span>
        <span class="finding-cat">${escapeHtml(f.category)}</span>
      </div>
      <div class="finding-title">${escapeHtml(f.title)}</div>
      <div class="finding-rationale">${escapeHtml(f.rationale)}</div>
      ${f.where ? `<div class="finding-where">${escapeHtml(f.where.url ?? '')} ${escapeHtml(f.where.selector ?? '')}</div>` : ''}
      ${f.suggested_fix ? `<div class="finding-fix"><strong>Suggested fix:</strong> ${escapeHtml(f.suggested_fix.summary)}</div>` : ''}
      <div class="finding-evidence">Evidence: ${f.evidence.map(escapeHtml).join(', ')}</div>
    </div>`,
    )
    .join('\n');

  const scoresHtml = Object.entries(report.scores.profiles)
    .map(
      ([name, p]) =>
        `<div class="profile-score"><strong>${escapeHtml(name)}</strong>: ${p.score}</div>`,
    )
    .join('\n');

  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <title>Iris report — ${escapeHtml(report.run.target.url)}</title>
  <script src="https://cdn.tailwindcss.com"></script>
  <style>
    body { font-family: ui-sans-serif, system-ui, sans-serif; max-width: 1100px; margin: 2rem auto; padding: 0 1rem; }
    .headline { display: flex; gap: 2rem; align-items: center; padding: 1.5rem; border-radius: 0.5rem; }
    .headline.pass { background: #ecfdf5; }
    .headline.fail { background: #fef2f2; }
    .headline-score { font-size: 3rem; font-weight: bold; }
    .finding { border: 1px solid #e5e7eb; padding: 1rem; margin: 0.5rem 0; border-radius: 0.5rem; }
    .finding.sev-blocker { border-left: 4px solid #dc2626; }
    .finding.sev-major { border-left: 4px solid #ea580c; }
    .finding.sev-minor { border-left: 4px solid #ca8a04; }
    .finding.sev-nit { border-left: 4px solid #65a30d; }
    .finding.sev-suggestion { border-left: 4px solid #2563eb; }
    .finding-header { display: flex; gap: 0.5rem; font-size: 0.85rem; color: #6b7280; }
    .finding-title { font-weight: 600; margin: 0.25rem 0; }
    .finding-rationale { color: #374151; }
    .finding-where, .finding-fix, .finding-evidence { font-size: 0.85rem; color: #6b7280; margin-top: 0.25rem; }
    .profile-score { padding: 0.25rem 0.75rem; border: 1px solid #e5e7eb; border-radius: 0.25rem; display: inline-block; margin: 0.25rem; }
  </style>
</head>
<body>
  <h1>Iris report</h1>
  <div class="headline ${passClass}">
    <div class="headline-score">${report.headline.score}</div>
    <div>
      <div><strong>Target:</strong> ${escapeHtml(report.run.target.url)}</div>
      <div><strong>Mode:</strong> ${escapeHtml(report.run.mode)}  •  <strong>Duration:</strong> ${report.run.duration_s.toFixed(0)}s  •  <strong>Cost:</strong> $${report.run.cost_usd.toFixed(2)}</div>
      <div>Findings: ${report.headline.blockers} blocker / ${report.headline.majors} major / ${report.headline.minors} minor / ${report.headline.nits} nit / ${report.headline.suggestions} suggestion</div>
    </div>
  </div>

  <h2>Scores</h2>
  <div class="scores">${scoresHtml}</div>

  <h2>Findings</h2>
  ${findingsHtml || '<p>No findings.</p>'}

  ${report.meta.confidence_caveats.length > 0 ? `<h2>Caveats</h2><ul>${report.meta.confidence_caveats.map((c) => `<li>${escapeHtml(c)}</li>`).join('')}</ul>` : ''}
</body>
</html>`;
}

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}
