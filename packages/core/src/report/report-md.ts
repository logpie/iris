import type { ReportJson } from './report-json.js';

export function buildReportMd(report: ReportJson): string {
  const passEmoji = report.headline.threshold_passed ? '✅' : '❌';
  const lines: string[] = [];

  lines.push(`# Iris run — ${report.headline.score} / 10  ${passEmoji}`);
  lines.push('');
  lines.push(
    `**Target:** ${report.run.target.url}  •  **Mode:** ${report.run.mode}  •  **Duration:** ${formatDuration(report.run.duration_s)}  •  **Cost:** $${report.run.cost_usd.toFixed(2)}`,
  );
  if (report.run.usage?.total) {
    const usage = report.run.usage.total;
    const nonCached =
      usage.non_cached_input_tokens ??
      Math.max(0, usage.input_tokens - (usage.cached_input_tokens ?? 0));
    const cached = usage.cached_input_tokens ?? 0;
    lines.push(
      `**Tokens:** input ${usage.input_tokens.toLocaleString()}  •  cached ${cached.toLocaleString()}  •  non-cached ${nonCached.toLocaleString()}  •  output ${usage.output_tokens.toLocaleString()}`,
    );
  }
  lines.push('');

  if (report.spec_compliance.applicable && report.spec_compliance.goals.length > 0) {
    const sat = report.spec_compliance.goals.filter(
      (g) => g.status === 'satisfied' || g.status === 'verified',
    ).length;
    lines.push(`## Spec compliance — ${sat} / ${report.spec_compliance.goals.length}`);
    for (const g of report.spec_compliance.goals) {
      const icon =
        g.status === 'satisfied' || g.status === 'verified'
          ? '✅'
          : g.status === 'partial'
            ? '🟡'
            : '❌';
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
    lines.push(`| ${mdCell(name)} | ${profileScoreLabel(profile)} |`);
  }
  for (const name of missingWeightedProfiles(report)) {
    lines.push(`| ${mdCell(name)} | missing |`);
  }
  lines.push('');

  lines.push('## Score matrix');
  lines.push('| Profile | Dimension | Score | Rationale |');
  lines.push('|---|---|---|---|');
  for (const [profileName, profile] of Object.entries(report.scores.profiles)) {
    const dimensions = Object.entries(profile.dimensions);
    if (dimensions.length === 0) {
      lines.push(
        `| ${mdCell(profileName)} | (profile) | ${profileScoreLabel(profile)} | No dimension scores returned. |`,
      );
      continue;
    }
    for (const [dimensionName, dimension] of dimensions) {
      lines.push(
        `| ${mdCell(profileName)} | ${mdCell(dimensionName)} | ${formatScore(dimension.score)} | ${mdCell(truncate(dimension.rationale))} |`,
      );
    }
  }
  for (const name of missingWeightedProfiles(report)) {
    lines.push(
      `| ${mdCell(name)} | (profile) | missing | Listed in weighted_from but absent from scores.profiles. |`,
    );
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

function missingWeightedProfiles(report: ReportJson): string[] {
  const present = new Set(Object.keys(report.scores.profiles));
  return report.scores.overall.weighted_from.filter((name) => !present.has(name));
}

function profileScoreLabel(profile: ReportJson['scores']['profiles'][string]): string {
  const dimensions = Object.values(profile.dimensions);
  if (dimensions.length > 0 && dimensions.every((dimension) => dimension.score === null)) {
    return 'n/a';
  }
  return formatScore(profile.score);
}

function formatScore(score: number | null): string {
  if (score === null || !Number.isFinite(score)) return 'n/a';
  return Number.isInteger(score) ? String(score) : score.toFixed(1).replace(/\.0$/, '');
}

function mdCell(value: string): string {
  return value.replace(/\|/g, '\\|').replace(/\r?\n/g, ' ').trim();
}

function truncate(value: string, maxLength = 180): string {
  if (value.length <= maxLength) return value;
  return `${value.slice(0, maxLength - 3).trimEnd()}...`;
}
