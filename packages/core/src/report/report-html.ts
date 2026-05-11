import type { JudgeOutput } from '../judge/judge.js';
import type { ReportJson } from './report-json.js';

/**
 * Renders a self-contained HTML report. Designed to be opened from `file://`
 * with no external assets other than Tailwind via CDN. Visual goals:
 *   - Hero at a glance — score, pass/fail, duration, cost, findings counts
 *   - Per-rubric score bars
 *   - Spec compliance with per-goal status pills
 *   - Findings as cards grouped by severity, with category icons + evidence pills
 *   - Caveats and meta in a footer band so they're visible but not dominating
 */
export function buildReportHtml(report: ReportJson): string {
  const passed = report.headline.threshold_passed;
  const score = report.headline.score;
  const arc = scoreArc(score); // 0..10 → SVG arc

  const findingsBySeverity = groupFindings(report.findings);
  const findingsHtml = renderFindings(findingsBySeverity);
  const profileScoresHtml = renderProfileScores(report.scores);
  const specHtml = renderSpecCompliance(report.spec_compliance);
  const caveatsHtml = renderCaveats(report.meta.confidence_caveats);
  const reExploreHtml = renderReExplore(report.meta.would_re_explore_with);
  const coverageHtml = renderCoverage(report.coverage_review);
  const nextActionsHtml = renderNextActions(report.next_actions);

  return `<!doctype html>
<html lang="en" class="bg-slate-50">
<head>
<meta charset="utf-8">
<title>Iris report — ${escapeHtml(report.run.target.url)}</title>
<meta name="viewport" content="width=device-width, initial-scale=1">
<script src="https://cdn.tailwindcss.com"></script>
<style>
  :root { color-scheme: light; }
  body { font-family: ui-sans-serif, system-ui, -apple-system, "Segoe UI", Roboto, sans-serif; }
  .truncate-2 {
    display: -webkit-box;
    -webkit-line-clamp: 2;
    -webkit-box-orient: vertical;
    overflow: hidden;
  }
  details > summary { list-style: none; cursor: pointer; }
  details > summary::-webkit-details-marker { display: none; }
  details[open] .chev { transform: rotate(90deg); }
  .chev { transition: transform 120ms ease; }
  @media print {
    .no-print { display: none !important; }
    body { background: white; }
  }
</style>
</head>
<body class="min-h-screen text-slate-900">
<div class="max-w-5xl mx-auto px-4 py-8 sm:py-12">

  <!-- Header -->
  <header class="flex items-center justify-between mb-6">
    <div class="flex items-center gap-3">
      <div class="w-9 h-9 rounded-lg bg-gradient-to-br from-violet-500 to-fuchsia-500 flex items-center justify-center text-white font-bold text-lg">I</div>
      <div>
        <div class="font-semibold text-lg leading-none">Iris</div>
        <div class="text-xs text-slate-500 mt-0.5">Autonomous product evaluator</div>
      </div>
    </div>
    <div class="text-right text-xs text-slate-500">
      <div class="font-mono">${escapeHtml(report.run.id)}</div>
      <div>${escapeHtml(new Date(report.run.started_at).toLocaleString())}</div>
    </div>
  </header>

  <!-- Hero -->
  <section class="rounded-2xl border ${passed ? 'border-emerald-200 bg-gradient-to-br from-emerald-50 to-white' : 'border-rose-200 bg-gradient-to-br from-rose-50 to-white'} shadow-sm p-6 sm:p-8 mb-6">
    <div class="flex flex-col sm:flex-row sm:items-center gap-6">
      <!-- Score arc -->
      <div class="relative w-32 h-32 flex-shrink-0">
        <svg viewBox="0 0 120 120" class="w-32 h-32">
          <circle cx="60" cy="60" r="50" fill="none" stroke="#e2e8f0" stroke-width="10"/>
          <circle cx="60" cy="60" r="50" fill="none" stroke="${passed ? '#10b981' : '#f43f5e'}"
            stroke-width="10" stroke-linecap="round"
            stroke-dasharray="${arc.dash}" stroke-dashoffset="0"
            transform="rotate(-90 60 60)"/>
        </svg>
        <div class="absolute inset-0 flex flex-col items-center justify-center">
          <div class="text-4xl font-bold tabular-nums">${score.toFixed(1)}</div>
          <div class="text-xs text-slate-500">/ 10</div>
        </div>
      </div>
      <!-- Summary -->
      <div class="flex-1 min-w-0">
        <div class="flex items-center gap-2 mb-2 flex-wrap">
          <span class="inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-xs font-medium ${passed ? 'bg-emerald-100 text-emerald-800' : 'bg-rose-100 text-rose-800'}">
            ${passed ? '✓ Passed' : '✗ Failed'} threshold
          </span>
          <span class="text-xs text-slate-500">${escapeHtml(report.run.mode)} mode · ${escapeHtml(report.run.target.kind)}</span>
        </div>
        <a href="${escapeHtml(report.run.target.url)}" target="_blank" rel="noopener" class="block font-mono text-sm text-slate-700 hover:text-violet-600 truncate-2 break-all leading-snug mb-3">
          ${escapeHtml(report.run.target.url)}
        </a>
        <div class="grid grid-cols-2 sm:grid-cols-5 gap-3 text-sm">
          ${stat('Duration', formatDuration(report.run.duration_s))}
          ${stat('Cost', `$${report.run.cost_usd.toFixed(2)}`)}
          ${stat('Steps', String(report.run.step_count))}
          ${stat('Findings', String(report.findings.length))}
          ${stat('Confidence', `${Math.round(report.meta.confidence_overall * 100)}%`)}
        </div>
      </div>
    </div>

    <!-- Severity ribbon -->
    <div class="mt-6 flex flex-wrap gap-2 text-sm">
      ${sevPill('🚨', 'Blocker', report.headline.blockers, 'rose')}
      ${sevPill('⚠', 'Major', report.headline.majors, 'amber')}
      ${sevPill('●', 'Minor', report.headline.minors, 'yellow')}
      ${sevPill('·', 'Nit', report.headline.nits, 'lime')}
      ${sevPill('💡', 'Suggestion', report.headline.suggestions, 'sky')}
    </div>
  </section>

  ${specHtml}

  <!-- Scores card -->
  <section class="rounded-2xl border border-slate-200 bg-white shadow-sm p-6 mb-6">
    <h2 class="text-base font-semibold text-slate-800 mb-4 flex items-center gap-2">
      <span class="text-slate-400">📊</span> Rubric scores
    </h2>
    <div class="space-y-4">
      ${profileScoresHtml || '<p class="text-sm text-slate-500">No profiles scored.</p>'}
    </div>
  </section>

  <!-- Findings -->
  <section class="mb-6">
    <div class="flex items-baseline justify-between mb-4">
      <h2 class="text-base font-semibold text-slate-800 flex items-center gap-2">
        <span class="text-slate-400">🔍</span> Findings (${report.findings.length})
      </h2>
      <div class="text-xs text-slate-500 no-print">Click a finding to expand details</div>
    </div>
    ${findingsHtml || '<div class="rounded-2xl border border-slate-200 bg-white p-6 text-sm text-slate-500">No findings recorded.</div>'}
  </section>

  ${coverageHtml}
  ${nextActionsHtml}

  <!-- Caveats + re-explore -->
  ${
    caveatsHtml || reExploreHtml
      ? `<section class="rounded-2xl border border-amber-200 bg-amber-50 p-5 mb-6">
    <h2 class="text-sm font-semibold text-amber-900 flex items-center gap-2 mb-3">⚠ Confidence caveats</h2>
    ${caveatsHtml}
    ${reExploreHtml}
  </section>`
      : ''
  }

  <!-- Footer -->
  <footer class="text-xs text-slate-500 flex flex-wrap items-center gap-x-4 gap-y-1 pt-6 border-t border-slate-200">
    <span>Iris v${escapeHtml(report.tool.version)}</span>
    <span class="opacity-50">·</span>
    <span>Explorer: ${escapeHtml(report.run.models.explorer)}</span>
    <span class="opacity-50">·</span>
    <span>Judge: ${escapeHtml(report.run.models.judge)}</span>
    <span class="opacity-50">·</span>
    <span>${escapeHtml(report.run.termination)}</span>
  </footer>

</div>
</body>
</html>`;
}

function scoreArc(score: number): { dash: string } {
  const circumference = 2 * Math.PI * 50; // ≈ 314.16
  const filled = (Math.max(0, Math.min(10, score)) / 10) * circumference;
  return { dash: `${filled.toFixed(2)} ${(circumference - filled).toFixed(2)}` };
}

function stat(label: string, value: string): string {
  return `<div>
    <div class="text-xs uppercase tracking-wide text-slate-500">${escapeHtml(label)}</div>
    <div class="font-semibold text-slate-900 tabular-nums">${escapeHtml(value)}</div>
  </div>`;
}

function sevPill(
  icon: string,
  label: string,
  count: number,
  color: 'rose' | 'amber' | 'yellow' | 'lime' | 'sky',
): string {
  const colorMap = {
    rose:
      count > 0
        ? 'bg-rose-100 text-rose-800 border-rose-200'
        : 'bg-slate-100 text-slate-500 border-slate-200',
    amber:
      count > 0
        ? 'bg-amber-100 text-amber-800 border-amber-200'
        : 'bg-slate-100 text-slate-500 border-slate-200',
    yellow:
      count > 0
        ? 'bg-yellow-100 text-yellow-800 border-yellow-200'
        : 'bg-slate-100 text-slate-500 border-slate-200',
    lime:
      count > 0
        ? 'bg-lime-100 text-lime-800 border-lime-200'
        : 'bg-slate-100 text-slate-500 border-slate-200',
    sky:
      count > 0
        ? 'bg-sky-100 text-sky-800 border-sky-200'
        : 'bg-slate-100 text-slate-500 border-slate-200',
  };
  return `<span class="inline-flex items-center gap-1.5 px-2.5 py-1 rounded-full border ${colorMap[color]}">
    <span>${icon}</span>
    <span class="tabular-nums font-medium">${count}</span>
    <span class="text-xs">${escapeHtml(label)}</span>
  </span>`;
}

function formatDuration(s: number): string {
  if (s < 60) return `${s.toFixed(0)}s`;
  const m = Math.floor(s / 60);
  const sec = Math.round(s % 60);
  return `${m}m ${sec}s`;
}

// --- Per-profile score bars ---

function renderProfileScores(scores: JudgeOutput['scores']): string {
  return Object.entries(scores.profiles)
    .map(([name, p]) => {
      const dimHtml = Object.entries(p.dimensions)
        .map(([dimId, d]) => {
          return `<div class="grid grid-cols-12 items-center gap-3 text-xs">
            <div class="col-span-3 sm:col-span-2 text-slate-500 truncate" title="${escapeHtml(dimId)}">${escapeHtml(dimId)}</div>
            <div class="col-span-7 sm:col-span-8 bg-slate-100 rounded-full h-1.5 overflow-hidden">
              <div class="h-full rounded-full ${scoreColor(d.score)}" style="width: ${Math.max(0, Math.min(10, d.score)) * 10}%"></div>
            </div>
            <div class="col-span-2 text-right tabular-nums font-medium text-slate-700">${d.score.toFixed(1)}</div>
          </div>`;
        })
        .join('');
      return `<details class="border border-slate-200 rounded-lg overflow-hidden" open>
        <summary class="flex items-center justify-between gap-4 px-4 py-3 bg-slate-50/50 hover:bg-slate-50">
          <div class="flex items-center gap-2 min-w-0 flex-1">
            <span class="chev text-slate-400 text-xs">▸</span>
            <span class="font-medium text-slate-800 capitalize">${escapeHtml(name.replace(/_/g, ' '))}</span>
            <span class="text-xs text-slate-500">(${Object.keys(p.dimensions).length} dimensions)</span>
          </div>
          <div class="flex items-center gap-3">
            <div class="w-24 sm:w-32 bg-slate-200 rounded-full h-2 overflow-hidden">
              <div class="h-full rounded-full ${scoreColor(p.score)}" style="width: ${Math.max(0, Math.min(10, p.score)) * 10}%"></div>
            </div>
            <span class="font-semibold tabular-nums text-slate-900 w-10 text-right">${p.score.toFixed(1)}</span>
          </div>
        </summary>
        <div class="px-4 py-3 space-y-2 bg-white">
          ${dimHtml}
        </div>
      </details>`;
    })
    .join('');
}

function scoreColor(score: number): string {
  if (score >= 7.5) return 'bg-emerald-500';
  if (score >= 5) return 'bg-amber-400';
  if (score >= 3) return 'bg-orange-500';
  return 'bg-rose-500';
}

// --- Spec compliance ---

function renderSpecCompliance(spec: JudgeOutput['spec_compliance']): string {
  if (!spec.applicable || spec.goals.length === 0) return '';
  const satisfied = spec.goals.filter((g) => g.status === 'satisfied').length;
  const partial = spec.goals.filter((g) => g.status === 'partial').length;
  const notSat = spec.goals.filter((g) => g.status === 'not_satisfied').length;
  const total = spec.goals.length;

  const goalHtml = spec.goals
    .map((g) => {
      const icon = g.status === 'satisfied' ? '✓' : g.status === 'partial' ? '◐' : '✗';
      const color =
        g.status === 'satisfied'
          ? 'text-emerald-700 bg-emerald-50 border-emerald-200'
          : g.status === 'partial'
            ? 'text-amber-700 bg-amber-50 border-amber-200'
            : 'text-rose-700 bg-rose-50 border-rose-200';
      return `<div class="border-l-2 ${color.replace('text-', 'border-').split(' ')[0]} pl-4 py-2">
        <div class="flex items-center gap-2">
          <span class="inline-flex items-center justify-center w-5 h-5 rounded-full text-xs font-bold ${color}">${icon}</span>
          <span class="text-xs font-mono text-slate-500">${escapeHtml(g.id)}</span>
          <span class="text-xs text-slate-500 capitalize">${escapeHtml(g.status.replace('_', ' '))}</span>
        </div>
        <div class="mt-1 text-sm text-slate-800">${escapeHtml(g.description)}</div>
        ${g.notes ? `<div class="mt-1 text-xs text-slate-500 italic">${escapeHtml(g.notes)}</div>` : ''}
        ${g.evidence.length > 0 ? `<div class="mt-1 flex flex-wrap gap-1">${g.evidence.map((e) => `<code class="px-1.5 py-0.5 bg-slate-100 text-slate-600 rounded text-xs">${escapeHtml(e)}</code>`).join('')}</div>` : ''}
      </div>`;
    })
    .join('');

  return `<section class="rounded-2xl border border-slate-200 bg-white shadow-sm p-6 mb-6">
    <div class="flex items-baseline justify-between mb-4">
      <h2 class="text-base font-semibold text-slate-800 flex items-center gap-2">
        <span class="text-slate-400">📋</span> Spec compliance
      </h2>
      <div class="text-sm font-medium tabular-nums">
        <span class="text-emerald-700">${satisfied}</span> / <span class="text-slate-500">${total}</span> satisfied
        ${partial > 0 ? ` · <span class="text-amber-700">${partial} partial</span>` : ''}
        ${notSat > 0 ? ` · <span class="text-rose-700">${notSat} failing</span>` : ''}
      </div>
    </div>
    <div class="mb-4 h-2 rounded-full bg-slate-100 overflow-hidden flex">
      <div class="bg-emerald-500 h-full" style="width: ${(satisfied / total) * 100}%"></div>
      <div class="bg-amber-400 h-full" style="width: ${(partial / total) * 100}%"></div>
      <div class="bg-rose-500 h-full" style="width: ${(notSat / total) * 100}%"></div>
    </div>
    <div class="space-y-1">
      ${goalHtml}
    </div>
    ${spec.summary ? `<p class="mt-4 text-sm text-slate-600 italic">${escapeHtml(spec.summary)}</p>` : ''}
  </section>`;
}

// --- Findings ---

function groupFindings(findings: JudgeOutput['findings']): Record<string, JudgeOutput['findings']> {
  const order = ['blocker', 'major', 'minor', 'nit', 'suggestion'];
  const groups: Record<string, JudgeOutput['findings']> = {};
  for (const sev of order) groups[sev] = [];
  for (const f of findings) {
    if (!groups[f.severity]) groups[f.severity] = [];
    (groups[f.severity] as JudgeOutput['findings']).push(f);
  }
  return groups;
}

function renderFindings(grouped: Record<string, JudgeOutput['findings']>): string {
  const order = ['blocker', 'major', 'minor', 'nit', 'suggestion'];
  return order
    .map((sev) => {
      const items = grouped[sev] ?? [];
      if (items.length === 0) return '';
      return items.map(renderFindingCard).join('');
    })
    .filter(Boolean)
    .join('');
}

function renderFindingCard(f: JudgeOutput['findings'][number]): string {
  const sevStyle = severityStyles(f.severity);
  const catIcon = categoryIcon(f.category);

  return `<details class="rounded-xl border ${sevStyle.border} bg-white shadow-sm mb-3 overflow-hidden">
    <summary class="px-5 py-4 flex items-start gap-3 hover:bg-slate-50/50">
      <span class="chev text-slate-400 text-xs mt-1.5">▸</span>
      <div class="flex-1 min-w-0">
        <div class="flex items-center flex-wrap gap-2 mb-1">
          <span class="inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-xs font-medium border ${sevStyle.pill}">${sevStyle.icon} ${escapeHtml(f.severity)}</span>
          <span class="inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-xs font-medium bg-slate-100 text-slate-700 border border-slate-200">${catIcon} ${escapeHtml(f.category)}</span>
          <code class="text-xs text-slate-500">${escapeHtml(f.id)}</code>
        </div>
        <div class="font-semibold text-slate-900 leading-snug">${escapeHtml(f.title)}</div>
      </div>
    </summary>
    <div class="px-5 pb-5 pt-1 border-t border-slate-100">
      <div class="prose prose-sm max-w-none text-slate-700 mb-3">
        ${escapeHtml(f.rationale).replace(/\n/g, '<br>')}
      </div>
      ${f.where ? renderWhere(f.where) : ''}
      ${
        f.suggested_fix
          ? `<div class="mt-3 rounded-lg bg-violet-50 border border-violet-100 px-4 py-3">
        <div class="text-xs uppercase tracking-wide text-violet-700 font-medium mb-1">Suggested fix · ${escapeHtml(f.suggested_fix.type)}</div>
        <div class="text-sm text-slate-800">${escapeHtml(f.suggested_fix.summary)}</div>
      </div>`
          : ''
      }
      ${
        f.evidence.length > 0
          ? `<div class="mt-3">
        <div class="text-xs uppercase tracking-wide text-slate-500 font-medium mb-1.5">Evidence</div>
        <div class="flex flex-wrap gap-1.5">
          ${f.evidence.map((e) => `<code class="px-2 py-1 bg-slate-100 hover:bg-slate-200 text-slate-700 rounded text-xs font-mono">${escapeHtml(e)}</code>`).join('')}
        </div>
      </div>`
          : ''
      }
    </div>
  </details>`;
}

function renderWhere(where: { url?: string | undefined; selector?: string | undefined }): string {
  const parts: string[] = [];
  if (where.url)
    parts.push(
      `<code class="px-2 py-0.5 bg-slate-100 text-slate-700 rounded text-xs">${escapeHtml(where.url)}</code>`,
    );
  if (where.selector)
    parts.push(
      `<code class="px-2 py-0.5 bg-slate-100 text-slate-700 rounded text-xs">${escapeHtml(where.selector)}</code>`,
    );
  if (parts.length === 0) return '';
  return `<div class="text-xs text-slate-500 mb-2 flex flex-wrap items-center gap-2">
    <span class="uppercase tracking-wide font-medium">Where:</span>${parts.join('')}
  </div>`;
}

function severityStyles(sev: string): { border: string; pill: string; icon: string } {
  switch (sev) {
    case 'blocker':
      return {
        border: 'border-rose-300',
        pill: 'bg-rose-100 text-rose-800 border-rose-200',
        icon: '🚨',
      };
    case 'major':
      return {
        border: 'border-amber-300',
        pill: 'bg-amber-100 text-amber-800 border-amber-200',
        icon: '⚠',
      };
    case 'minor':
      return {
        border: 'border-yellow-300',
        pill: 'bg-yellow-100 text-yellow-800 border-yellow-200',
        icon: '●',
      };
    case 'nit':
      return {
        border: 'border-lime-300',
        pill: 'bg-lime-100 text-lime-800 border-lime-200',
        icon: '·',
      };
    case 'suggestion':
      return {
        border: 'border-sky-300',
        pill: 'bg-sky-100 text-sky-800 border-sky-200',
        icon: '💡',
      };
    default:
      return {
        border: 'border-slate-200',
        pill: 'bg-slate-100 text-slate-700 border-slate-200',
        icon: '•',
      };
  }
}

function categoryIcon(cat: string): string {
  switch (cat) {
    case 'bug':
      return '🐛';
    case 'a11y':
      return '♿';
    case 'ux':
      return '🧭';
    case 'perf':
      return '⚡';
    case 'copy':
      return '✍';
    case 'suggestion':
      return '💡';
    default:
      return '•';
  }
}

// --- Coverage ---

function renderCoverage(coverage: JudgeOutput['coverage_review']): string {
  const total = coverage.surfaces_explored + coverage.surfaces_unexplored;
  const pct = total === 0 ? 0 : (coverage.surfaces_explored / total) * 100;
  return `<section class="rounded-2xl border border-slate-200 bg-white shadow-sm p-6 mb-6">
    <h2 class="text-base font-semibold text-slate-800 flex items-center gap-2 mb-4">
      <span class="text-slate-400">🗺</span> Coverage
    </h2>
    <div class="flex items-center gap-4 mb-3 text-sm">
      <div><span class="font-semibold tabular-nums">${coverage.surfaces_explored}</span> <span class="text-slate-500">explored</span></div>
      <div class="text-slate-300">·</div>
      <div><span class="font-semibold tabular-nums">${coverage.surfaces_unexplored}</span> <span class="text-slate-500">unexplored</span></div>
      <div class="text-slate-300">·</div>
      <div class="text-slate-500">${pct.toFixed(0)}% breadth</div>
    </div>
    <div class="h-2 rounded-full bg-slate-100 overflow-hidden mb-3">
      <div class="h-full bg-violet-500 rounded-full" style="width: ${pct}%"></div>
    </div>
    <p class="text-sm text-slate-600 italic">${escapeHtml(coverage.judgement)}</p>
  </section>`;
}

// --- Next actions ---

function renderNextActions(next: ReportJson['next_actions']): string {
  if (!next || (next.for_builder.length === 0 && next.for_re_evaluation.length === 0)) return '';
  const builderHtml =
    next.for_builder.length > 0
      ? `<div class="mb-4">
    <div class="text-xs uppercase tracking-wide text-slate-500 font-medium mb-2">For the builder agent (prioritized fix list)</div>
    <ol class="space-y-1 list-none">
      ${next.for_builder
        .map(
          (a) => `<li class="flex gap-3 text-sm py-1.5">
        <span class="flex-shrink-0 w-6 h-6 rounded-full bg-violet-100 text-violet-700 font-semibold text-xs flex items-center justify-center tabular-nums">${a.fix_priority}</span>
        <span class="flex-1"><code class="text-xs text-slate-500 mr-2">${escapeHtml(a.finding_id)}</code>${escapeHtml(a.summary)}</span>
      </li>`,
        )
        .join('')}
    </ol>
  </div>`
      : '';
  return `<section class="rounded-2xl border border-violet-200 bg-violet-50/50 p-6 mb-6">
    <h2 class="text-base font-semibold text-slate-800 flex items-center gap-2 mb-4">
      <span class="text-slate-400">→</span> Next actions
    </h2>
    ${builderHtml}
  </section>`;
}

// --- Caveats + re-explore ---

function renderCaveats(caveats: string[]): string {
  if (caveats.length === 0) return '';
  return `<ul class="space-y-1.5 text-sm text-amber-900">
    ${caveats.map((c) => `<li class="flex gap-2"><span class="text-amber-500 flex-shrink-0">•</span><span>${escapeHtml(c)}</span></li>`).join('')}
  </ul>`;
}

function renderReExplore(suggestions: string[]): string {
  if (suggestions.length === 0) return '';
  return `<div class="mt-4 pt-4 border-t border-amber-200">
    <div class="text-xs uppercase tracking-wide text-amber-700 font-medium mb-2">Try re-running with</div>
    <div class="flex flex-wrap gap-1.5">
      ${suggestions.map((s) => `<code class="px-2 py-1 bg-white border border-amber-200 text-amber-900 rounded text-xs font-mono">${escapeHtml(s)}</code>`).join('')}
    </div>
  </div>`;
}

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}
