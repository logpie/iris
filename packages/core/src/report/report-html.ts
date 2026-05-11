import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { type basename, join, type relative } from 'node:path';
import type { JudgeOutput } from '../judge/judge.js';
import type { TraceEvent } from '../trace/schema.js';
import type { ReportJson } from './report-json.js';

/**
 * Renders a self-contained HTML report. Designed to be opened from `file://`
 * with no external assets other than Tailwind via CDN.
 *
 * When `opts.runDir` is provided, the report becomes much richer:
 *   - Reads trace.jsonl and renders a Trace section at the bottom
 *   - Evidence chips become anchor links to specific trace events
 *   - Each trace event card shows the matching screenshot if available
 *   - Embeds the full-run video (.webm) if present in evidence/videos
 *   - Inlines screenshot keyframes for observation events
 */

export interface BuildReportHtmlOptions {
  /** Run directory; if provided, the report reads trace.jsonl + finds screenshots/videos */
  runDir?: string;
}

interface ScreenshotIndex {
  /** observation_ref (e.g. "OBS-000001") → relative path under runDir */
  byObservationRef: Map<string, string>;
  /** trace event id → relative path (best-effort: matches observation events whose payload.ref maps) */
  byEventId: Map<string, string>;
}

interface RunData {
  events: TraceEvent[];
  screenshots: ScreenshotIndex;
  videoRelPath: string | null;
}

export function buildReportHtml(report: ReportJson, opts: BuildReportHtmlOptions = {}): string {
  const runData = opts.runDir ? loadRunData(opts.runDir) : null;
  const eventIndex = runData ? new Map(runData.events.map((e) => [e.id, e])) : new Map();
  const screenshotForEvent = runData?.screenshots.byEventId ?? new Map<string, string>();

  const score = report.headline.score;
  const arc = scoreArc(score);

  const findingsBySeverity = groupFindings(report.findings);
  const findingsHtml = renderFindings(findingsBySeverity, eventIndex, screenshotForEvent);
  const profileScoresHtml = renderProfileScores(report.scores, eventIndex);
  const specHtml = renderSpecCompliance(report.spec_compliance, eventIndex);
  const caveatsHtml = renderCaveats(report.meta.confidence_caveats);
  const reExploreHtml = renderReExplore(report.meta.would_re_explore_with);
  const coverageHtml = renderCoverage(report.coverage_review);
  const nextActionsHtml = renderNextActions(report.next_actions);
  const videoHtml = runData?.videoRelPath
    ? renderVideo(runData.videoRelPath, report.run.duration_s)
    : '';
  const traceSectionHtml = runData ? renderTraceSection(runData, report) : '';

  const thresholdPill = renderThresholdPill(report);

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
  /* Smooth-scroll for evidence anchor links */
  html { scroll-behavior: smooth; scroll-padding-top: 1rem; }
  /* Highlight the trace event being linked to */
  :target {
    background-color: rgb(254 249 195); /* yellow-100 */
    transition: background-color 800ms ease;
  }
  /* Evidence chip: clickable when href is present */
  a.evidence-chip {
    text-decoration: none;
  }
  a.evidence-chip:hover {
    background-color: rgb(226 232 240); /* slate-200 */
  }
  @media print {
    .no-print { display: none !important; }
    body { background: white; }
    details { open: true; }
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
  <section class="rounded-2xl border ${heroBandClasses(report)} shadow-sm p-6 sm:p-8 mb-6">
    <div class="flex flex-col sm:flex-row sm:items-center gap-6">
      <div class="relative w-32 h-32 flex-shrink-0">
        <svg viewBox="0 0 120 120" class="w-32 h-32">
          <circle cx="60" cy="60" r="50" fill="none" stroke="#e2e8f0" stroke-width="10"/>
          <circle cx="60" cy="60" r="50" fill="none" stroke="${arcStroke(report)}"
            stroke-width="10" stroke-linecap="round"
            stroke-dasharray="${arc.dash}" stroke-dashoffset="0"
            transform="rotate(-90 60 60)"/>
        </svg>
        <div class="absolute inset-0 flex flex-col items-center justify-center">
          <div class="text-4xl font-bold tabular-nums">${score.toFixed(1)}</div>
          <div class="text-xs text-slate-500">/ 10</div>
        </div>
      </div>
      <div class="flex-1 min-w-0">
        <div class="flex items-center gap-2 mb-2 flex-wrap">
          ${thresholdPill}
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

    <div class="mt-6 flex flex-wrap gap-2 text-sm">
      ${sevPill('🚨', 'Blocker', report.headline.blockers, 'rose')}
      ${sevPill('⚠', 'Major', report.headline.majors, 'amber')}
      ${sevPill('●', 'Minor', report.headline.minors, 'yellow')}
      ${sevPill('·', 'Nit', report.headline.nits, 'lime')}
      ${sevPill('💡', 'Suggestion', report.headline.suggestions, 'sky')}
    </div>
  </section>

  ${videoHtml}

  ${specHtml}

  <section class="rounded-2xl border border-slate-200 bg-white shadow-sm p-6 mb-6">
    <h2 class="text-base font-semibold text-slate-800 mb-4 flex items-center gap-2">
      <span class="text-slate-400">📊</span> Rubric scores
    </h2>
    <div class="space-y-4">
      ${profileScoresHtml || '<p class="text-sm text-slate-500">No profiles scored.</p>'}
    </div>
  </section>

  <section class="mb-6">
    <div class="flex items-baseline justify-between mb-4">
      <h2 class="text-base font-semibold text-slate-800 flex items-center gap-2">
        <span class="text-slate-400">🔍</span> Findings (${report.findings.length})
      </h2>
      <div class="text-xs text-slate-500 no-print">Click a finding to expand · evidence chips jump to trace events</div>
    </div>
    ${findingsHtml || '<div class="rounded-2xl border border-slate-200 bg-white p-6 text-sm text-slate-500">No findings recorded.</div>'}
  </section>

  ${coverageHtml}
  ${nextActionsHtml}

  ${
    caveatsHtml || reExploreHtml
      ? `<section class="rounded-2xl border border-amber-200 bg-amber-50 p-5 mb-6">
    <h2 class="text-sm font-semibold text-amber-900 flex items-center gap-2 mb-3">⚠ Confidence caveats</h2>
    ${caveatsHtml}
    ${reExploreHtml}
  </section>`
      : ''
  }

  ${traceSectionHtml}

  <footer class="text-xs text-slate-500 flex flex-wrap items-center gap-x-4 gap-y-1 pt-6 border-t border-slate-200">
    <span>Iris v${escapeHtml(report.tool.version)}</span>
    <span class="opacity-50">·</span>
    <span>Explorer: ${escapeHtml(report.run.models.explorer)}</span>
    <span class="opacity-50">·</span>
    <span>Judge: ${escapeHtml(report.run.models.judge)}</span>
    <span class="opacity-50">·</span>
    <span>Termination: ${escapeHtml(report.run.termination)}</span>
  </footer>

</div>
</body>
</html>`;
}

// --- Run data loading (trace + screenshots + video) ---

function loadRunData(runDir: string): RunData | null {
  const tracePath = join(runDir, 'trace.jsonl');
  if (!existsSync(tracePath)) return null;
  let events: TraceEvent[];
  try {
    const text = readFileSync(tracePath, 'utf8');
    events = text
      .split('\n')
      .filter((line) => line.trim().length > 0)
      .map((line) => JSON.parse(line) as TraceEvent);
  } catch {
    return null;
  }

  const screenshotsDir = join(runDir, 'evidence', 'screenshots');
  const byObservationRef = new Map<string, string>();
  const byEventId = new Map<string, string>();
  if (existsSync(screenshotsDir)) {
    const files = readdirSync(screenshotsDir).filter((f) => f.endsWith('.png'));
    // Build map from observation_ref ("OBS-000001") → "step-0001.png"
    for (const f of files) {
      // Match patterns like step-0001.png or step-0001-NNN.png
      const m = f.match(/^step-(\d+)/);
      if (!m || !m[1]) continue;
      const n = Number.parseInt(m[1], 10);
      // Observation refs use "OBS-" + 6-digit-padded number
      const obsRef = `OBS-${String(n).padStart(6, '0')}`;
      // Only set if not already (prefer the canonical "step-NNNN.png" over the timestamped variants)
      if (f === `step-${m[1]}.png` || !byObservationRef.has(obsRef)) {
        byObservationRef.set(obsRef, `evidence/screenshots/${f}`);
      }
    }
    // Now map trace event IDs → screenshot, by matching observation events to their refs
    for (const e of events) {
      if (e.kind === 'observation' && typeof e.payload?.ref === 'string') {
        const path = byObservationRef.get(e.payload.ref as string);
        if (path) byEventId.set(e.id, path);
      }
    }
  }

  // Find a video file (Playwright auto-names them)
  const videosDir = join(runDir, 'evidence', 'videos');
  let videoRelPath: string | null = null;
  if (existsSync(videosDir)) {
    const webms = readdirSync(videosDir).filter((f) => f.endsWith('.webm'));
    if (webms.length > 0) {
      webms.sort();
      videoRelPath = `evidence/videos/${webms[webms.length - 1]}`;
    }
  }

  return {
    events,
    screenshots: { byObservationRef, byEventId },
    videoRelPath,
  };
}

// --- Hero helpers ---

function heroBandClasses(report: ReportJson): string {
  // Three states: no threshold (neutral), passed (green), failed (rose)
  if (!hasThreshold(report)) return 'border-slate-200 bg-gradient-to-br from-slate-50 to-white';
  return report.headline.threshold_passed
    ? 'border-emerald-200 bg-gradient-to-br from-emerald-50 to-white'
    : 'border-rose-200 bg-gradient-to-br from-rose-50 to-white';
}

function arcStroke(report: ReportJson): string {
  if (!hasThreshold(report)) {
    // Neutral arc colored by score
    if (report.headline.score >= 7.5) return '#10b981';
    if (report.headline.score >= 5) return '#f59e0b';
    return '#f43f5e';
  }
  return report.headline.threshold_passed ? '#10b981' : '#f43f5e';
}

function renderThresholdPill(report: ReportJson): string {
  if (!hasThreshold(report)) {
    return `<span class="inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-xs font-medium bg-slate-100 text-slate-600 border border-slate-200">No threshold set</span>`;
  }
  const passed = report.headline.threshold_passed;
  return `<span class="inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-xs font-medium ${passed ? 'bg-emerald-100 text-emerald-800 border border-emerald-200' : 'bg-rose-100 text-rose-800 border border-rose-200'}">
    ${passed ? '✓ Passed' : '✗ Failed'} threshold
  </span>`;
}

function hasThreshold(report: ReportJson): boolean {
  // The ReportJson schema doesn't record the threshold value separately, but we can
  // infer: if threshold_passed is true and the failure-state-looking score is high, threshold was set.
  // The cleaner signal: look at config.json which is sibling to report.json, but we don't have it here.
  // Heuristic: if score < 7 AND threshold_passed === true, no threshold was applied
  // (because Orchestrator defaults threshold_passed to true when threshold is undefined).
  // This is imperfect; a better fix is to store threshold in report.json. For now:
  return report.headline.threshold_passed === false || report.headline.score >= 7;
}

function scoreArc(score: number): { dash: string } {
  const circumference = 2 * Math.PI * 50;
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

// --- Video ---

function renderVideo(relPath: string, durationS: number): string {
  return `<section class="rounded-2xl border border-slate-200 bg-white shadow-sm p-6 mb-6">
    <h2 class="text-base font-semibold text-slate-800 mb-3 flex items-center gap-2">
      <span class="text-slate-400">🎬</span> Full-run video
      <span class="ml-auto text-xs font-normal text-slate-500">${formatDuration(durationS)}</span>
    </h2>
    <video controls preload="metadata" class="w-full rounded-lg bg-slate-900 max-h-[420px]" src="${escapeAttr(relPath)}">
      Your browser doesn't support video playback. <a href="${escapeAttr(relPath)}">Download the recording</a>.
    </video>
  </section>`;
}

// --- Profile score bars ---

function renderProfileScores(
  scores: JudgeOutput['scores'],
  eventIndex: Map<string, TraceEvent>,
): string {
  return Object.entries(scores.profiles)
    .map(([name, p]) => {
      const dimHtml = Object.entries(p.dimensions)
        .map(([dimId, d]) => {
          return `<div class="grid grid-cols-12 items-start gap-3 text-xs py-1">
            <div class="col-span-3 sm:col-span-2 text-slate-500 truncate" title="${escapeHtml(dimId)}">${escapeHtml(dimId)}</div>
            <div class="col-span-7 sm:col-span-8">
              <div class="bg-slate-100 rounded-full h-1.5 overflow-hidden mb-1">
                <div class="h-full rounded-full ${scoreColor(d.score)}" style="width: ${Math.max(0, Math.min(10, d.score)) * 10}%"></div>
              </div>
              <div class="text-slate-600 leading-snug">${escapeHtml(d.rationale)}</div>
              ${d.evidence.length > 0 ? `<div class="mt-1 flex flex-wrap gap-1">${d.evidence.map((id) => renderEvidenceChip(id, eventIndex)).join('')}</div>` : ''}
            </div>
            <div class="col-span-2 text-right tabular-nums font-medium text-slate-700">${d.score.toFixed(1)}</div>
          </div>`;
        })
        .join('');
      return `<details class="border border-slate-200 rounded-lg overflow-hidden">
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
        <div class="px-4 py-3 space-y-3 bg-white">
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

function renderSpecCompliance(
  spec: JudgeOutput['spec_compliance'],
  eventIndex: Map<string, TraceEvent>,
): string {
  if (!spec.applicable || spec.goals.length === 0) return '';
  const satisfied = spec.goals.filter((g) => g.status === 'satisfied').length;
  const partial = spec.goals.filter((g) => g.status === 'partial').length;
  const notSat = spec.goals.filter((g) => g.status === 'not_satisfied').length;
  const total = spec.goals.length;

  const goalHtml = spec.goals
    .map((g) => {
      const icon = g.status === 'satisfied' ? '✓' : g.status === 'partial' ? '◐' : '✗';
      const borderColor =
        g.status === 'satisfied'
          ? 'border-emerald-300'
          : g.status === 'partial'
            ? 'border-amber-300'
            : 'border-rose-300';
      const badgeColor =
        g.status === 'satisfied'
          ? 'bg-emerald-100 text-emerald-800'
          : g.status === 'partial'
            ? 'bg-amber-100 text-amber-800'
            : 'bg-rose-100 text-rose-800';
      return `<div class="border-l-2 ${borderColor} pl-4 py-2">
        <div class="flex items-center gap-2">
          <span class="inline-flex items-center justify-center w-5 h-5 rounded-full text-xs font-bold ${badgeColor}">${icon}</span>
          <span class="text-xs font-mono text-slate-500">${escapeHtml(g.id)}</span>
          <span class="text-xs text-slate-500 capitalize">${escapeHtml(g.status.replace('_', ' '))}</span>
        </div>
        <div class="mt-1 text-sm text-slate-800">${escapeHtml(g.description)}</div>
        ${g.notes ? `<div class="mt-1 text-xs text-slate-500 italic">${escapeHtml(g.notes)}</div>` : ''}
        ${g.evidence.length > 0 ? `<div class="mt-1 flex flex-wrap gap-1">${g.evidence.map((e) => renderEvidenceChip(e, eventIndex)).join('')}</div>` : ''}
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

function renderFindings(
  grouped: Record<string, JudgeOutput['findings']>,
  eventIndex: Map<string, TraceEvent>,
  screenshotForEvent: Map<string, string>,
): string {
  const order = ['blocker', 'major', 'minor', 'nit', 'suggestion'];
  return order
    .map((sev) => {
      const items = grouped[sev] ?? [];
      if (items.length === 0) return '';
      return items.map((f) => renderFindingCard(f, eventIndex, screenshotForEvent)).join('');
    })
    .filter(Boolean)
    .join('');
}

function renderFindingCard(
  f: JudgeOutput['findings'][number],
  eventIndex: Map<string, TraceEvent>,
  screenshotForEvent: Map<string, string>,
): string {
  const sevStyle = severityStyles(f.severity);
  const catIcon = categoryIcon(f.category);

  // Find a screenshot to show inline: pick the first evidence id that has one
  let inlineScreenshot = '';
  for (const eid of f.evidence) {
    const path = screenshotForEvent.get(eid);
    if (path) {
      inlineScreenshot = `<div class="mt-3 rounded-lg border border-slate-200 overflow-hidden bg-slate-50">
        <a href="${escapeAttr(path)}" target="_blank" rel="noopener" title="Open full-size">
          <img src="${escapeAttr(path)}" alt="Evidence screenshot" class="w-full max-h-96 object-contain bg-white" loading="lazy">
        </a>
        <div class="px-3 py-1.5 text-xs text-slate-500 flex justify-between items-center">
          <span>Screenshot at <code>${escapeHtml(eid)}</code></span>
          <a href="${escapeAttr(path)}" target="_blank" rel="noopener" class="text-violet-600 hover:underline">Open full size →</a>
        </div>
      </div>`;
      break;
    }
  }

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
      <div class="text-sm text-slate-700 mb-3 whitespace-pre-line">${escapeHtml(f.rationale)}</div>
      ${f.where ? renderWhere(f.where) : ''}
      ${
        f.suggested_fix
          ? `<div class="mt-3 rounded-lg bg-violet-50 border border-violet-100 px-4 py-3">
        <div class="text-xs uppercase tracking-wide text-violet-700 font-medium mb-1">Suggested fix · ${escapeHtml(f.suggested_fix.type)}</div>
        <div class="text-sm text-slate-800">${escapeHtml(f.suggested_fix.summary)}</div>
      </div>`
          : ''
      }
      ${inlineScreenshot}
      ${
        f.evidence.length > 0
          ? `<div class="mt-3">
        <div class="text-xs uppercase tracking-wide text-slate-500 font-medium mb-1.5">Evidence (click to jump to trace event)</div>
        <div class="flex flex-wrap gap-1.5">
          ${f.evidence.map((e) => renderEvidenceChip(e, eventIndex)).join('')}
        </div>
      </div>`
          : ''
      }
    </div>
  </details>`;
}

function renderEvidenceChip(eventId: string, eventIndex: Map<string, TraceEvent>): string {
  const event = eventIndex.get(eventId);
  if (event) {
    return `<a href="#evt-${escapeAttr(eventId)}" class="evidence-chip px-2 py-1 bg-slate-100 text-slate-700 rounded text-xs font-mono inline-flex items-center gap-1" title="Jump to ${event.kind} event">
      <span class="opacity-50">${escapeHtml(traceKindLabel(event.kind))}</span>
      <span>${escapeHtml(eventId.slice(-8))}</span>
    </a>`;
  }
  // Event not in trace (could be a screenshot OBS-ref, etc.) — render as inert
  return `<code class="px-2 py-1 bg-slate-100 text-slate-600 rounded text-xs font-mono">${escapeHtml(eventId)}</code>`;
}

function traceKindLabel(kind: string): string {
  switch (kind) {
    case 'observation':
      return '👁';
    case 'action':
      return '→';
    case 'action_result':
      return '←';
    case 'probe_call':
      return '?';
    case 'probe_result':
      return '!';
    case 'tentative_finding':
      return '⚠';
    default:
      return '·';
  }
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

// --- Trace section ---

function renderTraceSection(runData: RunData, _report: ReportJson): string {
  if (runData.events.length === 0) return '';
  const eventsHtml = runData.events.map((e) => renderTraceEvent(e, runData)).join('');
  return `<section class="rounded-2xl border border-slate-200 bg-white shadow-sm p-6 mb-6">
    <h2 class="text-base font-semibold text-slate-800 flex items-center gap-2 mb-1">
      <span class="text-slate-400">📜</span> Trace
      <span class="ml-auto text-xs font-normal text-slate-500">${runData.events.length} events</span>
    </h2>
    <p class="text-xs text-slate-500 mb-4">Every action, observation, and finding the Explorer recorded. Evidence chips in findings link here.</p>
    <div class="space-y-1">
      ${eventsHtml}
    </div>
  </section>`;
}

function renderTraceEvent(e: TraceEvent, runData: RunData): string {
  const kindStyle = traceEventStyle(e.kind);
  const screenshot = runData.screenshots.byEventId.get(e.id);
  const summary = traceEventSummary(e);
  const payloadStr = JSON.stringify(e.payload, null, 2);
  return `<details id="evt-${escapeAttr(e.id)}" class="border ${kindStyle.border} rounded-md overflow-hidden">
    <summary class="px-3 py-2 flex items-center gap-3 hover:bg-slate-50 ${kindStyle.bg}">
      <span class="chev text-slate-400 text-xs">▸</span>
      <span class="text-xs text-slate-500 font-mono w-12 text-right tabular-nums">step ${e.step}</span>
      <span class="inline-flex items-center gap-1 px-1.5 py-0.5 rounded text-xs font-medium ${kindStyle.pill} flex-shrink-0">${kindStyle.icon} ${escapeHtml(e.kind)}</span>
      <span class="text-xs text-slate-600 flex-1 truncate">${escapeHtml(summary)}</span>
      <code class="text-[10px] text-slate-400 font-mono flex-shrink-0">${escapeHtml(e.id.slice(-8))}</code>
    </summary>
    <div class="px-3 py-3 bg-white border-t border-slate-100 space-y-2">
      <div class="text-xs text-slate-500">
        <span class="uppercase tracking-wide font-medium">Actor:</span> ${escapeHtml(e.actor)}
        <span class="mx-2 opacity-40">·</span>
        <span class="uppercase tracking-wide font-medium">Time:</span> ${escapeHtml(new Date(e.ts * 1000).toLocaleTimeString())}
        <span class="mx-2 opacity-40">·</span>
        <code class="font-mono">${escapeHtml(e.id)}</code>
      </div>
      ${
        screenshot
          ? `<div class="rounded border border-slate-200 overflow-hidden bg-slate-50">
        <a href="${escapeAttr(screenshot)}" target="_blank" rel="noopener">
          <img src="${escapeAttr(screenshot)}" alt="Screenshot at this step" class="w-full max-h-64 object-contain bg-white" loading="lazy">
        </a>
      </div>`
          : ''
      }
      <details>
        <summary class="text-xs text-slate-500 cursor-pointer hover:text-slate-700">Payload</summary>
        <pre class="mt-1 text-xs bg-slate-50 p-2 rounded overflow-x-auto text-slate-700"><code>${escapeHtml(payloadStr)}</code></pre>
      </details>
    </div>
  </details>`;
}

function traceEventStyle(kind: string): { border: string; bg: string; pill: string; icon: string } {
  switch (kind) {
    case 'run_start':
    case 'run_end':
      return {
        border: 'border-slate-200',
        bg: 'bg-slate-50',
        pill: 'bg-slate-200 text-slate-700',
        icon: '◉',
      };
    case 'observation':
      return { border: 'border-slate-200', bg: '', pill: 'bg-sky-100 text-sky-800', icon: '👁' };
    case 'action':
      return {
        border: 'border-slate-200',
        bg: '',
        pill: 'bg-violet-100 text-violet-800',
        icon: '→',
      };
    case 'action_result':
      return { border: 'border-slate-200', bg: '', pill: 'bg-slate-100 text-slate-700', icon: '←' };
    case 'probe_call':
    case 'probe_result':
      return {
        border: 'border-slate-200',
        bg: '',
        pill: 'bg-emerald-100 text-emerald-800',
        icon: '?',
      };
    case 'tentative_finding':
      return {
        border: 'border-amber-200',
        bg: 'bg-amber-50/30',
        pill: 'bg-amber-100 text-amber-800',
        icon: '⚠',
      };
    case 'give_up':
    case 'budget_abort':
      return {
        border: 'border-rose-200',
        bg: 'bg-rose-50/30',
        pill: 'bg-rose-100 text-rose-800',
        icon: '✗',
      };
    case 'done':
      return {
        border: 'border-emerald-200',
        bg: 'bg-emerald-50/30',
        pill: 'bg-emerald-100 text-emerald-800',
        icon: '✓',
      };
    default:
      return { border: 'border-slate-200', bg: '', pill: 'bg-slate-100 text-slate-700', icon: '·' };
  }
}

function traceEventSummary(e: TraceEvent): string {
  const p = e.payload as Record<string, unknown>;
  switch (e.kind) {
    case 'observation': {
      const summary = String(p.summary ?? '')
        .slice(0, 120)
        .replace(/\n/g, ' · ');
      return `${String(p.ref ?? '')} — ${summary}`;
    }
    case 'action':
      return `${String(p.tool ?? '')}(${JSON.stringify(p.args ?? {}).slice(0, 80)})`;
    case 'action_result':
      return `${String(p.tool ?? '')} ${p.ok ? 'ok' : `err: ${String(p.error ?? '').slice(0, 60)}`}`;
    case 'probe_call':
      return String(p.probe ?? '');
    case 'probe_result':
      return `${String(p.probe ?? '')} ${JSON.stringify(p.summary ?? {}).slice(0, 80)}`;
    case 'tentative_finding':
      return `${String(p.severity_hint ?? '')}/${String(p.category ?? '')}: ${String(p.title ?? '').slice(0, 80)}`;
    case 'give_up':
      return String(p.reason ?? '');
    case 'run_start':
    case 'run_end':
    case 'done':
    case 'budget_abort':
      return JSON.stringify(p).slice(0, 100);
    default:
      return JSON.stringify(p).slice(0, 80);
  }
}

// --- Escaping ---

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function escapeAttr(s: string): string {
  return escapeHtml(s);
}

// Suppress unused-import lint complaints for re-exported types
export type _ = { rel: typeof relative; b: typeof basename };
