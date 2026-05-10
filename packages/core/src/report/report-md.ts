import type { ReportJson } from './report-json.js';

export function buildReportMd(report: ReportJson): string {
  const passEmoji = report.headline.threshold_passed ? '✅' : '❌';
  const lines: string[] = [];

  lines.push(`# Iris run — ${report.headline.score} / 10  ${passEmoji}`);
  lines.push('');
  lines.push(
    `**Target:** ${report.run.target.url}  •  **Mode:** ${report.run.mode}  •  **Duration:** ${formatDuration(report.run.duration_s)}  •  **Cost:** $${report.run.cost_usd.toFixed(2)}`,
  );
  lines.push('');

  if (report.spec_compliance.applicable && report.spec_compliance.goals.length > 0) {
    const sat = report.spec_compliance.goals.filter((g) => g.status === 'satisfied').length;
    lines.push(`## Spec compliance — ${sat} / ${report.spec_compliance.goals.length}`);
    for (const g of report.spec_compliance.goals) {
      const icon = g.status === 'satisfied' ? '✅' : g.status === 'partial' ? '🟡' : '❌';
      const notes = g.notes ? ` *(${g.notes})*` : '';
      lines.push(`- ${icon} ${g.id}: ${g.description}${notes}`);
    }
    lines.push('');
  }

  const topFindings = report.findings
    .filter((f) => f.severity === 'blocker' || f.severity === 'major')
    .slice(0, 10);
  if (topFindings.length > 0) {
    lines.push(
      `## Top findings (${report.headline.blockers} blocker${report.headline.blockers === 1 ? '' : 's'}, ${report.headline.majors} major)`,
    );
    for (const f of topFindings) {
      const icon = f.severity === 'blocker' ? '🚨' : '⚠';
      lines.push(`- ${icon} **${f.id} [${f.severity}]** ${f.title}`);
    }
    lines.push('');
  }

  lines.push('## Scores');
  lines.push('| Profile | Score |');
  lines.push('|---|---|');
  for (const [name, profile] of Object.entries(report.scores.profiles)) {
    lines.push(`| ${name} | ${profile.score} |`);
  }
  lines.push('');

  if (report.meta.confidence_caveats.length > 0) {
    lines.push('## Caveats');
    for (const c of report.meta.confidence_caveats) lines.push(`- ${c}`);
    lines.push('');
  }

  return lines.join('\n');
}

function formatDuration(s: number): string {
  const m = Math.floor(s / 60);
  const sec = Math.floor(s % 60);
  return `${m}m ${sec}s`;
}
