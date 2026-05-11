import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import type { JudgeOutput } from '../judge/judge.js';
import type { TraceEvent } from '../trace/schema.js';
import type { ReportJson } from './report-json.js';

/**
 * Renders a self-contained HTML report.
 *
 * Design intent: this is a memo, not a dashboard. Plain typography, plain headings,
 * plain prose. The job of the report is to communicate "what works, what doesn't,
 * what wasn't tested." Decoration is kept minimal. No emoji icons in chrome, no
 * serif headlines, no smallcaps, no accent colors except for severity prefixes.
 *
 * When `opts.runDir` is provided, evidence chips become anchor links into a
 * collapsed Trace section, screenshots are inlined into findings + trace events,
 * and the full-run video is embedded with a 2× default rate + seek-to-action.
 */

export interface BuildReportHtmlOptions {
  /** Run directory; if provided, the report reads trace.jsonl + finds screenshots/videos */
  runDir?: string;
}

interface ScreenshotIndex {
  byObservationRef: Map<string, string>;
  byEventId: Map<string, string>;
}

interface RunData {
  events: TraceEvent[];
  screenshots: ScreenshotIndex;
  videoRelPath: string | null;
}

interface ActionMarker {
  ts_offset_s: number;
  label: string;
  eventId: string;
}

export function buildReportHtml(report: ReportJson, opts: BuildReportHtmlOptions = {}): string {
  const runData = opts.runDir ? loadRunData(opts.runDir) : null;
  const eventIndex = runData ? new Map(runData.events.map((e) => [e.id, e])) : new Map();
  const screenshotForEvent = runData?.screenshots.byEventId ?? new Map<string, string>();
  const actionMarkers = buildActionMarkers(runData);

  const parts: string[] = [];
  parts.push(renderHeader(report));
  // Phase 5: if the run was blocked at preflight, render a banner and skip
  // the score-bearing sections. The verdict is "we couldn't evaluate this",
  // not a number.
  if (report.headline.blocked) {
    parts.push(renderBlockedBanner(report));
    parts.push(renderCaveatsSection(report.meta));
    if (runData) parts.push(renderTraceSection(runData));
    parts.push(renderFooter(report));
  } else {
    parts.push(renderTLDR(report, eventIndex));
    parts.push(renderWhatHappened(report, eventIndex));
    parts.push(
      renderFindingsSection(
        report.findings,
        eventIndex,
        screenshotForEvent,
        report.artifacts?.clips ?? {},
      ),
    );
    if (runData?.videoRelPath)
      parts.push(renderVideoSection(runData.videoRelPath, report.run.duration_s, actionMarkers));
    parts.push(renderRubricSection(report.scores, eventIndex));
    parts.push(renderCaveatsSection(report.meta));
    if (runData) parts.push(renderTraceSection(runData));
    parts.push(renderFooter(report));
  }

  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Iris — ${escapeHtml(report.run.target.url)}</title>
<style>${STYLES}</style>
</head>
<body>
<main>
${parts.filter(Boolean).join('\n')}
</main>
${runData?.videoRelPath ? VIDEO_SCRIPT : ''}
</body>
</html>`;
}

// ===========================================================================
// Styles — minimal, memo-style. White background, near-black text, one neutral
// link color. Severity prefixes get a single color each. No section dividers,
// no card shadows, no smallcaps, no serif. Width capped for legibility.
// ===========================================================================

const STYLES = `
  :root {
    --text: #1f2328;
    --text-dim: #57606a;
    --text-faint: #8b949e;
    --rule: #d1d9e0;
    --rule-light: #eaeef2;
    --bg-soft: #f6f8fa;
    --link: #0969da;
    --link-hover: #0a4a8a;
    --sev-blocker: #cf222e;
    --sev-major: #bf3989;
    --sev-minor: #9a6700;
    --sev-nit: #57606a;
    --sev-suggestion: #1f6feb;
    --status-pass: #1a7f37;
    --status-partial: #9a6700;
    --status-fail: #cf222e;
    --status-untested: #8b949e;
    --mono: ui-monospace, SFMono-Regular, "SF Mono", Menlo, Consolas, monospace;
    --sans: -apple-system, BlinkMacSystemFont, "Segoe UI", "Helvetica Neue", system-ui, sans-serif;
  }
  * { box-sizing: border-box; }
  html { scroll-behavior: smooth; scroll-padding-top: 1rem; }
  body {
    margin: 0;
    background: #ffffff;
    color: var(--text);
    font-family: var(--sans);
    font-size: 15px;
    line-height: 1.55;
    -webkit-font-smoothing: antialiased;
  }
  main {
    max-width: 760px;
    margin: 0 auto;
    padding: 32px 24px 80px;
  }
  @media (max-width: 640px) {
    main { padding: 20px 16px 48px; }
  }

  /* Headings */
  h1 {
    font-size: 22px;
    font-weight: 600;
    margin: 0 0 4px;
    line-height: 1.3;
  }
  h2 {
    font-size: 16px;
    font-weight: 600;
    margin: 32px 0 12px;
    line-height: 1.4;
  }
  h3 {
    font-size: 14px;
    font-weight: 600;
    margin: 16px 0 6px;
  }

  /* Top metadata strip */
  .meta-strip {
    font-family: var(--mono);
    font-size: 12px;
    color: var(--text-dim);
    margin-bottom: 4px;
  }
  .meta-strip > * + *::before {
    content: "·";
    color: var(--text-faint);
    margin: 0 8px;
  }
  .target {
    margin: 4px 0 24px;
    font-family: var(--mono);
    font-size: 13px;
    word-break: break-all;
  }
  .target a { color: var(--link); text-decoration: none; }
  .target a:hover { color: var(--link-hover); text-decoration: underline; }

  /* TL;DR block */
  .tldr {
    padding: 14px 16px;
    background: var(--bg-soft);
    border-left: 3px solid var(--text-dim);
    margin-bottom: 8px;
    font-size: 15px;
    line-height: 1.55;
  }
  .tldr.pass { border-left-color: var(--status-pass); }
  .tldr.fail { border-left-color: var(--status-fail); }
  .tldr.partial { border-left-color: var(--status-partial); }
  .tldr p { margin: 0; }
  .tldr p + p { margin-top: 8px; }
  .integrity-line {
    color: var(--text-dim);
    font-size: 13px;
    margin-top: 8px !important;
  }
  .blocked-banner {
    background: #fff5f5;
    border: 1px solid var(--sev-blocker);
    border-left-width: 4px;
    padding: 20px 24px;
    margin: 16px 0 32px;
  }
  .blocked-banner h2 {
    color: var(--sev-blocker);
    margin: 0 0 12px;
  }
  .blocked-banner p { margin: 0 0 12px; }
  .blocked-banner ul.blocked-reasons {
    margin: 0 0 12px;
    padding-left: 20px;
  }
  .blocked-banner code {
    font-family: var(--mono);
    font-size: 13px;
    background: rgba(0,0,0,0.04);
    padding: 1px 5px;
    border-radius: 3px;
  }
  .unverified-tag {
    font-family: var(--mono);
    font-size: 10px;
    text-transform: uppercase;
    color: var(--text-faint);
    letter-spacing: 0.05em;
    margin-left: 6px;
  }
  .unverified-tag.explorer-error {
    color: var(--sev-suggestion);
  }
  .tldr .score-inline {
    font-family: var(--mono);
    font-weight: 600;
    color: var(--text);
  }

  /* "What happened" list */
  .goals-list, .findings-list, .caveats-list {
    margin: 0;
    padding: 0;
    list-style: none;
  }
  .goals-list > li {
    padding: 8px 0;
    border-top: 1px solid var(--rule-light);
    display: flex;
    gap: 12px;
    align-items: baseline;
  }
  .goals-list > li:first-child { border-top: none; }
  .goals-list .gtag {
    flex: 0 0 96px;
    font-family: var(--mono);
    font-size: 11px;
    text-transform: uppercase;
    letter-spacing: 0.04em;
    font-weight: 600;
  }
  .goals-list .gtag.status-satisfied,
  .goals-list .gtag.status-verified { color: var(--status-pass); }
  .goals-list .gtag.status-partial { color: var(--status-partial); }
  .goals-list .gtag.status-blocked,
  .goals-list .gtag.status-not_satisfied { color: var(--status-fail); }
  .goals-list .gtag.status-skipped { color: var(--text-faint); }
  .goals-list .gtag.status-untested { color: var(--status-untested); }
  .goals-list .gtext { flex: 1; }
  .goals-list .gid { font-family: var(--mono); color: var(--text-faint); font-size: 12px; }
  .goals-list .gnotes {
    color: var(--text-dim);
    font-size: 13px;
    margin-top: 4px;
  }
  .goals-list .gevidence { margin-top: 6px; }

  /* Findings */
  .findings-list > li {
    padding: 16px 0;
    border-top: 1px solid var(--rule-light);
  }
  .findings-list > li:first-child { border-top: none; padding-top: 4px; }
  .finding-head {
    display: flex;
    align-items: baseline;
    gap: 10px;
    margin-bottom: 6px;
    flex-wrap: wrap;
  }
  .finding-num {
    font-family: var(--mono);
    color: var(--text-faint);
    font-size: 12px;
    width: 24px;
  }
  .sev-tag {
    font-family: var(--mono);
    font-size: 10px;
    font-weight: 700;
    letter-spacing: 0.06em;
    text-transform: uppercase;
  }
  .sev-tag.sev-blocker { color: var(--sev-blocker); }
  .sev-tag.sev-major { color: var(--sev-major); }
  .sev-tag.sev-minor { color: var(--sev-minor); }
  .sev-tag.sev-nit { color: var(--sev-nit); }
  .sev-tag.sev-suggestion { color: var(--sev-suggestion); }
  .cat-tag {
    font-family: var(--mono);
    font-size: 10px;
    color: var(--text-faint);
    text-transform: uppercase;
    letter-spacing: 0.06em;
  }
  .fid {
    font-family: var(--mono);
    font-size: 10px;
    color: var(--text-faint);
    margin-left: auto;
  }
  .finding-title {
    font-size: 15px;
    font-weight: 600;
    margin: 0 0 4px;
  }
  .finding-body {
    color: var(--text-dim);
    font-size: 14px;
    line-height: 1.55;
    margin: 6px 0 0 34px;
    white-space: pre-line;
  }
  .finding-body > * + * { margin-top: 8px; }
  .finding-where {
    font-family: var(--mono);
    font-size: 11px;
    color: var(--text-faint);
    margin-top: 8px;
  }
  .finding-where code {
    background: var(--bg-soft);
    border: 1px solid var(--rule-light);
    padding: 1px 5px;
    border-radius: 2px;
    color: var(--text);
  }
  .finding-fix {
    margin-top: 10px;
    padding: 6px 12px;
    border-left: 2px solid var(--text);
    background: var(--bg-soft);
    color: var(--text);
    font-size: 14px;
  }
  .finding-fix .fix-label {
    font-family: var(--mono);
    font-size: 11px;
    color: var(--text-dim);
    margin-right: 6px;
  }
  .finding-clip {
    margin: 12px 0 0 34px;
    max-width: 600px;
  }
  .finding-clip video {
    width: 100%;
    max-height: 360px;
    border: 1px solid var(--rule);
    border-radius: 4px;
    background: #000;
  }
  .finding-clip .caption {
    font-size: 12px;
    color: var(--text-dim);
    margin-top: 4px;
    display: flex;
    justify-content: space-between;
  }
  .finding-clip .caption a { color: var(--link); }
  .finding-screenshot {
    margin-top: 10px;
    border: 1px solid var(--rule);
    background: var(--bg-soft);
    border-radius: 4px;
    overflow: hidden;
  }
  .finding-screenshot img {
    display: block;
    width: 100%;
    max-height: 280px;
    object-fit: contain;
    background: white;
  }
  .finding-screenshot .caption {
    padding: 4px 10px;
    border-top: 1px solid var(--rule-light);
    font-family: var(--mono);
    font-size: 10px;
    color: var(--text-faint);
    display: flex;
    justify-content: space-between;
  }
  .finding-screenshot .caption a { color: var(--link); }
  .evidence-row {
    margin-top: 10px;
    font-size: 12px;
  }
  .evidence-row .label {
    color: var(--text-faint);
    font-family: var(--mono);
    font-size: 10px;
    text-transform: uppercase;
    letter-spacing: 0.06em;
    margin-right: 6px;
  }
  .ev-chip {
    font-family: var(--mono);
    font-size: 11px;
    color: var(--link);
    background: var(--bg-soft);
    border: 1px solid var(--rule-light);
    padding: 1px 6px;
    border-radius: 2px;
    text-decoration: none;
    margin-right: 4px;
    display: inline-block;
  }
  .ev-chip:hover { background: var(--link); color: white; border-color: var(--link); }
  .ev-chip .ev-kind {
    color: var(--text-faint);
    margin-right: 4px;
  }
  .ev-chip:hover .ev-kind { color: rgba(255,255,255,0.7); }

  /* Video */
  .video-section video {
    display: block;
    width: 100%;
    max-height: 420px;
    background: #000;
    border: 1px solid var(--rule);
    border-radius: 4px;
  }
  .video-note {
    color: var(--text-dim);
    font-size: 13px;
    margin: 0 0 10px;
  }
  .seek-list { margin-top: 10px; }
  .seek-list .label {
    font-family: var(--mono);
    font-size: 10px;
    text-transform: uppercase;
    letter-spacing: 0.06em;
    color: var(--text-faint);
    margin-bottom: 6px;
    display: block;
  }
  .seek-btn {
    background: none;
    border: none;
    font: inherit;
    font-family: var(--mono);
    font-size: 12px;
    cursor: pointer;
    color: var(--link);
    padding: 3px 0;
    display: flex;
    gap: 12px;
    align-items: baseline;
    text-align: left;
    width: 100%;
  }
  .seek-btn:hover { background: var(--bg-soft); }
  .seek-btn .ts {
    color: var(--text-faint);
    width: 48px;
    font-variant-numeric: tabular-nums;
  }

  /* Rubric — collapsed by default, minimal */
  .rubric-section {
    border: 1px solid var(--rule-light);
    border-radius: 4px;
    padding: 0;
  }
  .rubric-section > summary {
    cursor: pointer;
    padding: 10px 14px;
    list-style: none;
    font-weight: 600;
    font-size: 14px;
    display: flex;
    align-items: center;
    gap: 8px;
  }
  .rubric-section > summary::-webkit-details-marker { display: none; }
  .rubric-section .chev { color: var(--text-faint); font-family: var(--mono); font-size: 10px; transition: transform 120ms; }
  .rubric-section[open] .chev { transform: rotate(90deg); }
  .rubric-section > .body { padding: 0 14px 14px; border-top: 1px solid var(--rule-light); }
  .rubric-profile {
    padding: 12px 0;
    border-bottom: 1px solid var(--rule-light);
  }
  .rubric-profile:last-child { border-bottom: none; }
  .rubric-profile-head {
    display: flex;
    align-items: baseline;
    gap: 12px;
    margin-bottom: 6px;
  }
  .rubric-profile-head .name { font-weight: 600; text-transform: capitalize; }
  .rubric-profile-head .score {
    font-family: var(--mono);
    font-size: 13px;
    color: var(--text);
    margin-left: auto;
  }
  .rubric-dim {
    margin: 6px 0 4px 0;
    font-size: 13px;
    color: var(--text-dim);
  }
  .rubric-dim .dim-name {
    color: var(--text);
    font-weight: 500;
  }
  .rubric-dim .dim-score {
    font-family: var(--mono);
    color: var(--text-faint);
    margin-left: 6px;
  }

  /* Caveats */
  .caveats-section {
    margin-top: 32px;
    padding: 12px 16px;
    background: var(--bg-soft);
    border-left: 3px solid var(--text-faint);
    border-radius: 0 4px 4px 0;
    font-size: 14px;
  }
  .caveats-section h3 {
    margin: 0 0 8px;
    font-size: 13px;
    color: var(--text-dim);
    font-weight: 600;
  }
  .caveats-list > li {
    color: var(--text-dim);
    padding: 2px 0;
  }
  .caveats-list > li::before {
    content: "—";
    margin-right: 8px;
    color: var(--text-faint);
  }
  .re-explore {
    margin-top: 10px;
    padding-top: 10px;
    border-top: 1px dashed var(--rule);
    font-size: 12px;
  }
  .re-explore .label {
    font-family: var(--mono);
    font-size: 10px;
    text-transform: uppercase;
    letter-spacing: 0.06em;
    color: var(--text-faint);
    margin-right: 8px;
  }
  .re-explore code {
    background: white;
    border: 1px solid var(--rule);
    padding: 1px 6px;
    border-radius: 2px;
    margin: 0 4px 4px 0;
    display: inline-block;
    font-size: 12px;
  }

  /* Trace — fully collapsed by default */
  .trace-section {
    margin-top: 32px;
    border: 1px solid var(--rule-light);
    border-radius: 4px;
  }
  .trace-section > summary {
    cursor: pointer;
    padding: 10px 14px;
    list-style: none;
    font-size: 14px;
    color: var(--text-dim);
    font-weight: 500;
    display: flex;
    align-items: center;
    gap: 8px;
  }
  .trace-section > summary::-webkit-details-marker { display: none; }
  .trace-section .chev { font-family: var(--mono); font-size: 10px; color: var(--text-faint); transition: transform 120ms; }
  .trace-section[open] .chev { transform: rotate(90deg); }
  .trace-section .trace-meta { font-family: var(--mono); font-size: 11px; color: var(--text-faint); margin-left: 8px; }
  .trace-events { padding: 0 14px 14px; border-top: 1px solid var(--rule-light); font-family: var(--mono); font-size: 12px; }
  .trace-event {
    border-bottom: 1px dotted var(--rule-light);
  }
  .trace-event > summary {
    padding: 6px 0;
    cursor: pointer;
    list-style: none;
    display: flex;
    gap: 10px;
    align-items: baseline;
  }
  .trace-event > summary::-webkit-details-marker { display: none; }
  .trace-event > summary:hover { background: var(--bg-soft); }
  .trace-event .step { color: var(--text-faint); width: 36px; text-align: right; flex: 0 0 auto; font-variant-numeric: tabular-nums; }
  .trace-event .kind { width: 96px; flex: 0 0 96px; }
  .trace-event .kind-action { color: var(--text); font-weight: 500; }
  .trace-event .kind-observation { color: var(--text-dim); }
  .trace-event .kind-tentative_finding { color: var(--sev-major); }
  .trace-event .kind-give_up { color: var(--sev-blocker); }
  .trace-event .kind-done { color: var(--status-pass); }
  .trace-event .one-line {
    flex: 1;
    color: var(--text-dim);
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
  }
  .trace-event .ev-id-tail { color: var(--text-faint); font-size: 10px; }
  .trace-event > .details {
    padding: 8px 0 12px 46px;
    border-top: 1px dotted var(--rule-light);
    font-size: 11px;
  }
  .trace-event > .details img {
    max-width: 100%;
    max-height: 220px;
    border: 1px solid var(--rule);
    border-radius: 3px;
    margin-top: 6px;
    object-fit: contain;
  }
  .trace-event > .details pre {
    margin: 8px 0 0;
    padding: 8px;
    background: var(--bg-soft);
    border: 1px solid var(--rule-light);
    border-radius: 3px;
    font-size: 10px;
    line-height: 1.5;
    overflow-x: auto;
    color: var(--text-dim);
  }
  :target {
    background: #fff8c5;
    transition: background 800ms ease;
  }

  /* Footer */
  footer.colophon {
    margin-top: 48px;
    padding-top: 16px;
    border-top: 1px solid var(--rule-light);
    font-family: var(--mono);
    font-size: 11px;
    color: var(--text-faint);
    display: flex;
    gap: 16px;
    flex-wrap: wrap;
  }

  @media print {
    body { background: white; }
    details { open: true; }
    .trace-section > summary, .rubric-section > summary { display: none; }
    video { display: none; }
  }
`;

const VIDEO_SCRIPT = `<script>
(() => {
  const v = document.getElementById('iris-video');
  if (!v) return;
  v.addEventListener('loadedmetadata', () => { v.playbackRate = 2.0; }, { once: true });
  document.querySelectorAll('.seek-btn').forEach((btn) => {
    btn.addEventListener('click', () => {
      const t = parseFloat(btn.getAttribute('data-seek') || '0');
      v.currentTime = t;
      v.play().catch(() => {});
      v.scrollIntoView({ behavior: 'smooth', block: 'center' });
    });
  });
})();
</script>`;

// ===========================================================================
// Section renderers
// ===========================================================================

function renderHeader(report: ReportJson): string {
  return `<header>
    <h1>${escapeHtml(targetDisplay(report.run.target.url))}</h1>
    <div class="meta-strip">
      <span>${escapeHtml(new Date(report.run.started_at).toLocaleString())}</span>
      <span>${escapeHtml(report.run.mode)}</span>
      <span>${formatDuration(report.run.duration_s)}</span>
      <span>$${report.run.cost_usd.toFixed(2)}</span>
      <span>${report.run.step_count} steps</span>
      <span>termination: ${escapeHtml(report.run.termination)}</span>
    </div>
    <div class="target">→ <a href="${escapeAttr(report.run.target.url)}" target="_blank" rel="noopener">${escapeHtml(report.run.target.url)}</a></div>
  </header>`;
}

function targetDisplay(url: string): string {
  try {
    const u = new URL(url);
    return u.hostname.replace(/^www\./, '') + (u.pathname === '/' ? '' : u.pathname);
  } catch {
    return url;
  }
}

// TL;DR: a one-paragraph plain-English summary of the run.
function renderTLDR(report: ReportJson, eventIndex: Map<string, TraceEvent>): string {
  const goals = report.spec_compliance;
  const effective = goals.applicable
    ? goals.goals.map((g) => effectiveGoalStatus(g, eventIndex))
    : [];
  const counts = {
    sat: effective.filter((s) => s === 'verified' || s === 'satisfied').length,
    par: effective.filter((s) => s === 'partial').length,
    neg: effective.filter((s) => s === 'blocked' || s === 'not_satisfied').length,
    skipped: effective.filter((s) => s === 'skipped').length,
    untested: effective.filter((s) => s === 'untested').length,
    total: effective.length,
  };
  const findingCounts = report.headline;
  const totalFindings =
    findingCounts.blockers +
    findingCounts.majors +
    findingCounts.minors +
    findingCounts.nits +
    findingCounts.suggestions;
  const partialOrFailGoals = counts.par + counts.neg;

  // Determine overall tone class
  let toneClass = 'partial';
  if (
    counts.total > 0 &&
    counts.sat === counts.total &&
    findingCounts.blockers === 0 &&
    findingCounts.majors === 0
  ) {
    toneClass = 'pass';
  } else if (findingCounts.blockers > 0 || (counts.total > 0 && counts.neg >= counts.total / 2)) {
    toneClass = 'fail';
  }

  // First sentence: what was verified
  const sentences: string[] = [];
  if (goals.applicable && counts.total > 0) {
    const tail: string[] = [];
    if (counts.par > 0) tail.push(`partially verified ${counts.par}`);
    if (counts.neg > 0) tail.push(`found ${counts.neg} broken`);
    if (counts.untested > 0) tail.push(`did not test ${counts.untested}`);
    const tailStr = tail.length > 0 ? `; ${tail.join(', ')}` : '';
    if (counts.sat === counts.total) {
      sentences.push(
        `Iris verified all ${counts.total} spec goal${counts.total === 1 ? '' : 's'}.`,
      );
    } else if (counts.sat > 0) {
      sentences.push(
        `Iris verified ${counts.sat} of ${counts.total} spec goal${counts.total === 1 ? '' : 's'}${tailStr}.`,
      );
    } else {
      sentences.push(`Iris did not verify any spec goals end-to-end${tailStr || ''}.`);
    }
  }

  // Second sentence: findings summary
  if (totalFindings > 0) {
    const findingParts: string[] = [];
    if (findingCounts.blockers > 0)
      findingParts.push(
        `${findingCounts.blockers} blocker${findingCounts.blockers === 1 ? '' : 's'}`,
      );
    if (findingCounts.majors > 0) findingParts.push(`${findingCounts.majors} major`);
    if (findingCounts.minors > 0) findingParts.push(`${findingCounts.minors} minor`);
    if (findingCounts.nits > 0)
      findingParts.push(`${findingCounts.nits} nit${findingCounts.nits === 1 ? '' : 's'}`);
    if (findingCounts.suggestions > 0)
      findingParts.push(
        `${findingCounts.suggestions} suggestion${findingCounts.suggestions === 1 ? '' : 's'}`,
      );
    sentences.push(
      `${totalFindings} finding${totalFindings === 1 ? '' : 's'} (${findingParts.join(', ')}).`,
    );
  } else if (partialOrFailGoals > 0) {
    sentences.push('No specific defects flagged.');
  }

  // Third sentence: termination context
  if (report.run.termination === 'max_turns' || report.run.termination === 'budget_steps') {
    sentences.push('Run hit the turn budget before all goals could be tested.');
  } else if (report.run.termination === 'give_up') {
    sentences.push('Iris gave up early — see caveats.');
  } else if (report.run.termination === 'budget_cost' || report.run.termination === 'budget_time') {
    sentences.push('Run hit a cost/time budget.');
  }

  // Score footer
  const scoreLine = `<p><span class="score-inline">${report.headline.score.toFixed(1)} / 10</span> &nbsp;<span style="color: var(--text-faint); font-size: 13px;">across rubric profiles (see below for breakdown)</span></p>`;

  // Phase 5: data integrity line — how many findings survived evidence validation.
  let integrityLine = '';
  const ev = report.evidence_validation;
  if (ev && ev.verified + ev.downgraded + ev.discarded > 0) {
    const total = ev.verified + ev.downgraded + ev.discarded;
    const parts: string[] = [];
    parts.push(`${ev.verified}/${total} verified backing`);
    if (ev.downgraded > 0) parts.push(`${ev.downgraded} downgraded`);
    if (ev.discarded > 0) parts.push(`${ev.discarded} discarded`);
    integrityLine = `<p class="integrity-line">Findings: ${parts.join(', ')}.</p>`;
  }

  return `<section class="tldr ${toneClass}">
    <p>${sentences.join(' ')}</p>
    ${scoreLine}
    ${integrityLine}
  </section>`;
}

function renderBlockedBanner(report: ReportJson): string {
  const reasons = report.headline.blocked_reasons ?? [];
  const checks = report.preflight?.checks ?? [];
  const failedChecks = checks.filter((c) => !c.ok);
  const screenshotImg = report.preflight?.screenshot
    ? `<div class="finding-screenshot"><a href="${escapeAttr(report.preflight.screenshot)}" target="_blank" rel="noopener"><img src="${escapeAttr(report.preflight.screenshot)}" alt="Preflight screenshot" loading="lazy"></a></div>`
    : '';
  const itemHtml =
    failedChecks.length > 0
      ? failedChecks
          .map(
            (c) =>
              `<li><code>${escapeHtml(c.name)}</code>${c.detail ? ` — ${escapeHtml(c.detail)}` : ''}</li>`,
          )
          .join('')
      : reasons.map((r) => `<li><code>${escapeHtml(r)}</code></li>`).join('');
  return `<section class="blocked-banner">
    <h2>App blocked from evaluation</h2>
    <p>Iris could not evaluate this target because preflight checks failed:</p>
    <ul class="blocked-reasons">${itemHtml}</ul>
    <p style="color: var(--text-dim); font-size: 14px;">No score is shown because no meaningful evaluation took place. Fix the underlying issues and re-run.</p>
    ${screenshotImg}
  </section>`;
}

// "What happened" — per-goal status with notes.
function renderWhatHappened(report: ReportJson, eventIndex: Map<string, TraceEvent>): string {
  if (!report.spec_compliance.applicable || report.spec_compliance.goals.length === 0) {
    return '';
  }
  const items = report.spec_compliance.goals
    .map((g) => {
      const effectiveStatus = effectiveGoalStatus(g, eventIndex);
      const label = goalStatusLabel(effectiveStatus);
      const evidence =
        g.evidence.length > 0
          ? `<div class="gevidence">${g.evidence.map((id) => renderEvidenceChip(id, eventIndex)).join('')}</div>`
          : '';
      return `<li>
        <span class="gtag status-${escapeHtml(effectiveStatus)}">${label}</span>
        <div class="gtext">
          <span class="gid">${escapeHtml(g.id)}</span> ${escapeHtml(g.description)}
          ${g.notes ? `<div class="gnotes">${escapeHtml(g.notes)}</div>` : ''}
          ${evidence}
        </div>
      </li>`;
    })
    .join('');

  return `<section>
    <h2>What got tested</h2>
    <ul class="goals-list">${items}</ul>
    ${report.spec_compliance.summary ? `<p style="margin-top: 12px; color: var(--text-dim); font-size: 14px;">${escapeHtml(report.spec_compliance.summary)}</p>` : ''}
  </section>`;
}

function goalStatusLabel(status: string): string {
  switch (status) {
    case 'verified':
    case 'satisfied':
      return 'works';
    case 'partial':
      return 'partial';
    case 'blocked':
    case 'not_satisfied':
      return 'broken';
    case 'skipped':
      return 'skipped';
    default:
      return 'untested';
  }
}

// Normalizes goal status across the Judge's pre- and post-Phase-5 enums, and
// downgrades a "broken" verdict to "untested" when the only evidence is a
// budget_abort event (the Explorer never reached the goal — calling it broken
// would overstate evidence and mislead the consumer).
function effectiveGoalStatus(
  g: ReportJson['spec_compliance']['goals'][number],
  eventIndex: Map<string, TraceEvent>,
): string {
  // Phase 5 statuses pass through unchanged. Legacy "satisfied" maps to "verified".
  if (g.status === 'verified' || g.status === 'satisfied') return 'verified';
  if (g.status === 'partial') return 'partial';
  if (g.status === 'skipped') return 'skipped';
  if (g.status === 'untested') return 'untested';
  // For "blocked" or "not_satisfied" (legacy), downgrade to untested when the
  // only evidence is a budget abort or notes explicitly say not tested.
  const onlyBudgetAbort =
    g.evidence.length > 0 && g.evidence.every((id) => eventIndex.get(id)?.kind === 'budget_abort');
  const notesSayUntested = !!g.notes && /\bnot tested\b/i.test(g.notes);
  if (onlyBudgetAbort || notesSayUntested) return 'untested';
  return g.status === 'blocked' ? 'blocked' : 'not_satisfied';
}

// Findings list
function renderFindingsSection(
  findings: JudgeOutput['findings'],
  eventIndex: Map<string, TraceEvent>,
  screenshotForEvent: Map<string, string>,
  clipsByFindingId: Record<string, string>,
): string {
  if (findings.length === 0) return '';
  const order: Record<string, number> = { blocker: 0, major: 1, minor: 2, nit: 3, suggestion: 4 };
  const sorted = [...findings].sort(
    (a, b) => (order[a.severity] ?? 99) - (order[b.severity] ?? 99),
  );
  const items = sorted
    .map((f, i) => renderFinding(f, i + 1, eventIndex, screenshotForEvent, clipsByFindingId))
    .join('');
  return `<section>
    <h2>Findings (${findings.length})</h2>
    <ul class="findings-list">${items}</ul>
  </section>`;
}

function renderFinding(
  f: JudgeOutput['findings'][number],
  num: number,
  eventIndex: Map<string, TraceEvent>,
  screenshotForEvent: Map<string, string>,
  clipsByFindingId: Record<string, string>,
): string {
  // Phase 6 F3: prefer a per-finding video clip when available; fall back to
  // the first cited-event screenshot. The clip is more useful — it shows the
  // actual interaction window — but small or thin findings may only get a
  // still frame.
  let inlineEvidence = '';
  const clipPath = clipsByFindingId[f.id];
  if (clipPath && /\.(webm|mp4)$/i.test(clipPath)) {
    inlineEvidence = `<div class="finding-clip">
      <video controls preload="metadata" src="${escapeAttr(clipPath)}"></video>
      <div class="caption">
        <span>clip for ${escapeHtml(f.id)}</span>
        <a href="${escapeAttr(clipPath)}" target="_blank" rel="noopener">open full</a>
      </div>
    </div>`;
  } else if (clipPath) {
    // sliceEvidence returned a screenshot path (kind='screenshot' fallback).
    inlineEvidence = `<div class="finding-screenshot">
      <a href="${escapeAttr(clipPath)}" target="_blank" rel="noopener">
        <img src="${escapeAttr(clipPath)}" alt="Evidence for ${escapeAttr(f.id)}" loading="lazy">
      </a>
      <div class="caption">
        <span>screenshot for ${escapeHtml(f.id)}</span>
        <a href="${escapeAttr(clipPath)}" target="_blank" rel="noopener">open full</a>
      </div>
    </div>`;
  } else {
    // Original Phase 5 behavior: pick the first event-keyed screenshot.
    for (const eid of f.evidence) {
      const path = screenshotForEvent.get(eid);
      if (path) {
        inlineEvidence = `<div class="finding-screenshot">
          <a href="${escapeAttr(path)}" target="_blank" rel="noopener">
            <img src="${escapeAttr(path)}" alt="Screenshot evidence" loading="lazy">
          </a>
          <div class="caption">
            <span>at ${escapeHtml(eid)}</span>
            <a href="${escapeAttr(path)}" target="_blank" rel="noopener">open full size</a>
          </div>
        </div>`;
        break;
      }
    }
  }
  const inlineScreenshot = inlineEvidence;

  return `<li>
    <div class="finding-head">
      <span class="finding-num">${num}.</span>
      <span class="sev-tag sev-${escapeHtml(f.severity)}">${escapeHtml(f.severity)}</span>
      ${f.unverified_backing ? '<span class="unverified-tag" title="The validator could not confirm a backing event for this finding; severity was downgraded.">unverified</span>' : ''}
      ${f.likely_explorer_error ? '<span class="unverified-tag explorer-error" title="The only backing for this finding was a failed action that looks like the Explorer using a bad selector, not an app bug.">likely-explorer-error</span>' : ''}
      <span class="cat-tag">${escapeHtml(f.category)}</span>
      <span class="fid">${escapeHtml(f.id)}</span>
    </div>
    <h3 class="finding-title" style="margin-left: 34px;">${escapeHtml(f.title)}</h3>
    <div class="finding-body">
      <div>${escapeHtml(f.rationale)}</div>
      ${f.where ? renderWhere(f.where) : ''}
      ${
        f.suggested_fix
          ? `<div class="finding-fix"><span class="fix-label">Fix:</span>${escapeHtml(f.suggested_fix.summary)}</div>`
          : ''
      }
      ${inlineScreenshot}
      ${
        f.evidence.length > 0
          ? `<div class="evidence-row"><span class="label">Evidence</span>${f.evidence.map((e) => renderEvidenceChip(e, eventIndex)).join('')}</div>`
          : ''
      }
    </div>
  </li>`;
}

function renderWhere(where: { url?: string | undefined; selector?: string | undefined }): string {
  const parts: string[] = [];
  if (where.url) parts.push(`<code>${escapeHtml(where.url)}</code>`);
  if (where.selector) parts.push(`<code>${escapeHtml(where.selector)}</code>`);
  if (parts.length === 0) return '';
  return `<div class="finding-where">at ${parts.join(' ')}</div>`;
}

function renderEvidenceChip(eventId: string, eventIndex: Map<string, TraceEvent>): string {
  const event = eventIndex.get(eventId);
  if (event) {
    return `<a href="#evt-${escapeAttr(eventId)}" class="ev-chip" title="${escapeAttr(event.kind)}">
      <span class="ev-kind">${escapeHtml(event.kind)}</span>${escapeHtml(eventId.slice(-6))}
    </a>`;
  }
  return `<span class="ev-chip">${escapeHtml(eventId.slice(-6))}</span>`;
}

// Video section
function renderVideoSection(relPath: string, durationS: number, markers: ActionMarker[]): string {
  const seekItems =
    markers.length > 0
      ? `<div class="seek-list">
          <span class="label">Skip to action</span>
          ${markers
            .map(
              (
                m,
              ) => `<button type="button" class="seek-btn" data-seek="${m.ts_offset_s.toFixed(2)}">
              <span class="ts">${formatTimecode(m.ts_offset_s)}</span>
              <span>${escapeHtml(m.label)}</span>
            </button>`,
            )
            .join('')}
        </div>`
      : '';
  return `<section class="video-section">
    <h2>Recording (${formatDuration(durationS)}, plays at 2×)</h2>
    <p class="video-note">Note: in this run, the Explorer's actions were short (a few keystrokes + clicks). Most of the recording shows the page sitting idle. Use the skip-to-action chips to jump to the interesting moments.</p>
    <video id="iris-video" controls preload="metadata" src="${escapeAttr(relPath)}">
      <a href="${escapeAttr(relPath)}">Download recording</a>
    </video>
    ${seekItems}
  </section>`;
}

// Rubric breakdown — collapsed, low-priority
function renderRubricSection(
  scores: JudgeOutput['scores'],
  eventIndex: Map<string, TraceEvent>,
): string {
  const entries = Object.entries(scores.profiles);
  if (entries.length === 0) return '';
  const profilesHtml = entries
    .map(([name, p]) => {
      const dims = Object.entries(p.dimensions)
        .map(([dimId, d]) => {
          return `<div class="rubric-dim">
            <span class="dim-name">${escapeHtml(dimId.replace(/_/g, ' '))}</span><span class="dim-score">${d.score.toFixed(1)}</span>
            <div style="margin-top: 2px;">${escapeHtml(d.rationale)}</div>
            ${d.evidence.length > 0 ? `<div class="evidence-row" style="margin-top: 4px;">${d.evidence.map((id) => renderEvidenceChip(id, eventIndex)).join('')}</div>` : ''}
          </div>`;
        })
        .join('');
      return `<div class="rubric-profile">
        <div class="rubric-profile-head">
          <span class="name">${escapeHtml(name.replace(/_/g, ' '))}</span>
          <span class="score">${p.score.toFixed(1)} / 10</span>
        </div>
        ${dims}
      </div>`;
    })
    .join('');
  return `<details class="rubric-section">
    <summary><span class="chev">▸</span> Rubric breakdown (${entries.length} profile${entries.length === 1 ? '' : 's'})</summary>
    <div class="body">${profilesHtml}</div>
  </details>`;
}

// Caveats
function renderCaveatsSection(meta: JudgeOutput['meta']): string {
  if (meta.confidence_caveats.length === 0 && meta.would_re_explore_with.length === 0) return '';
  return `<aside class="caveats-section">
    <h3>Caveats (confidence ${Math.round(meta.confidence_overall * 100)}%)</h3>
    ${
      meta.confidence_caveats.length > 0
        ? `<ul class="caveats-list">${meta.confidence_caveats.map((c) => `<li>${escapeHtml(c)}</li>`).join('')}</ul>`
        : ''
    }
    ${
      meta.would_re_explore_with.length > 0
        ? `<div class="re-explore">
          <span class="label">Try re-running with</span>
          ${meta.would_re_explore_with.map((s) => `<code>${escapeHtml(s)}</code>`).join('')}
        </div>`
        : ''
    }
  </aside>`;
}

// Trace
function renderTraceSection(runData: RunData): string {
  if (runData.events.length === 0) return '';
  const counts: Record<string, number> = {};
  for (const e of runData.events) counts[e.kind] = (counts[e.kind] ?? 0) + 1;
  const summary = Object.entries(counts)
    .filter(([k]) => k !== 'run_start' && k !== 'run_end')
    .sort((a, b) => b[1] - a[1])
    .map(([k, n]) => `${n} ${k.replace(/_/g, ' ')}`)
    .join(', ');
  const events = runData.events.map((e) => renderTraceEvent(e, runData)).join('');
  return `<details class="trace-section">
    <summary>
      <span class="chev">▸</span> Trace
      <span class="trace-meta">${runData.events.length} events — ${escapeHtml(summary)}</span>
    </summary>
    <div class="trace-events">${events}</div>
  </details>`;
}

function renderTraceEvent(e: TraceEvent, runData: RunData): string {
  const screenshot = runData.screenshots.byEventId.get(e.id);
  const summary = traceEventSummary(e);
  const payloadStr = JSON.stringify(e.payload, null, 2);
  return `<details class="trace-event" id="evt-${escapeAttr(e.id)}">
    <summary>
      <span class="step">${e.step}</span>
      <span class="kind kind-${escapeHtml(e.kind)}">${escapeHtml(e.kind)}</span>
      <span class="one-line">${escapeHtml(summary)}</span>
      <span class="ev-id-tail">${escapeHtml(e.id.slice(-6))}</span>
    </summary>
    <div class="details">
      <div style="color: var(--text-faint);">
        ${escapeHtml(e.actor)} — ${escapeHtml(new Date(e.ts * 1000).toLocaleTimeString())} — <span style="font-size: 10px;">${escapeHtml(e.id)}</span>
      </div>
      ${
        screenshot
          ? `<a href="${escapeAttr(screenshot)}" target="_blank" rel="noopener"><img src="${escapeAttr(screenshot)}" alt="Frame" loading="lazy"></a>`
          : ''
      }
      <pre><code>${escapeHtml(payloadStr)}</code></pre>
    </div>
  </details>`;
}

function traceEventSummary(e: TraceEvent): string {
  const p = e.payload as Record<string, unknown>;
  switch (e.kind) {
    case 'observation': {
      const summary = String(p.summary ?? '')
        .slice(0, 100)
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
    default:
      return JSON.stringify(p).slice(0, 80);
  }
}

function renderFooter(report: ReportJson): string {
  return `<footer class="colophon">
    <span>iris ${escapeHtml(report.tool.version)}</span>
    <span>explorer: ${escapeHtml(report.run.models.explorer)}</span>
    <span>judge: ${escapeHtml(report.run.models.judge)}</span>
    <span>${escapeHtml(report.run.id)}</span>
  </footer>`;
}

// ===========================================================================
// Run data + helpers
// ===========================================================================

function loadRunData(runDir: string): RunData | null {
  const tracePath = join(runDir, 'trace.jsonl');
  if (!existsSync(tracePath)) return null;
  let events: TraceEvent[];
  try {
    events = readFileSync(tracePath, 'utf8')
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
    for (const f of files) {
      const m = f.match(/^step-(\d+)/);
      if (!m || !m[1]) continue;
      const n = Number.parseInt(m[1], 10);
      const obsRef = `OBS-${String(n).padStart(6, '0')}`;
      if (f === `step-${m[1]}.png` || !byObservationRef.has(obsRef)) {
        byObservationRef.set(obsRef, `evidence/screenshots/${f}`);
      }
    }
    for (const e of events) {
      if (e.kind === 'observation' && typeof e.payload?.ref === 'string') {
        const path = byObservationRef.get(e.payload.ref as string);
        if (path) byEventId.set(e.id, path);
      }
    }
  }

  const videosDir = join(runDir, 'evidence', 'videos');
  let videoRelPath: string | null = null;
  if (existsSync(videosDir)) {
    const webms = readdirSync(videosDir).filter((f) => f.endsWith('.webm'));
    if (webms.length > 0) {
      webms.sort();
      videoRelPath = `evidence/videos/${webms[webms.length - 1]}`;
    }
  }
  return { events, screenshots: { byObservationRef, byEventId }, videoRelPath };
}

function buildActionMarkers(runData: RunData | null): ActionMarker[] {
  if (!runData || runData.events.length === 0) return [];
  const firstTs = runData.events[0]?.ts ?? 0;
  const out: ActionMarker[] = [];
  for (const e of runData.events) {
    if (e.kind !== 'action') continue;
    const p = e.payload as { tool?: string; args?: Record<string, unknown> };
    let label = p.tool ?? 'action';
    const args = p.args as { selector?: string; text?: string; url?: string } | undefined;
    if (args?.text) label += ` "${args.text.slice(0, 24)}"`;
    else if (args?.selector) label += ` ${args.selector.slice(0, 32)}`;
    else if (args?.url) label += ` ${args.url.slice(0, 32)}`;
    out.push({
      ts_offset_s: Math.max(0, e.ts - firstTs),
      label,
      eventId: e.id,
    });
  }
  return out;
}

function formatDuration(s: number): string {
  if (s < 60) return `${s.toFixed(0)}s`;
  const m = Math.floor(s / 60);
  const sec = Math.round(s % 60);
  return `${m}m ${sec}s`;
}

function formatTimecode(s: number): string {
  if (!Number.isFinite(s) || s < 0) return '0:00';
  const m = Math.floor(s / 60);
  const sec = Math.floor(s % 60);
  return `${m}:${String(sec).padStart(2, '0')}`;
}

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
