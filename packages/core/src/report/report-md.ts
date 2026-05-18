import { deriveReportEvaluationForReport } from './evaluation.js';
import type { ReportJson } from './report-json.js';

export function buildReportMd(report: ReportJson): string {
  const evaluation = report.evaluation ?? deriveReportEvaluationForReport(report);
  const passEmoji =
    report.headline.threshold_passed && evaluation.product_score.authority === 'authoritative'
      ? '✅'
      : report.headline.threshold_passed
        ? '⚠'
        : '❌';
  const lines: string[] = [];

  lines.push(
    `# Iris run — ${evaluation.product_score.label}: ${report.headline.score} / 10  ${passEmoji}`,
  );
  lines.push('');
  const runMeta = [
    `**Target:** ${report.run.target.url}`,
    ...(report.run.transport ? [`**Transport:** ${report.run.transport}`] : []),
    `**Mode:** ${report.run.mode}`,
    `**Duration:** ${formatDuration(report.run.duration_s)}`,
    ...(report.run.cost_usd > 0.005 ? [`**Cost:** $${report.run.cost_usd.toFixed(2)}`] : []),
  ];
  lines.push(runMeta.join('  •  '));
  lines.push(
    `**Models:** discovery ${report.run.models.discovery ?? report.run.models.explorer} (${effortLabel(report.run.reasoning_efforts?.discovery)})  •  explorer ${report.run.models.explorer} (${effortLabel(report.run.reasoning_efforts?.explorer)})  •  judge ${report.run.models.judge} (${effortLabel(report.run.reasoning_efforts?.judge)})`,
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
  lines.push(
    `**Evidence confidence:** ${evaluation.evidence_confidence.level} (${Math.round(evaluation.evidence_confidence.score * 100)}%) — ${mdCell(evaluation.product_score.interpretation)}`,
  );
  if (evaluation.evidence_confidence.reasons.length > 0) {
    lines.push(`**Why:** ${mdCell(evaluation.evidence_confidence.reasons.slice(0, 4).join('; '))}`);
  }
  if (evaluation.capability_coverage) {
    const coverage = evaluation.capability_coverage;
    lines.push(
      `**Important capabilities covered:** ${coverage.important_covered}/${coverage.important_total}  •  **Important skipped:** ${coverage.important_skipped}`,
    );
    if (coverage.scope_limits.length > 0) {
      lines.push(
        `**Scope limits:** ${mdCell(
          coverage.scope_limits
            .slice(0, 4)
            .map((limit) => `${limit.label}: ${limit.reason}`)
            .join('; '),
        )}`,
      );
    }
  }
  if (report.testing_plan) {
    const plan = report.testing_plan;
    const primaryJourney =
      plan.journeys.find((journey) => journey.id === plan.primary_journey_id) ?? plan.journeys[0];
    const successSignals = [...new Set(plan.journeys.map((journey) => journey.success_state))]
      .filter(Boolean)
      .join('; ');
    lines.push(
      `**Overall mission:** ${mdCell(plan.overall_mission || plan.main_outcome || primaryJourney?.user_goal || plan.product_summary || 'not recorded')}`,
    );
    if (plan.journeys.length > 0) {
      lines.push('**User journeys checked:**');
      for (const journey of plan.journeys) {
        lines.push(
          `- ${mdCell(journey.id)}: ${mdCell(journey.title)} (${journey.scenario_ids.length} scenario${journey.scenario_ids.length === 1 ? '' : 's'})`,
        );
      }
    }
    if (successSignals) {
      lines.push(`**Success criteria:** ${mdCell(successSignals)}`);
    }
    if (plan.scenarios.length > 0) {
      lines.push('**Tested scenarios:**');
      for (const scenario of plan.scenarios) {
        const brief = scenario.scenario_brief ? ` Brief: ${mdCell(scenario.scenario_brief)}.` : '';
        const testData =
          scenario.test_data.length > 0 ? ` Use: ${mdCell(scenario.test_data.join('; '))}.` : '';
        const actions =
          scenario.actions.length > 0 ? ` Actions: ${mdCell(scenario.actions.join('; '))}.` : '';
        const requiredOutputs =
          scenario.required_outputs.length > 0
            ? ` Expected output: ${mdCell(scenario.required_outputs.join('; '))}.`
            : ` Expected result: ${mdCell(scenario.expected_result)}.`;
        const quality =
          scenario.quality_bar.length > 0
            ? ` Quality bar: ${mdCell(scenario.quality_bar.join('; '))}.`
            : '';
        const mergedChecks =
          (scenario.source_goal_ids?.length ?? 0) > 1
            ? ` Checks: ${mdCell(scenario.source_goal_ids?.join(', ') ?? '')}.`
            : '';
        lines.push(
          `- ${mdCell(scenario.id)}: ${mdCell(scenario.title)}.${brief}${mergedChecks}${testData}${actions}${requiredOutputs}${quality}`,
        );
      }
    }
    if (plan.deferred.length > 0) {
      lines.push('**Deferred areas:**');
      for (const area of plan.deferred) {
        lines.push(`- ${mdCell(area.title)}: ${mdCell(area.reason)}`);
      }
    }
  }
  lines.push('');

  if (report.spec_compliance.applicable && report.spec_compliance.goals.length > 0) {
    const sat = report.spec_compliance.goals.filter(
      (g) => g.status === 'satisfied' || g.status === 'verified',
    ).length;
    lines.push(`## Scenario checks — ${sat} / ${report.spec_compliance.goals.length}`);
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
    const gcv = report.spec_compliance.goal_claim_validation;
    if (
      gcv &&
      gcv.verified_kept + (gcv.partial_upgraded ?? 0) + (gcv.partial_kept ?? 0) + gcv.downgraded > 0
    ) {
      const parts: string[] = [];
      if (gcv.verified_kept > 0) parts.push(`${gcv.verified_kept} verified kept`);
      if ((gcv.partial_upgraded ?? 0) > 0) parts.push(`${gcv.partial_upgraded} partial upgraded`);
      if ((gcv.partial_kept ?? 0) > 0) parts.push(`${gcv.partial_kept} partial kept`);
      if (gcv.downgraded > 0) parts.push(`${gcv.downgraded} downgraded`);
      lines.push(`- Evidence audit: ${parts.join(', ')}`);
      for (const reason of [...(gcv.downgrade_reasons ?? []), ...(gcv.partial_reasons ?? [])].slice(
        0,
        3,
      )) {
        lines.push(`  - ${mdCell(reason)}`);
      }
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

  const otherFindings = report.findings
    .filter((f) => f.severity !== 'blocker' && f.severity !== 'major')
    .sort((a, b) => severityRank(a.severity) - severityRank(b.severity));
  if (otherFindings.length > 0) {
    lines.push(
      `## Other findings (${report.headline.minors} minor, ${report.headline.nits} nit${report.headline.nits === 1 ? '' : 's'}, ${report.headline.suggestions} suggestion${report.headline.suggestions === 1 ? '' : 's'})`,
    );
    for (const f of otherFindings) {
      lines.push(`- **${f.id} [${f.severity}]** ${f.title}`);
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

function effortLabel(effort: string | undefined): string {
  return `effort ${effort ?? 'not recorded'}`;
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

function severityRank(severity: string): number {
  const order: Record<string, number> = { minor: 0, nit: 1, suggestion: 2 };
  return order[severity] ?? 99;
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
