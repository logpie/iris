import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { isAbsolute, join, relative, resolve } from 'node:path';
import type { JudgeOutput } from '../judge/judge.js';
import { resolveTraceRefTypo } from '../trace/ref-resolver.js';
import type { TraceEvent } from '../trace/schema.js';
import type { ReportJson } from './report-json.js';
import { scoreDimensionWithRunEvidence } from './score-normalization.js';

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
  videoRelPaths: string[];
}

export function buildReportHtml(report: ReportJson, opts: BuildReportHtmlOptions = {}): string {
  const runData = opts.runDir ? loadRunData(opts.runDir) : null;
  const eventIndex = runData ? new Map(runData.events.map((e) => [e.id, e])) : new Map();
  const screenshotForEvent = runData?.screenshots.byEventId ?? new Map<string, string>();

  const parts: string[] = [];
  parts.push(renderHeader(report));
  // Phase 5: if the run was blocked at preflight, render a banner and skip
  // the score-bearing sections. The verdict is "we couldn't evaluate this",
  // not a number.
  if (report.headline.blocked) {
    parts.push(renderBlockedBanner(report));
    parts.push(renderCaveatsSection(report.meta));
    if (runData) parts.push(renderAuditTrailSection(report, runData, eventIndex));
    parts.push(renderFooter(report));
  } else {
    // Clip paths from sliceEvidence are absolute file paths. When the report
    // is served over HTTP from runDir, absolute paths resolve to the wrong URL
    // ("/tmp/..." instead of relative). Rewrite once and pass the normalized
    // claim map to every section that embeds clips.
    const clipPaths = relativizeClipPaths(report.artifacts?.clips ?? {}, opts.runDir);
    const goalFindingLinks = buildGoalFindingLinks(report, eventIndex);
    parts.push(renderTLDR(report, eventIndex));
    parts.push(renderAccessBlocks(report));
    parts.push(
      renderGoalEvidenceSection(
        report,
        eventIndex,
        screenshotForEvent,
        clipPaths,
        goalFindingLinks,
      ),
    );
    parts.push(
      renderFindingsSection(
        report.findings,
        eventIndex,
        screenshotForEvent,
        runData?.events ?? [],
        clipPaths,
        goalFindingLinks,
      ),
    );
    parts.push(renderScoreMatrixSection(report.scores, eventIndex));
    parts.push(renderCaveatsSection(report.meta));
    if (runData) parts.push(renderAuditTrailSection(report, runData, eventIndex));
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
${runData ? REPORT_SCRIPT : ''}
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
    max-width: 1040px;
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

  /* Executive overview */
  .report-hero {
    border: 1px solid var(--rule);
    border-top: 5px solid var(--text-dim);
    border-radius: 6px;
    padding: 18px;
    margin: 18px 0 24px;
    background: #fff;
  }
  .report-hero.pass { border-top-color: var(--status-pass); }
  .report-hero.fail { border-top-color: var(--status-fail); }
  .report-hero.partial { border-top-color: var(--status-partial); }
  .hero-main {
    display: grid;
    grid-template-columns: minmax(0, 1fr) auto;
    gap: 20px;
    align-items: start;
  }
  .eyebrow {
    font-family: var(--mono);
    font-size: 11px;
    color: var(--text-faint);
    text-transform: uppercase;
    letter-spacing: 0.06em;
    margin-bottom: 2px;
  }
  .report-hero h2 {
    font-size: 24px;
    margin: 0 0 4px;
  }
  .report-hero p {
    margin: 0;
    color: var(--text-dim);
    max-width: 760px;
  }
  .score-badge {
    min-width: 132px;
    padding: 10px 12px;
    border: 1px solid var(--rule-light);
    border-radius: 6px;
    text-align: right;
    background: var(--bg-soft);
  }
  .score-badge span {
    font-family: var(--mono);
    font-size: 32px;
    font-weight: 700;
    line-height: 1;
  }
  .score-badge small {
    color: var(--text-faint);
    font-family: var(--mono);
    margin-left: 2px;
  }
  .metric-grid {
    display: grid;
    grid-template-columns: repeat(6, minmax(110px, 1fr));
    gap: 8px;
    margin-top: 18px;
  }
  .metric {
    border: 1px solid var(--rule-light);
    border-radius: 6px;
    padding: 9px 10px;
    min-width: 0;
    background: #fff;
  }
  .metric span {
    display: block;
    color: var(--text-faint);
    font-family: var(--mono);
    font-size: 10px;
    text-transform: uppercase;
    letter-spacing: 0.05em;
  }
  .metric strong {
    display: block;
    margin-top: 2px;
    font-size: 17px;
    line-height: 1.2;
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
  }
  .metric em {
    display: block;
    margin-top: 2px;
    color: var(--text-dim);
    font-size: 12px;
    font-style: normal;
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
  }
  .integrity-strip {
    margin-top: 12px;
    display: flex;
    gap: 8px;
    flex-wrap: wrap;
    align-items: center;
  }
  .integrity-strip span {
    font-size: 12px;
    color: var(--text-dim);
    background: var(--bg-soft);
    border: 1px solid var(--rule-light);
    border-radius: 999px;
    padding: 3px 8px;
  }
  .integrity-strip .integrity-label {
    color: var(--text-faint);
    font-family: var(--mono);
    font-size: 10px;
    letter-spacing: 0.05em;
    text-transform: uppercase;
    background: transparent;
    border: none;
    padding-left: 0;
  }
  .score-warning {
    margin-top: 12px;
    padding: 10px 12px;
    border-left: 3px solid var(--status-partial);
    background: #fffaf0;
    color: var(--text-dim);
    font-size: 13px;
  }
  .score-warning strong {
    color: var(--text);
    margin-right: 6px;
  }
  .run-meta-panel {
    margin-top: 12px;
    border: 1px solid var(--rule-light);
    border-radius: 6px;
    background: var(--bg-soft);
    padding: 10px;
  }
  .run-meta-title {
    display: block;
    margin-bottom: 8px;
    color: var(--text-faint);
    font-family: var(--mono);
    font-size: 10px;
    text-transform: uppercase;
    letter-spacing: 0.05em;
  }
  .run-meta-grid {
    display: grid;
    grid-template-columns: repeat(4, minmax(0, 1fr));
    gap: 8px;
  }
  .run-meta-item {
    min-width: 0;
    background: #fff;
    border: 1px solid var(--rule-light);
    border-radius: 6px;
    padding: 8px 9px;
  }
  .run-meta-item span {
    display: block;
    color: var(--text-faint);
    font-family: var(--mono);
    font-size: 10px;
    text-transform: uppercase;
    letter-spacing: 0.05em;
  }
  .run-meta-item strong {
    display: block;
    margin-top: 2px;
    overflow: hidden;
    color: var(--text);
    font-family: var(--mono);
    font-size: 12px;
    font-weight: 600;
    line-height: 1.35;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  .run-meta-item em {
    display: block;
    margin-top: 2px;
    overflow: hidden;
    color: var(--text-dim);
    font-size: 12px;
    font-style: normal;
    line-height: 1.35;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  @media (max-width: 880px) {
    .metric-grid { grid-template-columns: repeat(3, minmax(0, 1fr)); }
    .run-meta-grid { grid-template-columns: repeat(2, minmax(0, 1fr)); }
  }
  @media (max-width: 640px) {
    .hero-main { grid-template-columns: 1fr; }
    .score-badge { text-align: left; }
    .metric-grid { grid-template-columns: repeat(2, minmax(0, 1fr)); }
    .run-meta-grid { grid-template-columns: 1fr; }
    .finding-layout { grid-template-columns: 1fr; }
    .goal-proof-row { grid-template-columns: 1fr; }
    .discovery-summary-grid { grid-template-columns: 1fr; }
    .raw-video-grid { grid-template-columns: 1fr; }
  }
  .access-blocks-section {
    background: #fffaf0;
    border-left: 3px solid #9a6700;
    padding: 14px 20px;
    margin: 20px 0;
  }
  .access-blocks-section h2 {
    color: #9a6700;
    margin: 0 0 4px;
    font-size: 15px;
  }
  .access-blocks-section ul.access-blocks-list {
    list-style: none;
    padding-left: 0;
    margin: 12px 0 0;
  }
  .access-blocks-section ul.access-blocks-list li {
    padding: 8px 0;
    border-top: 1px solid rgba(154, 103, 0, 0.2);
  }
  .access-blocks-section ul.access-blocks-list li:first-child { border-top: none; }
  .access-block-row {
    display: flex;
    gap: 10px;
    align-items: baseline;
  }
  .access-block-kind {
    font-family: var(--mono);
    font-size: 11px;
    text-transform: uppercase;
    color: #9a6700;
    font-weight: 600;
  }
  .access-blocks-section code {
    font-family: var(--mono);
    font-size: 12px;
    background: rgba(154,103,0,0.08);
    padding: 1px 5px;
    border-radius: 3px;
  }
  .access-block-desc {
    color: var(--text-dim);
    font-size: 13px;
    margin-top: 4px;
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
  /* Expandable debug sections */
  .audit-section {
    margin-top: 32px;
    border: 1px solid var(--rule-light);
    border-radius: 6px;
    background: #fff;
  }
  .audit-section > summary,
  .debug-panel > summary {
    cursor: pointer;
    list-style: none;
    padding: 10px 14px;
    display: flex;
    align-items: center;
    gap: 8px;
    font-weight: 600;
  }
  .audit-section > summary::-webkit-details-marker,
  .debug-panel > summary::-webkit-details-marker { display: none; }
  .audit-section .chev,
  .debug-panel .chev {
    color: var(--text-faint);
    font-family: var(--mono);
    font-size: 10px;
    transition: transform 120ms;
  }
  .audit-section[open] > summary .chev,
  .debug-panel[open] > summary .chev { transform: rotate(90deg); }
  .audit-note {
    color: var(--text-dim);
    font-size: 13px;
    margin: 0;
    padding: 0 14px 10px;
  }
  .audit-block {
    border-top: 1px solid var(--rule-light);
    padding: 12px 14px;
  }
  .audit-block h3 {
    margin: 0 0 3px;
  }
  .audit-block p {
    margin: 0 0 10px;
    color: var(--text-dim);
    font-size: 13px;
  }
  .debug-panel {
    border-top: 1px solid var(--rule-light);
  }
  .full-trace-link {
    border-top: 1px solid var(--rule-light);
    padding: 10px 14px 12px;
    display: flex;
    gap: 10px;
    align-items: baseline;
    flex-wrap: wrap;
    font-size: 13px;
  }
  .full-trace-link span {
    font-weight: 600;
  }
  .full-trace-link a {
    color: var(--link);
    font-family: var(--mono);
  }
  .full-trace-link em {
    color: var(--text-dim);
    font-style: normal;
    font-size: 12px;
  }
  .findings-list, .caveats-list {
    margin: 0;
    padding: 0;
    list-style: none;
  }

  /* Findings */
  .finding-card {
    padding: 16px 0;
    border-top: 1px solid var(--rule-light);
  }
  .finding-card:first-child { border-top: none; padding-top: 4px; }
  .finding-head {
    display: flex;
    justify-content: space-between;
    align-items: flex-start;
    gap: 12px;
    margin-bottom: 6px;
  }
  .finding-labels {
    display: flex;
    align-items: baseline;
    gap: 10px;
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
    padding-top: 2px;
    white-space: nowrap;
  }
  .finding-title {
    font-size: 15px;
    font-weight: 600;
    margin: 0 0 4px;
  }
  .finding-layout {
    display: grid;
    grid-template-columns: minmax(0, 1fr) minmax(260px, 38%);
    gap: 16px;
    align-items: start;
  }
  .finding-layout.no-media {
    display: block;
  }
  .finding-body {
    color: var(--text-dim);
    font-size: 14px;
    line-height: 1.55;
    margin: 6px 0 0;
    white-space: pre-line;
  }
  .finding-body > * + * { margin-top: 8px; }
  .finding-evidence-detail {
    margin-top: 10px;
    padding: 8px 10px;
    border: 1px solid var(--rule-light);
    border-left: 3px solid var(--sev-major);
    border-radius: 4px;
    background: #fff;
    font-size: 13px;
  }
  .finding-evidence-detail .detail-label {
    display: block;
    margin-bottom: 4px;
    font-family: var(--mono);
    font-size: 10px;
    letter-spacing: 0.05em;
    text-transform: uppercase;
    color: var(--text-faint);
  }
  .finding-evidence-detail code {
    font-family: var(--mono);
    font-size: 12px;
    background: var(--bg-soft);
    border: 1px solid var(--rule-light);
    padding: 1px 5px;
    border-radius: 3px;
  }
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
  .finding-patch-hint {
    margin: 6px 0 0;
    font-size: 13px;
    color: var(--text-dim);
  }
  .finding-patch-hint .patch-label {
    font-weight: 600;
    margin-right: 6px;
    color: var(--text);
  }
  .finding-code-pointer {
    margin: 6px 0 0;
    padding: 6px 10px;
    background: var(--bg-soft);
    border-left: 2px solid var(--rule);
    font-size: 12px;
    color: var(--text-dim);
    font-family: var(--mono);
  }
  .finding-code-pointer code {
    color: var(--text);
    background: rgba(0,0,0,0.04);
    padding: 1px 4px;
    border-radius: 3px;
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
    margin: 0;
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
    margin-top: 0;
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
  .finding-media {
    min-width: 0;
  }
  .finding-linked-goals {
    margin-top: 10px;
    padding: 8px 10px;
    border: 1px solid var(--rule-light);
    border-radius: 4px;
    background: var(--bg-soft);
    color: var(--text-dim);
    font-size: 12px;
  }
  .finding-linked-goals .label {
    display: block;
    font-family: var(--mono);
    font-size: 10px;
    color: var(--text-faint);
    text-transform: uppercase;
    letter-spacing: 0.06em;
    margin-bottom: 4px;
  }
  .finding-linked-goals a {
    color: var(--link);
    margin-right: 8px;
  }
  .finding-linked-media-note {
    border: 1px dashed var(--rule);
    border-radius: 4px;
    padding: 10px;
    background: var(--bg-soft);
    color: var(--text-dim);
    font-size: 13px;
  }
  .finding-linked-media-note a { color: var(--link); }
  .goal-review {
    margin-top: 28px;
  }
  .goal-review .section-head {
    margin-bottom: 14px;
  }
  .goal-review-overview {
    border: 1px solid var(--rule-light);
    border-radius: 6px;
    background: #fff;
    padding: 14px;
  }
  .goal-review-topline {
    display: flex;
    justify-content: space-between;
    gap: 18px;
    align-items: flex-start;
  }
  .goal-review-topline h2 {
    margin: 0;
  }
  .goal-review-topline p {
    max-width: 720px;
    margin: 4px 0 0;
    color: var(--text-dim);
    font-size: 13px;
  }
  .goal-review-stats {
    display: flex;
    gap: 8px;
    flex-wrap: wrap;
    justify-content: flex-end;
    min-width: 210px;
  }
  .status-pill {
    display: inline-flex;
    align-items: center;
    width: fit-content;
    font-family: var(--mono);
    font-size: 10px;
    font-weight: 600;
    letter-spacing: 0.04em;
    line-height: 1.35;
    text-transform: uppercase;
    border: 1px solid var(--rule-light);
    background: var(--bg-soft);
    color: var(--text-dim);
    padding: 2px 7px;
    border-radius: 999px;
  }
  .status-pill.status-verified {
    color: var(--status-pass);
    background: #dafbe1;
    border-color: #aceebb;
  }
  .status-pill.status-partial {
    color: var(--status-partial);
    background: #fff8c5;
    border-color: #eed888;
  }
  .status-pill.status-broken {
    color: var(--status-fail);
    background: #ffebe9;
    border-color: #ffcecb;
  }
  .status-pill.status-untested,
  .status-pill.status-skipped,
  .status-pill.status-mixed,
  .status-pill.status-neutral {
    color: var(--text-dim);
    background: var(--bg-soft);
    border-color: var(--rule-light);
  }
  .goal-review-facts {
    display: grid;
    grid-template-columns: repeat(3, minmax(0, 1fr));
    gap: 8px;
    margin-top: 12px;
  }
  .goal-review-fact {
    border: 1px solid var(--rule-light);
    background: var(--bg-soft);
    border-radius: 5px;
    padding: 8px 10px;
    min-width: 0;
  }
  .goal-review-fact span {
    display: block;
    color: var(--text-faint);
    font-family: var(--mono);
    font-size: 10px;
    letter-spacing: 0.05em;
    text-transform: uppercase;
  }
  .goal-review-fact strong {
    display: block;
    margin-top: 2px;
    color: var(--text);
    font-size: 13px;
    line-height: 1.35;
  }
  @media (max-width: 760px) {
    .goal-review-topline {
      display: block;
    }
    .goal-review-stats {
      justify-content: flex-start;
      margin-top: 10px;
      min-width: 0;
    }
    .goal-review-facts {
      grid-template-columns: 1fr;
    }
  }
  .goal-proof-groups {
    display: grid;
    gap: 16px;
  }
  .goal-proof-group {
    border: 1px solid var(--rule-light);
    border-radius: 6px;
    overflow: hidden;
    background: #fff;
  }
  .goal-proof-group-head {
    display: flex;
    justify-content: space-between;
    gap: 12px;
    align-items: center;
    padding: 13px 14px;
    background: var(--bg-soft);
    border-bottom: 1px solid var(--rule-light);
  }
  .goal-proof-group-head h3 {
    margin: 0;
    font-size: 17px;
    line-height: 1.35;
    display: flex;
    gap: 8px;
    align-items: baseline;
    flex-wrap: wrap;
  }
  .goal-id-badge {
    color: var(--text-faint);
    font-family: var(--mono);
    font-size: 12px;
    font-weight: 600;
    letter-spacing: 0.02em;
    white-space: nowrap;
  }
  .goal-proof-group-meta {
    display: flex;
    justify-content: flex-end;
    gap: 8px;
    align-items: center;
    flex-wrap: wrap;
  }
  .goal-proof-group-count {
    font-family: var(--mono);
    font-size: 11px;
    color: var(--text-faint);
    white-space: nowrap;
  }
  .goal-proof-list {
    display: grid;
  }
  .goal-proof-row {
    display: grid;
    grid-template-columns: minmax(300px, 42%) minmax(0, 1fr);
    gap: 16px;
    padding: 16px;
    border-top: 1px solid var(--rule-light);
    align-items: start;
  }
  .goal-proof-row:first-child { border-top: none; }
  .goal-proof-row.status-partial {
    background: #fffdf2;
  }
  .goal-proof-row.status-broken {
    background: #fff8f7;
  }
  .goal-proof-row.status-untested,
  .goal-proof-row.status-skipped {
    background: var(--bg-soft);
  }
  .goal-proof-row.no-frame {
    display: block;
    background: var(--bg-soft);
  }
  .goal-proof-row.no-frame.status-partial {
    background: #fffdf2;
  }
  .goal-proof-row.no-frame.status-broken {
    background: #fff8f7;
  }
  .goal-proof-media {
    min-width: 0;
    background: var(--bg-soft);
    border: 1px solid var(--rule-light);
    border-radius: 6px;
    overflow: hidden;
    color: inherit;
    text-decoration: none;
  }
  .goal-proof-media img,
  .goal-proof-media video {
    display: block;
    width: 100%;
    aspect-ratio: 16 / 9;
    object-fit: contain;
    object-position: top center;
    background: #fff;
  }
  .goal-proof-media video {
    background: #000;
  }
  .goal-proof-media-caption {
    display: flex;
    justify-content: space-between;
    gap: 10px;
    padding: 5px 8px;
    border-top: 1px solid var(--rule-light);
    color: var(--text-faint);
    font-family: var(--mono);
    font-size: 10px;
  }
  .goal-proof-media-caption a {
    color: var(--link);
  }
  .goal-proof-copy {
    min-width: 0;
    padding-top: 1px;
  }
  .goal-proof-card-heading {
    display: flex;
    gap: 8px;
    align-items: baseline;
    flex-wrap: wrap;
    margin-bottom: 8px;
  }
  .goal-proof-title {
    font-weight: 600;
    font-size: 16px;
    line-height: 1.35;
    flex: 1 1 240px;
  }
  .goal-proof-context {
    margin-top: 2px;
    color: var(--text-dim);
    font-size: 14px;
    line-height: 1.5;
  }
  .goal-linked-findings {
    margin-top: 9px;
    padding: 8px 10px;
    border-left: 3px solid var(--status-partial);
    background: #fff8e8;
    font-size: 12px;
    color: var(--text-dim);
  }
  .goal-linked-findings .label {
    display: block;
    font-family: var(--mono);
    font-size: 10px;
    color: var(--text-faint);
    text-transform: uppercase;
    letter-spacing: 0.06em;
    margin-bottom: 4px;
  }
  .goal-linked-findings a {
    color: var(--link);
    font-weight: 600;
  }
  .goal-proof-context .label,
  .goal-proof-scope .label {
    display: inline-block;
    min-width: 76px;
    font-family: var(--mono);
    font-size: 11px;
    color: var(--text-faint);
    text-transform: uppercase;
    letter-spacing: 0.06em;
    margin-right: 8px;
  }
  .goal-proof-scope {
    margin-top: 8px;
    color: var(--text-dim);
    font-size: 14px;
    line-height: 1.5;
  }
  .goal-proof-scope ul {
    display: inline-block;
    margin: 0;
    padding-left: 18px;
    vertical-align: top;
  }
  .goal-proof-origin {
    margin-top: 12px;
    color: var(--text-dim);
    font-size: 13px;
  }
  .goal-proof-origin > summary {
    cursor: pointer;
    color: var(--link);
    font-family: var(--mono);
    font-size: 11px;
  }
  .goal-proof-origin-body {
    display: grid;
    gap: 4px;
    margin-top: 6px;
  }
  .goal-proof-origin-row {
    display: flex;
    align-items: baseline;
    flex-wrap: wrap;
    gap: 5px;
    margin-top: 4px;
  }
  .goal-proof-origin-row .label {
    min-width: 76px;
    font-family: var(--mono);
    font-size: 11px;
    color: var(--text-faint);
    text-transform: uppercase;
    letter-spacing: 0.06em;
    margin-right: 6px;
  }
  .goal-proof-origin .discovery-chip-list {
    display: inline-flex;
    margin-top: 0;
    vertical-align: middle;
  }
  .discovery-summary {
    margin-top: 18px;
    border: 1px solid var(--rule-light);
    border-radius: 6px;
    background: var(--bg-soft);
    color: var(--text-dim);
    font-size: 12px;
    overflow: hidden;
  }
  .discovery-summary > summary {
    display: flex;
    justify-content: space-between;
    gap: 12px;
    align-items: center;
    cursor: pointer;
    list-style: none;
    padding: 11px 12px;
  }
  .discovery-summary > summary::-webkit-details-marker {
    display: none;
  }
  .discovery-summary-body {
    border-top: 1px solid var(--rule-light);
    padding: 10px 12px 12px;
  }
  .discovery-summary-title {
    color: var(--text);
    font-weight: 600;
  }
  .discovery-summary-meta {
    margin-top: 2px;
    color: var(--text-faint);
    font-family: var(--mono);
    font-size: 11px;
    text-align: right;
  }
  .discovery-summary-grid {
    display: grid;
    grid-template-columns: minmax(0, 1fr) minmax(0, 1fr);
    gap: 8px;
    margin-top: 9px;
  }
  .discovery-bucket {
    border: 1px solid var(--rule-light);
    border-radius: 5px;
    background: #fff;
    padding: 8px;
  }
  .discovery-bucket-label {
    color: var(--text-faint);
    font-family: var(--mono);
    font-size: 10px;
    letter-spacing: 0.06em;
    text-transform: uppercase;
  }
  .discovery-chip-list {
    display: flex;
    flex-wrap: wrap;
    gap: 5px;
    margin-top: 6px;
  }
  .discovery-chip {
    border: 1px solid var(--rule-light);
    border-radius: 999px;
    background: var(--bg-soft);
    color: var(--text);
    font-size: 11px;
    padding: 2px 7px;
  }
  .discovery-chip code {
    font-family: var(--mono);
    color: var(--text-faint);
    margin-right: 4px;
  }
  .product-use-contract {
    margin-top: 12px;
    border: 1px solid var(--rule-light);
    border-radius: 5px;
    background: var(--bg-soft);
    padding: 9px 10px;
  }
  .product-use-title {
    color: var(--text-faint);
    font-family: var(--mono);
    font-size: 10px;
    letter-spacing: 0.06em;
    text-transform: uppercase;
  }
  .product-use-loop {
    margin-top: 4px;
    color: var(--text);
    font-weight: 600;
    max-width: 900px;
  }
  .product-use-details {
    margin-top: 6px;
  }
  .product-use-details > summary {
    cursor: pointer;
    color: var(--link);
    font-family: var(--mono);
    font-size: 11px;
  }
  .product-use-meta {
    margin-top: 4px;
    color: var(--text-dim);
    line-height: 1.45;
  }
  .product-use-meta span {
    color: var(--text-faint);
    font-family: var(--mono);
    font-size: 10px;
    text-transform: uppercase;
    letter-spacing: 0.05em;
    margin-right: 6px;
  }
  .product-use-jobs {
    display: grid;
    gap: 6px;
    margin-top: 8px;
  }
  .product-use-jobs-details {
    margin-top: 8px;
  }
  .product-use-jobs-details > summary {
    cursor: pointer;
    color: var(--link);
    font-family: var(--mono);
    font-size: 11px;
  }
  .product-use-job {
    border-top: 1px solid var(--rule-light);
    padding-top: 6px;
  }
  .product-use-job:first-child {
    border-top: none;
    padding-top: 0;
  }
  .product-use-job > div:first-child {
    display: flex;
    align-items: center;
    gap: 6px;
    flex-wrap: wrap;
  }
  .product-use-job strong {
    color: var(--text);
  }
  .product-use-job span {
    color: var(--text-faint);
    font-family: var(--mono);
    font-size: 10px;
    text-transform: uppercase;
    letter-spacing: 0.05em;
    margin-right: 5px;
  }
  .discovery-map {
    margin-top: 0;
    border: 1px solid var(--rule-light);
    border-radius: 5px;
    background: #fff;
    padding: 8px;
  }
  .discovery-map-title,
  .discovery-deferred-label {
    color: var(--text-faint);
    font-family: var(--mono);
    font-size: 10px;
    letter-spacing: 0.06em;
    text-transform: uppercase;
  }
  .discovery-map-row {
    display: grid;
    grid-template-columns: minmax(170px, 0.8fr) minmax(220px, 1fr) minmax(260px, 1.35fr);
    gap: 10px;
    padding: 8px 0;
    border-top: 1px solid var(--rule-light);
  }
  .discovery-map-row:first-of-type {
    margin-top: 6px;
  }
  .discovery-map-field-label {
    display: block;
    color: var(--text-faint);
    font-family: var(--mono);
    font-size: 10px;
    letter-spacing: 0.05em;
    text-transform: uppercase;
    margin-bottom: 4px;
  }
  .discovery-map-field .discovery-chip-list {
    margin-top: 0;
  }
  .discovery-deferred {
    margin-top: 8px;
    display: flex;
    align-items: baseline;
    gap: 8px;
    flex-wrap: wrap;
  }
  .discovery-deferred .discovery-chip-list {
    margin-top: 0;
  }
  @media (max-width: 760px) {
    .discovery-map-row { grid-template-columns: 1fr; }
  }
  .discovery-rationale {
    margin-top: 8px;
    line-height: 1.45;
  }
  .discovery-rationale span {
    color: var(--text);
    font-weight: 600;
  }
  .discovery-inventory {
    margin-top: 8px;
  }
  .discovery-inventory summary {
    cursor: pointer;
    color: var(--link);
    font-family: var(--mono);
    font-size: 11px;
  }
  .goal-proof-details {
    margin-top: 7px;
    font-size: 12px;
    color: var(--text-dim);
  }
  .goal-proof-details > summary {
    cursor: pointer;
    color: var(--link);
    font-family: var(--mono);
    font-size: 11px;
  }
  .goal-proof-details ul {
    margin: 6px 0 0;
    padding-left: 18px;
  }
  .goal-proof-actions {
    display: flex;
    align-items: center;
    gap: 8px;
    flex-wrap: wrap;
    margin-top: 8px;
  }
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
  .ev-chip-missing {
    color: #8a5a00;
    background: #fffaf0;
  }
  .ev-chip-missing:hover {
    background: #fffaf0;
    color: #8a5a00;
    border-color: var(--rule-light);
  }
  .ev-chip .ev-kind {
    color: var(--text-faint);
    margin-right: 4px;
  }
  .ev-chip:hover .ev-kind { color: rgba(255,255,255,0.7); }

  /* Video */
  .video-section {
    margin-top: 0;
    overflow: visible;
  }
  .video-section video {
    display: block;
    width: 100%;
    max-height: 420px;
    background: #000;
    border: 1px solid var(--rule);
    border-radius: 4px;
  }
  .raw-video-grid {
    display: grid;
    grid-template-columns: repeat(auto-fit, minmax(260px, 1fr));
    gap: 12px;
    padding: 0 14px 14px;
  }
  .raw-video-scroll {
    max-height: min(72vh, 760px);
    overflow-y: auto;
    overscroll-behavior: contain;
    padding-top: 4px;
  }
  .raw-video-card .caption {
    font-size: 12px;
    color: var(--text-dim);
    margin-top: 4px;
    display: flex;
    justify-content: space-between;
    gap: 10px;
  }
  .video-note {
    color: var(--text-dim);
    font-size: 13px;
    margin: 0;
    padding: 0 14px 10px;
  }
  .seek-list { margin: 10px 14px 14px; }
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

  /* Screenshot walkthrough */
  .walkthrough-section {
    margin-top: 0;
  }
  .walkthrough-section .section-head {
    margin-bottom: 10px;
  }
  .walkthrough-strip {
    display: flex;
    gap: 10px;
    overflow-x: auto;
    padding: 2px 14px 14px;
    scroll-snap-type: x proximity;
  }
  .walkthrough-frame {
    flex: 0 0 250px;
    border: 1px solid var(--rule-light);
    border-radius: 6px;
    overflow: hidden;
    background: #fff;
    scroll-snap-align: start;
    color: inherit;
    text-decoration: none;
  }
  .walkthrough-frame:hover { border-color: var(--link); }
  .walkthrough-frame img {
    display: block;
    width: 100%;
    aspect-ratio: 16 / 9;
    object-fit: cover;
    object-position: top center;
    background: var(--bg-soft);
  }
  .walkthrough-caption {
    padding: 8px 9px;
    border-top: 1px solid var(--rule-light);
  }
  .walkthrough-caption .step {
    font-family: var(--mono);
    font-size: 10px;
    color: var(--text-faint);
    margin-bottom: 2px;
  }
  .walkthrough-caption .title {
    font-size: 12px;
    line-height: 1.35;
    color: var(--text-dim);
  }

  /* Score matrix */
  .score-section {
    margin-top: 28px;
  }
  .section-head {
    display: flex;
    justify-content: space-between;
    align-items: flex-start;
    gap: 20px;
    margin-bottom: 12px;
  }
  .section-head h2 { margin-bottom: 4px; }
  .section-head p {
    margin: 0;
    color: var(--text-dim);
    font-size: 13px;
    max-width: 680px;
  }
  .overall-mini {
    font-family: var(--mono);
    font-weight: 700;
    font-size: 24px;
    line-height: 1;
    white-space: nowrap;
  }
  .overall-mini span {
    color: var(--text-faint);
    font-size: 13px;
    margin-left: 2px;
  }
  .profile-strip {
    display: grid;
    grid-template-columns: repeat(auto-fit, minmax(136px, 1fr));
    gap: 8px;
    margin-bottom: 10px;
  }
  .profile-score {
    border: 1px solid var(--rule-light);
    border-radius: 6px;
    padding: 8px 10px;
    background: #fff;
    display: flex;
    justify-content: space-between;
    gap: 10px;
    align-items: baseline;
  }
  .profile-score span {
    color: var(--text-dim);
    font-size: 12px;
    text-transform: capitalize;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  .profile-score strong {
    font-family: var(--mono);
    font-size: 14px;
  }
  .profile-score.is-missing { background: var(--bg-soft); }
  .score-value {
    display: inline-flex;
    align-items: center;
    width: fit-content;
    border: 1px solid var(--rule-light);
    border-radius: 999px;
    padding: 1px 7px;
    font-family: var(--mono);
    font-weight: 700;
    line-height: 1.35;
  }
  .score-value.score-high {
    color: var(--status-pass);
    background: #dafbe1;
    border-color: #aceebb;
  }
  .score-value.score-mid {
    color: var(--status-partial);
    background: #fff8c5;
    border-color: #eed888;
  }
  .score-value.score-low {
    color: var(--status-fail);
    background: #ffebe9;
    border-color: #ffcecb;
  }
  .score-value.score-none {
    color: var(--text-faint);
    background: var(--bg-soft);
    border-color: var(--rule-light);
  }
  .score-profile-grid {
    display: grid;
    gap: 12px;
  }
  .score-profile-card {
    border: 1px solid var(--rule-light);
    border-radius: 6px;
    background: #fff;
    overflow: hidden;
  }
  .score-profile-head {
    display: flex;
    align-items: baseline;
    justify-content: space-between;
    gap: 12px;
    padding: 10px 12px;
    background: var(--bg-soft);
    border-bottom: 1px solid var(--rule-light);
  }
  .score-profile-head h3 {
    margin: 0;
    font-size: 15px;
    text-transform: capitalize;
  }
  .score-profile-head strong {
    font-family: var(--mono);
    font-size: 16px;
  }
  .score-dimension-list {
    display: grid;
  }
  .score-dimension {
    display: grid;
    grid-template-columns: minmax(160px, 0.55fr) minmax(0, 1fr);
    gap: 12px;
    padding: 10px 12px;
    border-top: 1px solid var(--rule-light);
  }
  .score-dimension:first-child {
    border-top: none;
  }
  .score-dimension.is-missing {
    background: #fbfcfd;
  }
  .score-dimension-title {
    display: flex;
    align-items: baseline;
    justify-content: space-between;
    gap: 10px;
    min-width: 0;
  }
  .score-dimension-title span {
    font-weight: 600;
  }
  .score-dimension-title strong,
  .score-dimension-title .score-na {
    font-family: var(--mono);
    white-space: nowrap;
  }
  .score-dimension-rationale {
    color: var(--text-dim);
    font-size: 13px;
    line-height: 1.45;
  }
  @media (max-width: 760px) {
    .score-dimension {
      grid-template-columns: 1fr;
    }
  }
  .matrix-wrap {
    overflow-x: auto;
    border: 1px solid var(--rule-light);
    border-radius: 6px;
  }
  .score-matrix {
    width: 100%;
    min-width: 720px;
    border-collapse: collapse;
    font-size: 13px;
  }
  .score-matrix th {
    background: var(--bg-soft);
    color: var(--text-dim);
    font-family: var(--mono);
    font-size: 10px;
    letter-spacing: 0.05em;
    text-transform: uppercase;
    text-align: left;
    padding: 8px 10px;
    border-bottom: 1px solid var(--rule-light);
  }
  .score-matrix td {
    padding: 9px 10px;
    vertical-align: top;
    border-bottom: 1px solid var(--rule-light);
  }
  .score-matrix tr:last-child td { border-bottom: none; }
  .score-matrix td:nth-child(1),
  .score-matrix td:nth-child(3) {
    font-family: var(--mono);
    font-weight: 500;
  }
  .score-matrix td:nth-child(1) {
    width: 150px;
    color: var(--text-dim);
  }
  .score-matrix td:nth-child(2) {
    width: 190px;
    text-transform: capitalize;
  }
  .score-matrix td:nth-child(3) {
    width: 72px;
  }
  .score-row.missing td {
    color: var(--text-dim);
    background: #fbfcfd;
  }
  .score-na {
    font-family: var(--mono);
    color: var(--text-faint);
  }
  .matrix-evidence {
    margin-top: 5px;
  }
  .matrix-evidence > summary {
    cursor: pointer;
    color: var(--link);
    font-family: var(--mono);
    font-size: 10px;
  }
  .matrix-evidence-list {
    display: flex;
    flex-wrap: wrap;
    gap: 4px;
    margin-top: 4px;
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

  /* Cited source events */
  .trace-events { padding: 0 14px 14px; border-top: 1px solid var(--rule-light); font-family: var(--mono); font-size: 12px; }
  .cited-events {
    max-height: min(56vh, 520px);
    overflow-y: auto;
    border: 1px solid var(--rule-light);
    border-radius: 4px;
    padding: 0 10px 10px;
  }
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
    .audit-section > summary, .debug-panel > summary { display: none; }
    video { display: none; }
  }

  @media (max-width: 760px) {
    .section-head {
      display: block;
    }
    .overall-mini {
      margin-top: 8px;
    }
    .goal-proof-group-head {
      align-items: flex-start;
      flex-direction: column;
    }
    .goal-proof-group-meta {
      justify-content: flex-start;
    }
    .goal-proof-row {
      grid-template-columns: 1fr;
      gap: 12px;
      padding: 12px;
    }
    .goal-proof-media {
      width: 100%;
    }
    .goal-proof-media img,
    .goal-proof-media video {
      max-height: 260px;
    }
    .score-dimension {
      grid-template-columns: 1fr;
      gap: 4px;
    }
    .score-profile-head {
      align-items: flex-start;
    }
    .profile-strip {
      grid-template-columns: repeat(2, minmax(0, 1fr));
    }
  }

  @media (max-width: 440px) {
    .profile-strip {
      grid-template-columns: 1fr;
    }
    .goal-proof-title {
      flex-basis: 100%;
    }
  }
`;

const REPORT_SCRIPT = `<script>
(() => {
  const videos = Array.from(document.querySelectorAll('video.raw-recording'));
  for (const v of videos) {
    v.addEventListener('loadedmetadata', () => { v.playbackRate = 2.0; }, { once: true });
  }
  const openHashTarget = () => {
    if (!window.location.hash) return;
    const id = window.location.hash.slice(1);
    if (!id) return;
    const target = document.getElementById(id);
    if (!target) return;
    for (let el = target.parentElement; el; el = el.parentElement) {
      if (el.tagName === 'DETAILS') el.setAttribute('open', '');
    }
    target.scrollIntoView({ block: 'center' });
  };
  window.addEventListener('hashchange', openHashTarget);
  openHashTarget();
})();
</script>`;

// ===========================================================================
// Section renderers
// ===========================================================================

function renderHeader(report: ReportJson): string {
  const cost = report.run.cost_usd > 0.005 ? `<span>$${report.run.cost_usd.toFixed(2)}</span>` : '';
  return `<header>
    <h1>${escapeHtml(targetDisplay(report.run.target.url))}</h1>
    <div class="meta-strip">
      <span>${escapeHtml(new Date(report.run.started_at).toLocaleString())}</span>
      <span>${escapeHtml(report.run.mode)} mode</span>
      <span>${formatDuration(report.run.duration_s)}</span>
      ${cost}
      <span>${report.run.step_count} recorded steps</span>
      <span>ended: ${escapeHtml(report.run.termination)}</span>
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

function displayName(value: string): string {
  return value.replace(/[_-]/g, ' ');
}

function renderTLDR(report: ReportJson, eventIndex: Map<string, TraceEvent>): string {
  const counts = goalCounts(report, eventIndex);
  const totalFindings = totalFindingCount(report);
  const scoreCompleteness = scoreCompletenessSummary(report.scores);
  const toneClass = overviewTone(report, counts);
  const verdict = verdictLabel(report, counts);
  const summary = overviewSummary(report, counts);
  const evidenceLine = renderEvidenceIntegrity(report);
  const scoreWarning = renderScoreCompletenessWarning(scoreCompleteness);
  const usage = report.run.usage?.total;
  const nonCachedTokens =
    usage?.non_cached_input_tokens ??
    (usage ? Math.max(0, usage.input_tokens - (usage.cached_input_tokens ?? 0)) : undefined);

  return `<section class="report-hero tldr ${toneClass}">
    <div class="hero-main">
      <div>
        <div class="eyebrow">Verdict</div>
        <h2>${escapeHtml(verdict)}</h2>
        <p>${escapeHtml(summary)}</p>
      </div>
      <div class="score-badge" aria-label="Overall score ${report.headline.score.toFixed(1)} out of 10">
        <span>${report.headline.score.toFixed(1)}</span>
        <small>/10</small>
      </div>
    </div>
    <div class="metric-grid">
      ${renderMetric('Tested goals', counts.total > 0 ? `${counts.sat}/${counts.total}` : 'n/a', counts.total > 0 ? goalMetricCaption(counts) : 'no scenario goals')}
      ${renderMetric('Findings', totalFindings === 0 ? '0' : String(totalFindings), findingsMetricCaption(report))}
      ${renderMetric('Runtime', formatDuration(report.run.duration_s), `${report.run.step_count} recorded steps`)}
      ${renderMetric('Rubric', `${scoreCompleteness.scoredProfiles}/${scoreCompleteness.requestedProfiles}`, scoreCompleteness.caption)}
      ${renderMetric('Run ended', report.run.termination, report.run.mode)}
      ${
        usage
          ? renderMetric(
              'Tokens',
              formatCompactInteger(nonCachedTokens ?? usage.input_tokens),
              `${formatCompactInteger(usage.input_tokens)} input, ${formatCompactInteger(usage.output_tokens)} output`,
            )
          : ''
      }
    </div>
    ${renderRunMetadata(report)}
    ${scoreWarning}
    ${evidenceLine}
  </section>`;
}

function renderRunMetadata(report: ReportJson): string {
  const transport = report.run.transport ?? 'not recorded';
  const phaseRows: Array<{ label: string; model: string | undefined; effort: string | undefined }> =
    [
      {
        label: 'Discovery',
        model: report.run.models.discovery ?? report.run.models.explorer,
        effort: report.run.reasoning_efforts?.discovery,
      },
      {
        label: 'Explorer',
        model: report.run.models.explorer,
        effort: report.run.reasoning_efforts?.explorer,
      },
      {
        label: 'Judge',
        model: report.run.models.judge,
        effort: report.run.reasoning_efforts?.judge,
      },
    ];
  const items = [
    renderRunMetaItem('Transport', transport, report.run.mode),
    ...phaseRows.map((phase) =>
      renderRunMetaItem(
        phase.label,
        phase.model ?? 'not recorded',
        `effort ${phase.effort ?? 'not recorded'}`,
      ),
    ),
  ];
  return `<div class="run-meta-panel" aria-label="Run metadata">
    <span class="run-meta-title">Run metadata</span>
    <div class="run-meta-grid">
      ${items.join('')}
    </div>
  </div>`;
}

function renderRunMetaItem(label: string, value: string, caption: string): string {
  return `<div class="run-meta-item">
    <span>${escapeHtml(label)}</span>
    <strong title="${escapeAttr(value)}">${escapeHtml(value)}</strong>
    <em title="${escapeAttr(caption)}">${escapeHtml(caption)}</em>
  </div>`;
}

interface GoalCounts {
  sat: number;
  par: number;
  neg: number;
  skipped: number;
  untested: number;
  total: number;
}

function goalCounts(report: ReportJson, eventIndex: Map<string, TraceEvent>): GoalCounts {
  const effective = report.spec_compliance.applicable
    ? report.spec_compliance.goals.map((g) => effectiveGoalStatus(g, eventIndex))
    : [];
  return {
    sat: effective.filter((s) => s === 'verified' || s === 'satisfied').length,
    par: effective.filter((s) => s === 'partial').length,
    neg: effective.filter((s) => s === 'blocked' || s === 'not_satisfied').length,
    skipped: effective.filter((s) => s === 'skipped').length,
    untested: effective.filter((s) => s === 'untested').length,
    total: effective.length,
  };
}

function overviewTone(report: ReportJson, counts: GoalCounts): string {
  const scoreCompleteness = scoreCompletenessSummary(report.scores);
  if (!scoreCompleteness.complete) return 'partial';
  if (
    report.headline.threshold_passed &&
    report.headline.blockers === 0 &&
    report.headline.majors === 0 &&
    (counts.total === 0 || counts.sat === counts.total)
  ) {
    return 'pass';
  }
  if (report.headline.blockers > 0 || !report.headline.threshold_passed) return 'fail';
  return 'partial';
}

function verdictLabel(report: ReportJson, counts: GoalCounts): string {
  const scoreCompleteness = scoreCompletenessSummary(report.scores);
  if (!scoreCompleteness.complete) return 'Incomplete score report';
  if (report.headline.blockers > 0) return 'Blocked by critical findings';
  if (!report.headline.threshold_passed) return 'Needs work';
  if (report.headline.majors > 0) return 'Passes with major findings';
  if (counts.total > 0 && counts.sat < counts.total) return 'Partially verified';
  return 'Passes current checks';
}

function overviewSummary(report: ReportJson, counts: GoalCounts): string {
  const parts: string[] = [];
  const scoreCompleteness = scoreCompletenessSummary(report.scores);
  if (counts.total > 0) {
    parts.push(`${counts.sat} of ${counts.total} goals verified`);
    if (counts.par > 0) parts.push(`${counts.par} partial`);
    if (counts.neg > 0) parts.push(`${counts.neg} broken`);
    if (counts.untested > 0) parts.push(`${counts.untested} untested`);
  } else {
    parts.push('No explicit goals were supplied');
  }
  const findingText = findingsMetricCaption(report);
  if (findingText !== 'none') parts.push(findingText);
  if (!scoreCompleteness.complete) parts.push(scoreCompleteness.warningText);
  if (report.run.termination !== 'done' && report.run.termination !== 'goals_complete') {
    parts.push(`ended as ${report.run.termination}`);
  }
  return `${parts.join('; ')}.`;
}

interface ScoreCompletenessSummary {
  requestedProfiles: number;
  scoredProfiles: number;
  missingProfiles: string[];
  unscoredProfiles: string[];
  complete: boolean;
  caption: string;
  warningText: string;
}

function scoreCompletenessSummary(scores: JudgeOutput['scores']): ScoreCompletenessSummary {
  const requested =
    scores.overall.weighted_from.length > 0
      ? scores.overall.weighted_from
      : Object.keys(scores.profiles);
  const uniqueRequested = Array.from(new Set(requested));
  const missingProfiles = uniqueRequested.filter((name) => !scores.profiles[name]);
  const unscoredProfiles = uniqueRequested.filter((name) => {
    const profile = scores.profiles[name];
    if (!profile) return false;
    const dimensions = Object.values(profile.dimensions);
    return dimensions.length > 0 && dimensions.every((dimension) => dimension.score === null);
  });
  const scoredProfiles = uniqueRequested.length - missingProfiles.length - unscoredProfiles.length;
  const missingCount = missingProfiles.length + unscoredProfiles.length;
  const complete = missingCount === 0;
  return {
    requestedProfiles: uniqueRequested.length,
    scoredProfiles,
    missingProfiles,
    unscoredProfiles,
    complete,
    caption: complete ? 'complete' : `${missingCount} missing`,
    warningText: complete
      ? ''
      : `${missingCount} requested rubric profile${missingCount === 1 ? '' : 's'} missing or unscored`,
  };
}

function renderScoreCompletenessWarning(summary: ScoreCompletenessSummary): string {
  if (summary.complete) return '';
  const missing = [...summary.missingProfiles, ...summary.unscoredProfiles];
  return `<div class="score-warning">
    <strong>Score is incomplete.</strong>
    <span>The reported overall score is not authoritative because ${escapeHtml(summary.warningText)}: ${escapeHtml(missing.join(', '))}.</span>
  </div>`;
}

function renderMetric(label: string, value: string, caption: string): string {
  return `<div class="metric">
    <span>${escapeHtml(label)}</span>
    <strong title="${escapeAttr(value)}">${escapeHtml(value)}</strong>
    <em>${escapeHtml(caption)}</em>
  </div>`;
}

function goalMetricCaption(counts: GoalCounts): string {
  const parts: string[] = [];
  if (counts.par > 0) parts.push(`${counts.par} partial`);
  if (counts.neg > 0) parts.push(`${counts.neg} broken`);
  if (counts.untested > 0) parts.push(`${counts.untested} untested`);
  if (counts.skipped > 0) parts.push(`${counts.skipped} skipped`);
  return parts.length > 0 ? parts.join(', ') : 'scenario checks';
}

function findingsMetricCaption(report: ReportJson): string {
  const parts: string[] = [];
  if (report.headline.blockers > 0)
    parts.push(`${report.headline.blockers} blocker${report.headline.blockers === 1 ? '' : 's'}`);
  if (report.headline.majors > 0)
    parts.push(`${report.headline.majors} major${report.headline.majors === 1 ? '' : 's'}`);
  if (report.headline.minors > 0)
    parts.push(`${report.headline.minors} minor${report.headline.minors === 1 ? '' : 's'}`);
  if (report.headline.nits > 0)
    parts.push(`${report.headline.nits} nit${report.headline.nits === 1 ? '' : 's'}`);
  if (report.headline.suggestions > 0)
    parts.push(
      `${report.headline.suggestions} suggestion${report.headline.suggestions === 1 ? '' : 's'}`,
    );
  return parts.length > 0 ? parts.join(', ') : 'none';
}

function totalFindingCount(report: ReportJson): number {
  return (
    report.headline.blockers +
    report.headline.majors +
    report.headline.minors +
    report.headline.nits +
    report.headline.suggestions
  );
}

function renderEvidenceIntegrity(report: ReportJson): string {
  const lines: string[] = [];
  const ev = report.evidence_validation;
  if (ev && ev.verified + ev.downgraded + ev.discarded > 0) {
    const kept = ev.verified + ev.downgraded;
    if (kept === 0) {
      if (ev.discarded > 0) lines.push(`${ev.discarded} unsupported finding drafts discarded`);
    } else {
      const parts = [`${ev.verified} evidence-backed finding${ev.verified === 1 ? '' : 's'}`];
      if (ev.downgraded > 0) parts.push(`${ev.downgraded} downgraded`);
      if (ev.discarded > 0) parts.push(`${ev.discarded} unsupported drafts discarded`);
      lines.push(parts.join(', '));
    }
  }
  const gcv = report.spec_compliance?.goal_claim_validation;
  if (gcv && gcv.verified_kept + gcv.downgraded > 0) {
    const parts = [
      `${gcv.verified_kept} goal-evidence claim${gcv.verified_kept === 1 ? '' : 's'} verified`,
    ];
    if (gcv.downgraded > 0) parts.push(`${gcv.downgraded} downgraded`);
    lines.push(parts.join(', '));
  }
  if (lines.length === 0) return '';
  return `<div class="integrity-strip"><span class="integrity-label">Evidence audit</span>${lines.map((line) => `<span>${escapeHtml(line)}</span>`).join('')}</div>`;
}

function renderAccessBlocks(report: ReportJson): string {
  const blocks = report.access_blocks ?? [];
  if (blocks.length === 0) return '';
  const items = blocks
    .map((b) => {
      const kindLabel = b.kind.replace(/_/g, ' ');
      return `<li>
        <div class="access-block-row">
          <span class="access-block-kind">${escapeHtml(kindLabel)}</span>
          <code>${escapeHtml(b.surface)}</code>
        </div>
        <div class="access-block-desc">${escapeHtml(b.description)}</div>
      </li>`;
    })
    .join('');
  return `<section class="access-blocks-section">
    <h2>Iris was blocked from accessing parts of this app</h2>
    <p style="color: var(--text-dim); font-size: 13px; margin-top: -4px;">
      These are not product defects — a real user with a real browser
      typically gets past them. Listed separately so they don't pollute
      the score or finding count.
    </p>
    <ul class="access-blocks-list">${items}</ul>
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

function goalStatusLabel(status: string): string {
  switch (status) {
    case 'verified':
    case 'satisfied':
      return 'verified';
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

function goalStatusClass(status: string): string {
  if (status === 'mixed') return 'status-mixed';
  if (status === 'neutral') return 'status-neutral';
  switch (goalStatusLabel(status)) {
    case 'verified':
      return 'status-verified';
    case 'partial':
      return 'status-partial';
    case 'broken':
      return 'status-broken';
    case 'skipped':
      return 'status-skipped';
    case 'untested':
      return 'status-untested';
    default:
      return status === 'mixed' ? 'status-mixed' : 'status-neutral';
  }
}

function renderStatusPill(status: string, label = goalStatusLabel(status)): string {
  const displayLabel = status === 'mixed' && label === goalStatusLabel(status) ? 'mixed' : label;
  return `<span class="status-pill ${escapeAttr(goalStatusClass(status))}">${escapeHtml(displayLabel)}</span>`;
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

function buildGoalFindingLinks(
  report: ReportJson,
  eventIndex: Map<string, TraceEvent>,
): GoalFindingLinks {
  const byGoalId = new Map<string, FindingGoalLink[]>();
  const byFindingId = new Map<string, FindingGoalLink[]>();
  if (!report.spec_compliance.applicable || eventIndex.size === 0) {
    return { byGoalId, byFindingId };
  }
  const goalEvidence = report.spec_compliance.goals.map((goal) => ({
    goal,
    ids: new Set(resolveEvidenceEventIds(goal.evidence, eventIndex)),
  }));
  for (const finding of report.findings) {
    const findingIds = new Set(resolveEvidenceEventIds(finding.evidence, eventIndex));
    if (findingIds.size === 0) continue;
    for (const { goal, ids: goalIds } of goalEvidence) {
      if (goalIds.size === 0) continue;
      const overlap = Array.from(findingIds).filter((id) => goalIds.has(id)).length;
      const minSize = Math.min(findingIds.size, goalIds.size);
      if (overlap < 2 && !(overlap === 1 && minSize <= 2)) continue;
      const effectiveStatus = goalStatusLabel(effectiveGoalStatus(goal, eventIndex));
      const link: FindingGoalLink = {
        findingId: finding.id,
        findingTitle: finding.title,
        severity: finding.severity,
        goalId: goal.id,
        goalStatus: effectiveStatus,
      };
      const goalLinks = byGoalId.get(goal.id) ?? [];
      goalLinks.push(link);
      byGoalId.set(goal.id, goalLinks);
      const findingLinks = byFindingId.get(finding.id) ?? [];
      findingLinks.push(link);
      byFindingId.set(finding.id, findingLinks);
    }
  }
  return { byGoalId, byFindingId };
}

// Findings list
function renderFindingsSection(
  findings: JudgeOutput['findings'],
  eventIndex: Map<string, TraceEvent>,
  screenshotForEvent: Map<string, string>,
  orderedEvents: TraceEvent[],
  clipsByFindingId: Record<string, string>,
  goalFindingLinks: GoalFindingLinks,
): string {
  if (findings.length === 0) return '';
  const order: Record<string, number> = { blocker: 0, major: 1, minor: 2, nit: 3, suggestion: 4 };
  const sorted = [...findings].sort(
    (a, b) => (order[a.severity] ?? 99) - (order[b.severity] ?? 99),
  );
  const items = sorted
    .map((f, i) =>
      renderFinding(
        f,
        i + 1,
        eventIndex,
        screenshotForEvent,
        orderedEvents,
        clipsByFindingId,
        goalFindingLinks.byFindingId.get(f.id) ?? [],
      ),
    )
    .join('');
  return `<section>
    <h2>Findings (${findings.length})</h2>
    <p style="color: var(--text-dim); font-size: 13px; margin-top: -6px;">Findings that explain a tested goal reuse that goal's evidence instead of replaying duplicate clips.</p>
    <ul class="findings-list">${items}</ul>
  </section>`;
}

interface FindingGoalLink {
  findingId: string;
  findingTitle: string;
  severity: string;
  goalId: string;
  goalStatus: string;
}

interface GoalFindingLinks {
  byGoalId: Map<string, FindingGoalLink[]>;
  byFindingId: Map<string, FindingGoalLink[]>;
}

interface VisualEvidenceCard {
  key: string;
  claim: string;
  primaryGoalId: string;
  status?: string;
  title: string;
  context: string;
  details?: string[];
  origin?: DiscoveryGoalOrigin;
  screenshotPath?: string;
  clipPath?: string;
  sharedClip?: boolean;
  eventId?: string;
  groupKey: string;
  groupLabel: string;
  goalCount: number;
  linkedFindings?: FindingGoalLink[];
}

function renderGoalEvidenceSection(
  report: ReportJson,
  eventIndex: Map<string, TraceEvent>,
  screenshotForEvent: Map<string, string>,
  clipPaths: Record<string, string>,
  goalFindingLinks: GoalFindingLinks,
): string {
  if (!report.spec_compliance.applicable || report.spec_compliance.goals.length === 0) return '';
  const counts = goalCounts(report, eventIndex);
  const cards = buildGoalEvidenceCards(
    report,
    eventIndex,
    screenshotForEvent,
    clipPaths,
    goalFindingLinks,
  );
  if (cards.length === 0) return '';
  const groups = groupGoalEvidenceCards(cards);
  return `<section class="goal-review">
    <div class="section-head">
      <div class="goal-review-overview">
        <div class="goal-review-topline">
          <div>
            <h2>Tested goals &amp; evidence</h2>
            <p>Each card pairs a real-use goal with the screenshot or clip Iris used to verify it.</p>
          </div>
          ${renderGoalReviewStats(counts, cards.length)}
        </div>
        ${renderGoalReviewFacts(report, counts)}
        ${renderProductUseContract(report)}
      </div>
    </div>
    <div class="goal-proof-groups">
      ${groups.map((group) => renderGoalEvidenceGroup(group)).join('')}
    </div>
    ${renderDiscoveryCoverageSummary(report)}
  </section>`;
}

function renderGoalReviewStats(counts: GoalCounts, proofRowCount: number): string {
  const chips = [
    renderStatusPill('verified', `${counts.sat}/${counts.total} verified`),
    counts.par > 0 ? renderStatusPill('partial', `${counts.par} partial`) : '',
    counts.neg > 0 ? renderStatusPill('blocked', `${counts.neg} broken`) : '',
    counts.untested > 0 ? renderStatusPill('untested', `${counts.untested} untested`) : '',
    counts.skipped > 0 ? renderStatusPill('skipped', `${counts.skipped} skipped`) : '',
    proofRowCount === counts.total
      ? ''
      : renderStatusPill('neutral', `${proofRowCount} proof rows after dedupe`),
  ].filter(Boolean);
  return `<div class="goal-review-stats">${chips.join('')}</div>`;
}

function renderGoalReviewFacts(report: ReportJson, counts: GoalCounts): string {
  const discovery = report.discovery;
  const surfaceCount = discovery?.surfaces?.length ?? 0;
  const journeyCount = discovery?.journeys?.length ?? 0;
  const coveragePlan = discovery?.coverage_plan;
  const risk = coveragePlan?.coverage_risk ?? 'not recorded';
  const deferredCount = coveragePlan?.deferred_surface_ids.length ?? 0;
  const coverageText =
    surfaceCount > 0 && journeyCount > 0
      ? `${surfaceCount} surfaces, ${journeyCount} journeys`
      : surfaceCount > 0
        ? `${surfaceCount} surfaces`
        : 'not recorded';
  return `<div class="goal-review-facts">
    <div class="goal-review-fact"><span>Goal outcome</span><strong>${escapeHtml(`${counts.sat}/${counts.total} verified${counts.par > 0 ? `, ${counts.par} partial` : ''}`)}</strong></div>
    <div class="goal-review-fact"><span>Discovery coverage</span><strong>${escapeHtml(coverageText)}</strong></div>
    <div class="goal-review-fact"><span>Coverage risk</span><strong>${escapeHtml(`${risk}${deferredCount > 0 ? `, ${deferredCount} deferred` : ''}`)}</strong></div>
  </div>`;
}

function renderDiscoveryCoverageSummary(report: ReportJson): string {
  const discovery = report.discovery;
  if (!discovery) return '';
  const surfaceCount = discovery.surfaces?.length ?? 0;
  const journeyCount = discovery.journeys?.length ?? 0;
  const generatedGoalCount = discovery.goals?.length ?? 0;
  const coveragePlan = discovery.coverage_plan;
  const selectedJourneyIds = coveragePlan?.selected_journey_ids ?? [];
  const surfaceCoverage = surfaceCoverageForJourneys(
    selectedJourneyIds,
    discovery.journeys ?? [],
    discovery.surfaces ?? [],
  );
  const deferredCount = coveragePlan?.deferred_surface_ids.length ?? 0;
  const risk = coveragePlan?.coverage_risk;
  const rationale = coveragePlan?.rationale;
  if (surfaceCount === 0 && journeyCount === 0 && deferredCount === 0 && !rationale) return '';
  const parts = [
    surfaceCount > 0 && journeyCount > 0
      ? `${surfaceCount} surfaces -> ${journeyCount} journeys -> ${generatedGoalCount || report.spec_compliance.goals.length} goals`
      : surfaceCount > 0
        ? `${surfaceCount} surfaces discovered`
        : '',
    surfaceCount > 0 && surfaceCoverage.covered.size > 0
      ? surfaceCoverage.context.size > 0
        ? `${surfaceCoverage.covered.size}/${surfaceCount} surfaces covered (${surfaceCoverage.direct.size} direct, ${surfaceCoverage.context.size} page context)`
        : `${surfaceCoverage.covered.size}/${surfaceCount} surfaces covered`
      : '',
    deferredCount > 0 ? `${deferredCount} surfaces deferred` : '',
    risk ? `coverage risk: ${risk}` : '',
  ].filter(Boolean);
  const selected = formatDiscoveryJourneyRefs(selectedJourneyIds, discovery.journeys ?? []);
  const deferred = formatDiscoverySurfaceRefs(
    coveragePlan?.deferred_surface_ids ?? [],
    discovery.surfaces ?? [],
  );
  const surfaceInventory = formatDiscoverySurfaceRefs(
    (discovery.surfaces ?? []).map((surface) => surface.id),
    discovery.surfaces ?? [],
    Number.POSITIVE_INFINITY,
  );
  return `<details class="discovery-summary">
    <summary>
      <span class="discovery-summary-title">Discovery v2 coverage plan</span>
      <span class="discovery-summary-meta">${escapeHtml(parts.join(' · '))}</span>
    </summary>
    <div class="discovery-summary-body">
    ${renderDiscoveryCoverageMap(report, selectedJourneyIds, selected)}
    <div class="discovery-deferred">
      <span class="discovery-deferred-label">Deferred surfaces</span>
      ${deferred ? renderDiscoveryChips(deferred) : '<div class="discovery-chip-list"><span class="discovery-chip">None</span></div>'}
    </div>
    ${rationale ? `<div class="discovery-rationale"><span>Why:</span> ${escapeHtml(rationale)}</div>` : ''}
    ${
      surfaceInventory.length > 0
        ? `<details class="discovery-inventory"><summary>${escapeHtml(`Surface inventory (${surfaceInventory.length})`)}</summary>${renderDiscoveryChips(surfaceInventory)}</details>`
        : ''
    }
    </div>
  </details>`;
}

function renderProductUseContract(report: ReportJson): string {
  const contract = report.discovery?.product_use_contract;
  if (!contract) return '';
  const generatedGoals = report.discovery?.goals ?? [];
  const reportGoalsById = new Map(report.spec_compliance.goals.map((goal) => [goal.id, goal]));
  const goalByJourney = new Map<string, NonNullable<ReportJson['discovery']>['goals']>();
  for (const goal of generatedGoals) {
    if (!goal.journey_id) continue;
    const existing = goalByJourney.get(goal.journey_id) ?? [];
    existing.push(goal);
    goalByJourney.set(goal.journey_id, existing);
  }
  const jobs = (contract.user_jobs ?? []).slice(0, 5).map((job) => {
    const linkedGoals = job.journey_id ? (goalByJourney.get(job.journey_id) ?? []) : [];
    const statuses: string[] = [];
    for (const goal of linkedGoals) {
      const status = reportGoalsById.get(goal.id)?.status;
      if (status) statuses.push(status);
    }
    const status = statuses.length > 0 ? summarizeStatuses(statuses) : 'not mapped';
    const statusPill =
      status === 'not mapped'
        ? renderStatusPill('neutral', 'not mapped')
        : renderStatusPill(status);
    const required =
      job.required_actions.length > 0 ? job.required_actions.join(', ') : 'normal user actions';
    const weak =
      job.weak_evidence.length > 0 ? job.weak_evidence.join('; ') : 'activation-only proof';
    return `<div class="product-use-job">
      <div><strong>${escapeHtml(job.title)}</strong> ${statusPill}</div>
      <div class="product-use-meta"><span>Needs</span>${escapeHtml(required)}</div>
      <div class="product-use-meta"><span>Proof</span>${escapeHtml(job.expected_artifact || 'visible artifact or state change')}</div>
      <div class="product-use-meta"><span>Weak</span>${escapeHtml(weak)}</div>
    </div>`;
  });
  const kinds = contract.product_kinds.length > 0 ? contract.product_kinds.join(', ') : 'unknown';
  const artifacts =
    contract.core_artifacts.length > 0
      ? contract.core_artifacts.join('; ')
      : 'visible value-producing artifact or state change';
  return `<div class="product-use-contract">
    <div class="product-use-title">Real-use contract</div>
    <div class="product-use-loop">${escapeHtml(contract.primary_value_loop || 'Primary value loop not recorded')}</div>
    <details class="product-use-details"><summary>Expected artifacts and checks</summary>
      <div class="product-use-meta"><span>Kind</span>${escapeHtml(kinds)}</div>
      <div class="product-use-meta"><span>Artifact</span>${escapeHtml(artifacts)}</div>
      ${
        jobs.length > 0
          ? `<details class="product-use-jobs-details"><summary>${escapeHtml(`Acceptance checks (${jobs.length})`)}</summary><div class="product-use-jobs">${jobs.join('')}</div></details>`
          : ''
      }
    </details>
  </div>`;
}

function summarizeStatuses(statuses: string[]): string {
  if (statuses.some((status) => status === 'blocked' || status === 'not_satisfied'))
    return 'blocked';
  if (statuses.some((status) => status === 'partial')) return 'partial';
  if (statuses.some((status) => status === 'untested')) return 'untested';
  if (statuses.every((status) => status === 'verified' || status === 'satisfied'))
    return 'verified';
  return statuses[0] ?? 'unknown';
}

function renderDiscoveryCoverageMap(
  report: ReportJson,
  selectedJourneyIds: string[],
  selectedJourneyRefs: Array<{ id: string; label: string }>,
): string {
  const discovery = report.discovery;
  if (!discovery) return '';
  const journeyById = new Map((discovery.journeys ?? []).map((journey) => [journey.id, journey]));
  const surfaceById = new Map((discovery.surfaces ?? []).map((surface) => [surface.id, surface]));
  const goalsByJourney = new Map<string, NonNullable<ReportJson['discovery']>['goals']>();
  for (const goal of discovery.goals ?? []) {
    if (!goal.journey_id) continue;
    const existing = goalsByJourney.get(goal.journey_id) ?? [];
    existing.push(goal);
    goalsByJourney.set(goal.journey_id, existing);
  }
  const rowIds =
    selectedJourneyIds.length > 0
      ? selectedJourneyIds
      : selectedJourneyRefs.map((journey) => journey.id);
  const rows = rowIds
    .map((journeyId) => {
      const journey = journeyById.get(journeyId);
      const fallbackJourney = selectedJourneyRefs.find((item) => item.id === journeyId);
      const goals = goalsByJourney.get(journeyId) ?? [];
      const goalRefs =
        goals.length > 0
          ? goals.map((goal) => ({ id: goal.id, label: goal.description }))
          : [{ id: '', label: journey?.suggested_goal ?? fallbackJourney?.label ?? journeyId }];
      const surfaceIds =
        goals.length > 0
          ? uniqueStrings(goals.flatMap((goal) => goal.surface_ids ?? []))
          : (journey?.surface_ids ?? []);
      const allSurfaceRefs = surfaceIds.map((id) => {
        const surface = surfaceById.get(id);
        return { id, label: surface?.label ?? id, kind: surface?.kind };
      });
      const surfaceRefs =
        allSurfaceRefs.length > 1
          ? allSurfaceRefs.filter((surface) => surface.kind !== 'page')
          : allSurfaceRefs;
      const journeyRef = {
        id: journeyId,
        label: journey?.title ?? fallbackJourney?.label ?? journeyId,
      };
      return `<div class="discovery-map-row">
        <div class="discovery-map-field">
          <span class="discovery-map-field-label">Journey</span>
          ${renderDiscoveryChips([journeyRef])}
        </div>
        <div class="discovery-map-field">
          <span class="discovery-map-field-label">Goal checked</span>
          ${renderDiscoveryChips(goalRefs)}
        </div>
        <div class="discovery-map-field">
          <span class="discovery-map-field-label">Surfaces covered</span>
          ${renderDiscoveryChips(surfaceRefs)}
        </div>
      </div>`;
    })
    .join('');
  if (!rows) return '';
  return `<div class="discovery-map">
    <div class="discovery-map-title">Coverage map</div>
    ${rows}
  </div>`;
}

function uniqueStrings(values: string[]): string[] {
  return [...new Set(values)];
}

function surfaceCoverageForJourneys(
  journeyIds: string[],
  journeys: NonNullable<ReportJson['discovery']>['journeys'],
  surfaces: NonNullable<ReportJson['discovery']>['surfaces'],
): { direct: Set<string>; context: Set<string>; covered: Set<string> } {
  const selected = new Set(journeyIds);
  const byId = new Map((surfaces ?? []).map((surface) => [surface.id, surface]));
  const direct = new Set<string>();
  for (const journey of journeys ?? []) {
    if (!selected.has(journey.id)) continue;
    for (const surfaceId of journey.surface_ids ?? []) direct.add(surfaceId);
  }
  const context = new Set<string>();
  for (const surface of surfaces ?? []) {
    if (direct.has(surface.id) || surface.kind !== 'page') continue;
    const isPageContext = (journeys ?? []).some((journey) => {
      if (!selected.has(journey.id)) return false;
      return (journey.surface_ids ?? []).some(
        (surfaceId) => byId.get(surfaceId)?.url === surface.url,
      );
    });
    if (isPageContext) context.add(surface.id);
  }
  return { direct, context, covered: new Set([...direct, ...context]) };
}

function formatDiscoveryJourneyRefs(
  ids: string[],
  journeys: NonNullable<ReportJson['discovery']>['journeys'],
): Array<{ id: string; label: string }> {
  if (ids.length === 0) return [];
  const byId = new Map((journeys ?? []).map((journey) => [journey.id, journey]));
  return ids.slice(0, 8).map((id) => {
    const journey = byId.get(id);
    return { id, label: journey?.title ?? id };
  });
}

function formatDiscoverySurfaceRefs(
  ids: string[],
  surfaces: NonNullable<ReportJson['discovery']>['surfaces'],
  limit = 10,
): Array<{ id: string; label: string }> {
  if (ids.length === 0) return [];
  const byId = new Map((surfaces ?? []).map((surface) => [surface.id, surface]));
  return ids.slice(0, limit).map((id) => {
    const surface = byId.get(id);
    return { id, label: surface?.label ?? id };
  });
}

function renderDiscoveryChips(items: Array<{ id: string; label: string }>): string {
  if (items.length === 0) {
    return '<div class="discovery-chip-list"><span class="discovery-chip">None</span></div>';
  }
  return `<div class="discovery-chip-list">${items
    .map(
      (item) =>
        `<span class="discovery-chip"><code>${escapeHtml(item.id)}</code>${escapeHtml(item.label)}</span>`,
    )
    .join('')}</div>`;
}

function buildGoalEvidenceCards(
  report: ReportJson,
  eventIndex: Map<string, TraceEvent>,
  screenshotForEvent: Map<string, string>,
  clipPaths: Record<string, string>,
  goalFindingLinks: GoalFindingLinks,
): VisualEvidenceCard[] {
  const cards: VisualEvidenceCard[] = [];
  const discovery = buildDiscoveryIndex(report);

  for (const goal of report.spec_compliance.goals) {
    const resolved = resolveEvidenceEventIds(goal.evidence, eventIndex);
    const withScreenshot = resolved.find((eventId) => screenshotForEvent.has(eventId));
    const path = withScreenshot ? screenshotForEvent.get(withScreenshot) : undefined;
    const event = withScreenshot ? eventIndex.get(withScreenshot) : undefined;
    const origin = discoveryOriginForGoal(goal.id, discovery);
    const title = goalEvidenceTitle(goal, origin, event);
    const effectiveStatus = effectiveGoalStatus(goal, eventIndex);
    const linkedFindings = goalFindingLinks.byGoalId.get(goal.id) ?? [];
    const grouping = origin?.journey
      ? { key: `journey:${origin.journey.id}`, label: origin.journey.label }
      : classifyGoalEvidence(goal.description, title, goal.notes ?? '');
    const key = path ? `goal:${path}` : `goal:${goal.id}`;
    const existing = cards.find((card) => card.key === key);
    if (existing) {
      existing.claim = appendClaim(existing.claim, `Goal ${goal.id}`);
      existing.status =
        existing.status === goalStatusLabel(effectiveStatus) ? existing.status : 'mixed';
      existing.details = [...(existing.details ?? []), `${goal.id}: ${goal.description}`];
      if (origin) existing.origin = mergeGoalOrigin(existing.origin, origin);
      existing.goalCount += 1;
      const mergedLinks = mergeFindingLinks(existing.linkedFindings, linkedFindings);
      if (mergedLinks) existing.linkedFindings = mergedLinks;
      const clipPath = clipPaths[goal.id];
      if (!existing.clipPath && clipPath) {
        existing.clipPath = clipPath;
      }
      continue;
    }
    cards.push({
      key,
      claim: `Goal ${goal.id}`,
      primaryGoalId: goal.id,
      status: goalStatusLabel(effectiveStatus),
      title,
      context: goal.notes ?? goal.description,
      details: [`${goal.id}: ${goal.description}`],
      ...(origin ? { origin } : {}),
      ...(path ? { screenshotPath: path } : {}),
      ...(clipPaths[goal.id] ? { clipPath: clipPaths[goal.id] } : {}),
      ...(withScreenshot ? { eventId: withScreenshot } : {}),
      groupKey: grouping.key,
      groupLabel: grouping.label,
      goalCount: 1,
      ...(linkedFindings.length > 0 ? { linkedFindings } : {}),
    });
  }

  const clipCounts = new Map<string, number>();
  for (const card of cards) {
    if (!card.clipPath) continue;
    clipCounts.set(card.clipPath, (clipCounts.get(card.clipPath) ?? 0) + 1);
  }
  for (const card of cards) {
    if (card.clipPath && (clipCounts.get(card.clipPath) ?? 0) > 1) card.sharedClip = true;
  }

  return cards.slice(0, 48);
}

function goalEvidenceTitle(
  goal: ReportJson['spec_compliance']['goals'][number],
  origin: DiscoveryGoalOrigin | undefined,
  event: TraceEvent | undefined,
): string {
  if (goal.description.trim()) return goal.description.trim();
  if (origin?.journey?.label) return origin.journey.label;
  return event ? eventTitle(event) : 'Goal evidence';
}

interface DiscoveryIndex {
  goals: Map<string, { id: string; journey_id?: string | undefined; surface_ids?: string[] }>;
  journeys: Map<string, { id: string; title: string }>;
  surfaces: Map<string, { id: string; label: string; kind?: string }>;
}

interface DiscoveryGoalOrigin {
  journey?: { id: string; label: string };
  surfaces: Array<{ id: string; label: string; kind?: string }>;
}

function buildDiscoveryIndex(report: ReportJson): DiscoveryIndex {
  const discovery = report.discovery;
  return {
    goals: new Map((discovery?.goals ?? []).map((goal) => [goal.id, goal])),
    journeys: new Map((discovery?.journeys ?? []).map((journey) => [journey.id, journey])),
    surfaces: new Map((discovery?.surfaces ?? []).map((surface) => [surface.id, surface])),
  };
}

function mergeGoalOrigin(
  existing: DiscoveryGoalOrigin | undefined,
  next: DiscoveryGoalOrigin,
): DiscoveryGoalOrigin {
  if (!existing) return next;
  const surfaces = [...existing.surfaces];
  const seenSurfaceIds = new Set(surfaces.map((surface) => surface.id));
  for (const surface of next.surfaces) {
    if (seenSurfaceIds.has(surface.id)) continue;
    seenSurfaceIds.add(surface.id);
    surfaces.push(surface);
  }
  const journey = existing.journey ?? next.journey;
  return {
    ...(journey ? { journey } : {}),
    surfaces,
  };
}

function mergeFindingLinks(
  existing: FindingGoalLink[] | undefined,
  next: FindingGoalLink[],
): FindingGoalLink[] | undefined {
  if (!existing || existing.length === 0) return next.length > 0 ? next : undefined;
  const out = [...existing];
  const seen = new Set(out.map((link) => `${link.findingId}:${link.goalId}`));
  for (const link of next) {
    const key = `${link.findingId}:${link.goalId}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(link);
  }
  return out;
}

function discoveryOriginForGoal(
  goalId: string,
  discovery: DiscoveryIndex,
): DiscoveryGoalOrigin | undefined {
  const goal = discovery.goals.get(goalId);
  if (!goal) return undefined;
  const journey = goal.journey_id ? discovery.journeys.get(goal.journey_id) : undefined;
  const allSurfaces = (goal.surface_ids ?? [])
    .map((id) => discovery.surfaces.get(id))
    .filter((surface): surface is { id: string; label: string; kind?: string } => Boolean(surface));
  const surfaces =
    allSurfaces.length > 1 ? allSurfaces.filter((surface) => surface.kind !== 'page') : allSurfaces;
  if (!journey && surfaces.length === 0) return undefined;
  return {
    ...(journey ? { journey: { id: journey.id, label: journey.title } } : {}),
    surfaces,
  };
}

function renderGoalEvidenceGroup(group: {
  key: string;
  label: string;
  cards: VisualEvidenceCard[];
}): string {
  const goalCount = group.cards.reduce((sum, card) => sum + card.goalCount, 0);
  const groupStatus = summarizeStatuses(group.cards.map((card) => card.status ?? 'untested'));
  const singleJourneyCard =
    group.cards.length === 1 && group.cards[0]?.origin?.journey ? group.cards[0] : undefined;
  const heading = singleJourneyCard?.title ?? group.label;
  return `<section class="goal-proof-group" data-group="${escapeAttr(group.key)}">
    <div class="goal-proof-group-head">
      <h3>${singleJourneyCard ? renderGoalHeadingTitle(singleJourneyCard.claim, heading) : escapeHtml(heading)}</h3>
      <div class="goal-proof-group-meta">
        ${renderStatusPill(groupStatus)}
        ${goalCount > 1 ? `<span class="goal-proof-group-count">${escapeHtml(`${goalCount} goals`)}</span>` : ''}
      </div>
    </div>
    <div class="goal-proof-list">
      ${group.cards
        .map((card) =>
          renderGoalEvidenceCard(card, { suppressTitle: card.key === singleJourneyCard?.key }),
        )
        .join('')}
    </div>
  </section>`;
}

function renderGoalEvidenceCard(
  card: VisualEvidenceCard,
  opts: { suppressTitle?: boolean } = {},
): string {
  const idAttr = ` id="${escapeAttr(goalAnchorId(card.primaryGoalId))}"`;
  const statusClass = card.status ? ` ${goalStatusClass(card.status)}` : '';
  const statusPill = card.status ? renderStatusPill(card.status) : '';
  const headingHtml = opts.suppressTitle
    ? ''
    : `<div class="goal-proof-card-heading">${renderGoalHeadingTitle(card.claim, card.title)}${statusPill}</div>`;
  if (!card.screenshotPath && !card.clipPath) {
    return `<div${idAttr} class="goal-proof-row no-frame${statusClass}">
      ${headingHtml || `<div class="goal-proof-card-heading">${renderGoalHeadingTitle(card.claim, 'Needs better visual evidence')}</div>`}
      ${renderGoalScope(card, opts.suppressTitle === true)}
      ${renderGoalObservedResult(card)}
      ${renderGoalLinkedFindings(card.linkedFindings)}
      ${renderGoalOrigin(card)}
      ${renderGoalEvidenceActions(card)}
    </div>`;
  }
  const evidenceLink = card.eventId
    ? `#evt-${escapeAttr(card.eventId)}`
    : card.screenshotPath
      ? escapeAttr(card.screenshotPath)
      : card.clipPath
        ? escapeAttr(card.clipPath)
        : undefined;
  return `<div${idAttr} class="goal-proof-row${statusClass}">
    ${renderGoalProofMedia(card)}
    <div class="goal-proof-copy">
      ${headingHtml}
      ${renderGoalScope(card, opts.suppressTitle === true)}
      ${renderGoalObservedResult(card)}
      ${renderGoalLinkedFindings(card.linkedFindings)}
      ${renderGoalOrigin(card)}
      ${renderGoalEvidenceActions(card, evidenceLink)}
    </div>
  </div>`;
}

function renderGoalHeadingTitle(claim: string, title: string): string {
  return `<span class="goal-id-badge">${escapeHtml(claim)}</span><span class="goal-proof-title">${escapeHtml(title)}</span>`;
}

function goalAnchorId(goalId: string): string {
  return `goal-${goalId}`;
}

function renderGoalLinkedFindings(links: FindingGoalLink[] | undefined): string {
  if (!links || links.length === 0) return '';
  const items = links
    .map(
      (link) =>
        `<div><a href="#finding-${escapeAttr(link.findingId)}">${escapeHtml(link.findingId)}</a> ${escapeHtml(link.findingTitle)} <span>(${escapeHtml(link.severity)})</span></div>`,
    )
    .join('');
  return `<div class="goal-linked-findings">
    <span class="label">Issue from this evidence</span>
    ${items}
  </div>`;
}

function renderGoalProofMedia(card: VisualEvidenceCard): string {
  if (card.clipPath && /\.(webm|mp4)$/i.test(card.clipPath)) {
    const posterAttr = card.screenshotPath ? ` poster="${escapeAttr(card.screenshotPath)}"` : '';
    return `<div class="goal-proof-media">
      <video controls preload="metadata" src="${escapeAttr(card.clipPath)}"${posterAttr}>
        <a href="${escapeAttr(card.clipPath)}">Open clip for ${escapeHtml(card.claim)}</a>
      </video>
      <div class="goal-proof-media-caption">
        <span>${escapeHtml(`${card.claim} clip${card.sharedClip ? ' (shared window)' : ''}`)}</span>
        <a href="${escapeAttr(card.clipPath)}" target="_blank" rel="noopener">open full clip</a>
      </div>
    </div>`;
  }
  if (card.screenshotPath) {
    return `<a class="goal-proof-media" href="${escapeAttr(card.screenshotPath)}" target="_blank" rel="noopener">
      <img src="${escapeAttr(card.screenshotPath)}" alt="${escapeAttr(card.claim)} evidence" loading="lazy">
      <span class="goal-proof-media-caption"><span>${escapeHtml(card.claim)} screenshot</span><span>open image</span></span>
    </a>`;
  }
  return '';
}

function renderGoalOrigin(card: VisualEvidenceCard): string {
  if (!card.origin) return '';
  const journey = card.origin.journey
    ? `<div class="goal-proof-origin-row"><span class="label">Journey</span>${renderDiscoveryChips([card.origin.journey])}</div>`
    : '';
  const surfaces =
    card.origin.surfaces.length > 0
      ? `<div class="goal-proof-origin-row"><span class="label">Surfaces</span>${renderDiscoveryChips(card.origin.surfaces)}</div>`
      : '';
  const parts: string[] = [];
  if (card.origin.journey) parts.push(card.origin.journey.id);
  if (card.origin.surfaces.length > 0) {
    parts.push(
      `${card.origin.surfaces.length} surface${card.origin.surfaces.length === 1 ? '' : 's'}`,
    );
  }
  return `<details class="goal-proof-origin">
    <summary>Coverage: ${escapeHtml(parts.join(' · '))}</summary>
    <div class="goal-proof-origin-body">${journey}${surfaces}</div>
  </details>`;
}

function renderGoalScope(card: VisualEvidenceCard, suppressDuplicateDetails = false): string {
  const details = suppressDuplicateDetails
    ? (card.details ?? []).filter(
        (detail) => normalizeGoalDetail(detail) !== normalizeGoalDetail(card.title),
      )
    : (card.details ?? []);
  if (details.length === 0) return '';
  const content =
    details.length === 1
      ? escapeHtml(details[0] ?? '')
      : `<ul>${details.map((detail) => `<li>${escapeHtml(detail)}</li>`).join('')}</ul>`;
  return `<div class="goal-proof-scope"><span class="label">Scope</span>${content}</div>`;
}

function normalizeGoalDetail(value: string): string {
  return value
    .replace(/^[A-Z]\d+:\s*/i, '')
    .replace(/\s+/g, ' ')
    .trim()
    .toLowerCase();
}

function renderGoalObservedResult(card: VisualEvidenceCard): string {
  if (!card.context) return '';
  return `<div class="goal-proof-context"><span class="label">Observed</span>${escapeHtml(card.context)}</div>`;
}

function renderGoalEvidenceActions(card: VisualEvidenceCard, evidenceLink?: string): string {
  const sourceLabel = card.eventId
    ? 'source event'
    : card.screenshotPath
      ? 'source image'
      : 'source clip';
  const source = evidenceLink ? `<a class="ev-chip" href="${evidenceLink}">${sourceLabel}</a>` : '';
  if (!source) return '';
  return `<div class="goal-proof-actions">${source}</div>`;
}

function appendClaim(existing: string, next: string): string {
  const parts = existing.split(', ').filter(Boolean);
  if (!parts.includes(next)) parts.push(next);
  return parts.join(', ');
}

function groupGoalEvidenceCards(cards: VisualEvidenceCard[]): Array<{
  key: string;
  label: string;
  rank: number;
  cards: VisualEvidenceCard[];
}> {
  const byKey = new Map<
    string,
    { key: string; label: string; rank: number; cards: VisualEvidenceCard[] }
  >();
  for (const card of cards) {
    const rank = goalGroupRank(card.groupKey);
    const existing = byKey.get(card.groupKey);
    if (existing) {
      existing.cards.push(card);
    } else {
      byKey.set(card.groupKey, {
        key: card.groupKey,
        label: card.groupLabel,
        rank,
        cards: [card],
      });
    }
  }
  return Array.from(byKey.values()).sort(
    (a, b) => a.rank - b.rank || a.label.localeCompare(b.label),
  );
}

function classifyGoalEvidence(
  description: string,
  title: string,
  context: string,
): { key: string; label: string } {
  const text = `${description} ${title} ${context}`.toLowerCase();
  if (/donat|fundraiser|support our work|already donated/.test(text)) {
    return { key: 'donation', label: 'Donation flow' };
  }
  if (/\b(search|result|query)\b/.test(text)) {
    return { key: 'search', label: 'Search & articles' };
  }
  if (
    /\b(talk|history|page tabs?|article tools?|reference tools?|references|toc|table of contents)\b/.test(
      text,
    ) ||
    /\b(content navigation|navigation anchors?|language-selection|language selection)\b/.test(
      text,
    ) ||
    /\barticle\b.*\b(talk|history|edit|language|tools?|tabs?|references?)\b/.test(text)
  ) {
    return { key: 'article_nav', label: 'Article navigation' };
  }
  if (
    /\b(featured article|news item|did you know|article page|open(?:ed)? an? article|article)\b/.test(
      text,
    )
  ) {
    return { key: 'search', label: 'Search & articles' };
  }
  if (
    /\b(language|edition|english|japanese|german|french|chinese|deutsch|français|日本語|中文)\b/.test(
      text,
    )
  ) {
    return { key: 'language', label: 'Language editions' };
  }
  if (/\b(app store|google play|android|ios|mobile app|download)\b/.test(text)) {
    return { key: 'apps', label: 'Mobile apps' };
  }
  if (/\b(terms|privacy|policy|legal|license|creative commons|attribution)\b/.test(text)) {
    return { key: 'legal', label: 'Policies & licensing' };
  }
  if (
    /\b(commons|wikivoyage|wiktionary|wikibooks|wikidata|wikiversity|wikiquote|mediawiki|wikisource|wikispecies|wikifunctions|meta-wiki|sister|project)\b/.test(
      text,
    )
  ) {
    return { key: 'projects', label: 'Wikimedia projects' };
  }
  if (/\b(login|sign in|sign up|account|profile|password|auth)\b/.test(text)) {
    return { key: 'account', label: 'Account & access' };
  }
  if (/\b(create|edit|delete|update|save|publish|submit)\b/.test(text)) {
    return { key: 'editing', label: 'Create & edit flows' };
  }
  if (/\b(checkout|cart|payment|billing|invoice|subscription)\b/.test(text)) {
    return { key: 'billing', label: 'Checkout & billing' };
  }
  if (/\b(settings|preferences|admin|configuration)\b/.test(text)) {
    return { key: 'settings', label: 'Settings' };
  }
  if (/\b(navigation|menu|footer|header|link|back|forward)\b/.test(text)) {
    return { key: 'navigation', label: 'Navigation' };
  }
  return { key: 'other', label: 'Other checked surfaces' };
}

function goalGroupRank(key: string): number {
  const ranks: Record<string, number> = {
    search: 10,
    article_nav: 20,
    language: 30,
    donation: 40,
    apps: 50,
    projects: 60,
    legal: 70,
    account: 80,
    editing: 90,
    billing: 100,
    settings: 110,
    navigation: 120,
    other: 999,
  };
  return ranks[key] ?? 500;
}

function resolveEvidenceEventIds(
  evidenceIds: string[],
  eventIndex: Map<string, TraceEvent>,
): string[] {
  const trace = Array.from(eventIndex.values());
  const out: string[] = [];
  const seen = new Set<string>();
  const add = (id: string) => {
    const resolvedId = resolveTraceRefTypo(id, trace) ?? id;
    if (seen.has(resolvedId)) return;
    seen.add(resolvedId);
    out.push(resolvedId);
  };
  for (const id of evidenceIds) {
    const event = eventIndex.get(id);
    if (!event) {
      add(id);
      continue;
    }
    const payload = event.payload as Record<string, unknown>;
    if (event.kind === 'goal_status' && Array.isArray(payload.evidence_event_ids)) {
      for (const nested of payload.evidence_event_ids) {
        if (typeof nested === 'string') add(nested);
      }
      continue;
    }
    add(id);
  }
  return out;
}

function eventTitle(event: TraceEvent): string {
  const payload = event.payload as Record<string, unknown>;
  if (event.kind === 'observation') {
    const summary = typeof payload.summary === 'string' ? payload.summary : '';
    return summary.split('\n')[0]?.trim() || String(payload.ref ?? 'observation');
  }
  if (event.kind === 'probe_result') return String(payload.probe ?? 'probe result');
  return event.kind.replace(/_/g, ' ');
}

function renderFinding(
  f: JudgeOutput['findings'][number],
  num: number,
  eventIndex: Map<string, TraceEvent>,
  screenshotForEvent: Map<string, string>,
  orderedEvents: TraceEvent[],
  clipsByFindingId: Record<string, string>,
  linkedGoals: FindingGoalLink[],
): string {
  // Phase 6 F3: prefer a per-finding video clip when available; fall back to
  // the first cited-event screenshot. The clip is more useful — it shows the
  // actual interaction window — but small or thin findings may only get a
  // still frame.
  let inlineEvidence = '';
  const clipPath = clipsByFindingId[f.id];
  if (linkedGoals.length > 0 && clipPath) {
    inlineEvidence = renderFindingLinkedMediaNote(linkedGoals, clipPath);
  } else if (clipPath && /\.(webm|mp4)$/i.test(clipPath)) {
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
    if (!inlineEvidence) {
      const fallback = nearestScreenshotForEvidence(f.evidence, orderedEvents, screenshotForEvent);
      if (fallback) {
        inlineEvidence = `<div class="finding-screenshot">
          <a href="${escapeAttr(fallback.path)}" target="_blank" rel="noopener">
            <img src="${escapeAttr(fallback.path)}" alt="Context screenshot for ${escapeAttr(f.id)}" loading="lazy">
          </a>
          <div class="caption">
            <span>context frame near ${escapeHtml(fallback.label)}</span>
            <a href="#evt-${escapeAttr(fallback.eventId)}">source event</a>
          </div>
        </div>`;
      }
    }
  }
  const media = inlineEvidence ? `<div class="finding-media">${inlineEvidence}</div>` : '';
  const probeDetails = renderProbeEvidenceDetails(f, eventIndex);
  const title = friendlyFindingTitle(f, eventIndex);
  const linkedGoalBlock = renderFindingLinkedGoals(linkedGoals);

  return `<li id="finding-${escapeAttr(f.id)}" class="finding-card">
    <div class="finding-head">
      <div class="finding-labels">
        <span class="finding-num">${num}.</span>
        <span class="sev-tag sev-${escapeHtml(f.severity)}">${escapeHtml(f.severity)}</span>
        ${f.unverified_backing ? '<span class="unverified-tag" title="The validator could not confirm a backing event for this finding; severity was downgraded.">unverified</span>' : ''}
        ${f.likely_explorer_error ? '<span class="unverified-tag explorer-error" title="The only backing for this finding was a failed action that looks like the Explorer using a bad selector, not an app bug.">likely-explorer-error</span>' : ''}
        ${f.severity_calibrated ? '<span class="unverified-tag" title="The validator capped raw technical severity to product impact.">severity-calibrated</span>' : ''}
        <span class="cat-tag">${escapeHtml(f.category)}</span>
      </div>
      <span class="fid">${escapeHtml(f.id)}</span>
    </div>
    <h3 class="finding-title">${escapeHtml(title)}</h3>
    <div class="finding-layout${media ? '' : ' no-media'}">
      <div class="finding-body">
        <div>${escapeHtml(f.rationale)}</div>
        ${linkedGoalBlock}
        ${f.where ? renderWhere(f.where) : ''}
        ${probeDetails}
        ${f.suggested_fix ? renderSuggestedFix(f.suggested_fix) : ''}
        ${
          f.evidence.length > 0
            ? `<div class="evidence-row"><span class="label">Evidence</span>${f.evidence.map((e) => renderEvidenceChip(e, eventIndex)).join('')}</div>`
            : ''
        }
      </div>
      ${media}
    </div>
  </li>`;
}

function renderFindingLinkedMediaNote(linkedGoals: FindingGoalLink[], clipPath: string): string {
  const first = linkedGoals[0];
  const goalLinks = linkedGoals
    .map(
      (link) =>
        `<a href="#${escapeAttr(goalAnchorId(link.goalId))}">Goal ${escapeHtml(link.goalId)} (${escapeHtml(link.goalStatus)})</a>`,
    )
    .join(', ');
  const fullClip = /\.(webm|mp4)$/i.test(clipPath)
    ? `<div style="margin-top: 6px;"><a href="${escapeAttr(clipPath)}" target="_blank" rel="noopener">open underlying clip</a></div>`
    : '';
  return `<div class="finding-linked-media-note">
    Evidence is shown with ${goalLinks || `Goal ${escapeHtml(first?.goalId ?? '')}`} to avoid a duplicate replay of the same journey.
    ${fullClip}
  </div>`;
}

function renderFindingLinkedGoals(linkedGoals: FindingGoalLink[]): string {
  if (linkedGoals.length === 0) return '';
  const goals = linkedGoals
    .map(
      (link) =>
        `<a href="#${escapeAttr(goalAnchorId(link.goalId))}">Goal ${escapeHtml(link.goalId)} (${escapeHtml(link.goalStatus)})</a>`,
    )
    .join('');
  return `<div class="finding-linked-goals">
    <span class="label">Explains tested goal</span>
    ${goals}
  </div>`;
}

interface AxeViolationEvidence {
  id: string;
  impact?: string;
  help: string;
  description?: string;
  helpUrl?: string;
  targets: string[];
  html?: string;
}

function friendlyFindingTitle(
  finding: JudgeOutput['findings'][number],
  eventIndex: Map<string, TraceEvent>,
): string {
  const axeRuleMatch = finding.title.match(/^axe found ([a-z0-9-]+) issue$/i);
  if (!axeRuleMatch) return finding.title;
  const violation = axeViolationForFinding(finding, eventIndex);
  if (!violation) return finding.title;
  if (violation.id === 'select-name') {
    const targetText = `${violation.targets.join(' ')} ${violation.html ?? ''}`.toLowerCase();
    if (targetText.includes('language')) return 'Language selector is missing an accessible name';
    return 'Select control is missing an accessible name';
  }
  if (violation.id === 'button-name') return 'Button is missing an accessible name';
  if (violation.id === 'link-name') return 'Link is missing an accessible name';
  if (violation.id === 'region') return 'Page content is missing a landmark region';
  return violation.help || finding.title.replace(axeRuleMatch[1] ?? '', displayName(violation.id));
}

function axeViolationForFinding(
  finding: JudgeOutput['findings'][number],
  eventIndex: Map<string, TraceEvent>,
): AxeViolationEvidence | null {
  const haystack = `${finding.id} ${finding.title} ${finding.rationale}`.toLowerCase();
  for (const evidenceId of finding.evidence) {
    const event = eventIndex.get(evidenceId);
    if (!event || event.kind !== 'probe_result') continue;
    const payload = event.payload as Record<string, unknown>;
    if (String(payload.probe ?? '') !== 'axe') continue;
    const data = payload.data as Record<string, unknown> | undefined;
    const violations = Array.isArray(data?.violations)
      ? (data.violations as Record<string, unknown>[])
      : [];
    const rawViolation =
      violations.find((v: Record<string, unknown>) =>
        haystack.includes(String(v.id ?? '').toLowerCase()),
      ) ?? violations[0];
    if (!rawViolation) continue;
    const nodes = Array.isArray(rawViolation.nodes)
      ? (rawViolation.nodes as Record<string, unknown>[])
      : [];
    const firstNode = nodes[0] as Record<string, unknown> | undefined;
    return {
      id: String(rawViolation.id ?? 'violation'),
      ...(rawViolation.impact ? { impact: String(rawViolation.impact) } : {}),
      help: String(rawViolation.help ?? rawViolation.description ?? 'Accessibility rule failed'),
      ...(rawViolation.description ? { description: String(rawViolation.description) } : {}),
      ...(rawViolation.help_url ? { helpUrl: String(rawViolation.help_url) } : {}),
      targets: nodes.flatMap((node: Record<string, unknown>) =>
        Array.isArray(node.target) ? node.target.map(String) : [],
      ),
      ...(firstNode?.html ? { html: String(firstNode.html) } : {}),
    };
  }
  return null;
}

function nearestScreenshotForEvidence(
  evidenceIds: string[],
  orderedEvents: TraceEvent[],
  screenshotForEvent: Map<string, string>,
): { eventId: string; path: string; label: string } | null {
  for (const evidenceId of evidenceIds) {
    const index = orderedEvents.findIndex((event) => event.id === evidenceId);
    if (index < 0) continue;
    for (let i = index; i >= 0; i--) {
      const event = orderedEvents[i];
      if (!event) continue;
      const path = screenshotForEvent.get(event.id);
      if (path) return { eventId: event.id, path, label: eventTitle(event) };
    }
    for (let i = index + 1; i < orderedEvents.length; i++) {
      const event = orderedEvents[i];
      if (!event) continue;
      const path = screenshotForEvent.get(event.id);
      if (path) return { eventId: event.id, path, label: eventTitle(event) };
    }
  }
  return null;
}

function renderProbeEvidenceDetails(
  finding: JudgeOutput['findings'][number],
  eventIndex: Map<string, TraceEvent>,
): string {
  const blocks: string[] = [];
  for (const evidenceId of finding.evidence) {
    const event = eventIndex.get(evidenceId);
    if (!event || event.kind !== 'probe_result') continue;
    const payload = event.payload as Record<string, unknown>;
    const probe = String(payload.probe ?? 'probe');
    if (probe === 'axe') {
      const violation = axeViolationForFinding(finding, eventIndex);
      if (violation) {
        const targets = violation.targets.join(', ');
        blocks.push(`<div class="finding-evidence-detail">
          <span class="detail-label">Machine evidence from axe</span>
          <div><strong>${escapeHtml(violation.id)}</strong>${violation.impact ? ` (${escapeHtml(violation.impact)})` : ''}: ${escapeHtml(violation.help)}</div>
          ${targets ? `<div>Target: <code>${escapeHtml(targets)}</code></div>` : ''}
          ${violation.html ? `<div>Element: <code>${escapeHtml(violation.html)}</code></div>` : ''}
          ${violation.helpUrl ? `<div><a href="${escapeAttr(violation.helpUrl)}" target="_blank" rel="noopener">axe rule details</a></div>` : ''}
        </div>`);
      }
    } else {
      const summary = JSON.stringify(payload.summary ?? {}).slice(0, 280);
      blocks.push(`<div class="finding-evidence-detail">
        <span class="detail-label">Machine evidence from ${escapeHtml(probe)}</span>
        <code>${escapeHtml(summary)}</code>
      </div>`);
    }
  }
  return blocks.join('');
}

function renderWhere(where: { url?: string | undefined; selector?: string | undefined }): string {
  const parts: string[] = [];
  if (where.url) parts.push(`<code>${escapeHtml(where.url)}</code>`);
  if (where.selector) parts.push(`<code>${escapeHtml(where.selector)}</code>`);
  if (parts.length === 0) return '';
  return `<div class="finding-where">at ${parts.join(' ')}</div>`;
}

// Phase 7 F7-3: render the actionable parts of suggested_fix when present.
function renderSuggestedFix(
  fix: NonNullable<JudgeOutput['findings'][number]['suggested_fix']>,
): string {
  const summary = `<div class="finding-fix"><span class="fix-label">Fix:</span>${escapeHtml(fix.summary)}</div>`;
  const patch = fix.patch_hint
    ? `<div class="finding-patch-hint"><span class="patch-label">Patch hint:</span>${escapeHtml(fix.patch_hint)}</div>`
    : '';
  let cp = '';
  if (fix.code_pointer) {
    const parts: string[] = [];
    parts.push(`selector: <code>${escapeHtml(fix.code_pointer.selector)}</code>`);
    if (fix.code_pointer.attribute)
      parts.push(`attribute: <code>${escapeHtml(fix.code_pointer.attribute)}</code>`);
    if (fix.code_pointer.current_value)
      parts.push(`current: <code>${escapeHtml(fix.code_pointer.current_value)}</code>`);
    if (fix.code_pointer.suggested_value)
      parts.push(`suggested: <code>${escapeHtml(fix.code_pointer.suggested_value)}</code>`);
    cp = `<div class="finding-code-pointer">${parts.join(' &middot; ')}</div>`;
  }
  return `${summary}${patch}${cp}`;
}

function renderEvidenceChip(eventId: string, eventIndex: Map<string, TraceEvent>): string {
  const trace = Array.from(eventIndex.values());
  const resolvedEventId = resolveTraceRefTypo(eventId, trace) ?? eventId;
  const event = eventIndex.get(resolvedEventId);
  if (event) {
    return `<a href="#evt-${escapeAttr(resolvedEventId)}" class="ev-chip" title="${escapeAttr(event.kind)}">
      <span class="ev-kind">${escapeHtml(evidenceKindLabel(event))}:</span> ${escapeHtml(evidenceDisplayLabel(event))}
    </a>`;
  }
  return `<span class="ev-chip ev-chip-missing" title="Evidence reference not found in this trace: ${escapeAttr(eventId)}">unresolved evidence</span>`;
}

function evidenceKindLabel(event: TraceEvent): string {
  switch (event.kind) {
    case 'observation':
      return 'visual';
    case 'probe_result':
      return 'probe';
    case 'goal_status':
      return 'status';
    case 'action':
    case 'action_result':
      return 'action';
    default:
      return event.kind.replace(/_/g, ' ');
  }
}

function evidenceDisplayLabel(event: TraceEvent): string {
  const payload = event.payload as Record<string, unknown>;
  if (event.kind === 'observation') return `step ${event.step}`;
  if (event.kind === 'probe_result') return `${String(payload.probe ?? 'result')}`;
  if (event.kind === 'goal_status') return String(payload.id ?? 'goal');
  if (event.kind === 'action' || event.kind === 'action_result')
    return String(payload.tool ?? 'event');
  return `step ${event.step}`;
}

function renderAuditTrailSection(
  report: ReportJson,
  runData: RunData,
  eventIndex: Map<string, TraceEvent>,
): string {
  const citedIds = collectReferencedEventIds(report, eventIndex);
  const citedEvents = runData.events.filter((event) => citedIds.has(event.id));
  const counts = eventKindCounts(runData.events);
  const summary = eventCountsSummary(counts);
  const sourceEvents =
    citedEvents.length > 0
      ? `<div class="audit-block">
          <h3>Source events cited by this report</h3>
          <p>Only events referenced by findings, goals, or score rationales are shown here. The complete trace stays in <a href="${escapeAttr(report.artifacts?.trace ?? './trace.jsonl')}" target="_blank" rel="noopener">trace.jsonl</a>.</p>
          <div class="trace-events cited-events">${citedEvents.map((event) => renderTraceEvent(event, runData)).join('')}</div>
        </div>`
      : '';
  const walkthrough = renderWalkthroughPanel(runData);
  const recordings =
    runData.videoRelPaths.length > 0
      ? renderVideoPanel(runData.videoRelPaths, report.run.duration_s)
      : '';
  if (!sourceEvents && !walkthrough && !recordings) return '';
  return `<details class="audit-section">
    <summary>
      <span class="chev">▸</span>
      <span>Audit trail</span>
      <span class="trace-meta">${escapeHtml(`${citedEvents.length} cited events, ${runData.events.length} total events`)}</span>
    </summary>
    <p class="audit-note">The findings and tested goals above are the primary evidence. This appendix is for verification and debugging, so noisy raw artifacts are folded away.</p>
    ${sourceEvents}
    ${walkthrough}
    ${recordings}
    <div class="full-trace-link">
      <span>Full trace</span>
      <a href="${escapeAttr(report.artifacts?.trace ?? './trace.jsonl')}" target="_blank" rel="noopener">trace.jsonl</a>
      <em>${escapeHtml(summary)}</em>
    </div>
  </details>`;
}

function collectReferencedEventIds(
  report: ReportJson,
  eventIndex: Map<string, TraceEvent>,
): Set<string> {
  const ids = new Set<string>();
  const addEvidence = (evidence: string[]) => {
    for (const id of resolveEvidenceEventIds(evidence, eventIndex)) {
      if (eventIndex.has(id)) ids.add(id);
    }
  };
  for (const finding of report.findings) addEvidence(finding.evidence);
  for (const goal of report.spec_compliance.goals) addEvidence(goal.evidence);
  for (const profile of Object.values(report.scores.profiles)) {
    for (const dimension of Object.values(profile.dimensions)) addEvidence(dimension.evidence);
  }
  for (const block of report.access_blocks ?? []) addEvidence(block.evidence);
  return ids;
}

function eventKindCounts(events: TraceEvent[]): Record<string, number> {
  const counts: Record<string, number> = {};
  for (const event of events) counts[event.kind] = (counts[event.kind] ?? 0) + 1;
  return counts;
}

function eventCountsSummary(counts: Record<string, number>): string {
  return Object.entries(counts)
    .filter(([kind]) => kind !== 'run_start' && kind !== 'run_end')
    .sort((a, b) => b[1] - a[1])
    .slice(0, 8)
    .map(([kind, count]) => `${count} ${kind.replace(/_/g, ' ')}`)
    .join(', ');
}

function renderWalkthroughPanel(runData: RunData): string {
  const frames = runData.events
    .filter((event) => event.kind === 'observation' && runData.screenshots.byEventId.has(event.id))
    .map((event) => ({
      event,
      path: runData.screenshots.byEventId.get(event.id) ?? '',
      title: eventTitle(event),
    }))
    .filter((frame) => frame.path.length > 0);
  if (frames.length === 0) return '';
  return `<details class="debug-panel walkthrough-section">
    <summary>
      <span class="chev">▸</span>
      <span>Screenshot storyboard</span>
      <span class="trace-meta">${frames.length} frame${frames.length === 1 ? '' : 's'}</span>
    </summary>
    <div class="walkthrough-strip" tabindex="0" aria-label="Scrollable run screenshot timeline">
      ${frames
        .map(
          (frame) => `<a class="walkthrough-frame" href="#evt-${escapeAttr(frame.event.id)}">
            <img src="${escapeAttr(frame.path)}" alt="Step ${frame.event.step} screenshot" loading="lazy">
            <div class="walkthrough-caption">
              <div class="step">step ${frame.event.step}</div>
              <div class="title">${escapeHtml(frame.title)}</div>
            </div>
          </a>`,
        )
        .join('')}
    </div>
  </details>`;
}

// Raw videos are not claim-scoped evidence clips. They live in the audit
// appendix, behind a debug label, so they do not compete with proof rows.
function renderVideoPanel(relPaths: string[], durationS: number): string {
  const videos = relPaths
    .map(
      (relPath, index) => `<div class="raw-video-card">
        <video class="raw-recording" controls preload="metadata" src="${escapeAttr(relPath)}">
          <a href="${escapeAttr(relPath)}">Open raw recording ${index + 1}</a>
        </video>
        <div class="caption">
          <span>raw page recording ${index + 1}</span>
          <a href="${escapeAttr(relPath)}" target="_blank" rel="noopener">open full</a>
        </div>
      </div>`,
    )
    .join('');
  return `<details class="debug-panel video-section">
    <summary>
      <span class="chev">▸</span>
      <span>Raw debug recordings</span>
      <span class="trace-meta">${relPaths.length} file${relPaths.length === 1 ? '' : 's'}, ${formatDuration(durationS)} run</span>
    </summary>
    <p class="video-note">Raw recordings are unstitched browser-context files and may include static waits or incidental pages. Use claim clips and proof rows above for the report verdict.</p>
    <div class="raw-video-scroll">
      <div class="raw-video-grid">${videos}</div>
    </div>
  </details>`;
}

function renderScoreMatrixSection(
  scores: JudgeOutput['scores'],
  eventIndex: Map<string, TraceEvent>,
): string {
  const entries = scoreProfileEntries(scores);
  if (entries.length === 0) return '';
  const profileStrip = entries
    .map(({ name, profile }) => {
      const score = profile ? rubricProfileScoreLabel(profile) : 'missing';
      const numericScore = profile ? rubricProfileNumericScore(profile) : null;
      const cls = numericScore === null ? 'is-missing' : '';
      return `<div class="profile-score ${cls}">
        <span>${escapeHtml(displayName(name))}</span>
        <strong class="score-value ${scoreToneClass(numericScore)}">${escapeHtml(score)}</strong>
      </div>`;
    })
    .join('');
  const profileCards = entries
    .map(({ name, profile }) => renderScoreProfileCard(name, profile, eventIndex))
    .join('');
  return `<section class="score-section">
    <div class="section-head">
      <div>
        <h2>Score matrix</h2>
        <p>Cross-cutting rubric scores over the same evidence above. These are not parent buckets for the tested goals.</p>
      </div>
      <div class="overall-mini">${scores.overall.score.toFixed(1)}<span>/10</span></div>
    </div>
    <div class="profile-strip">${profileStrip}</div>
    <div class="score-profile-grid">${profileCards}</div>
  </section>`;
}

function scoreProfileEntries(
  scores: JudgeOutput['scores'],
): Array<{ name: string; profile: JudgeOutput['scores']['profiles'][string] | null }> {
  const entries: Array<{
    name: string;
    profile: JudgeOutput['scores']['profiles'][string] | null;
  }> = Object.entries(scores.profiles).map(([name, profile]) => ({ name, profile }));
  const present = new Set(entries.map((entry) => entry.name));
  for (const name of scores.overall.weighted_from) {
    if (!present.has(name)) entries.push({ name, profile: null });
  }
  return entries;
}

function renderScoreProfileCard(
  profileName: string,
  profile: JudgeOutput['scores']['profiles'][string] | null,
  eventIndex: Map<string, TraceEvent>,
): string {
  const profileLabel = displayName(profileName);
  if (!profile) {
    return `<section class="score-profile-card">
      <div class="score-profile-head"><h3>${escapeHtml(profileLabel)}</h3><strong>missing</strong></div>
      <div class="score-dimension-list">
        <div class="score-dimension is-missing">
          <div class="score-dimension-title"><span>Profile</span><span class="score-value score-none">missing</span></div>
          <div class="score-dimension-rationale">Listed in weighted_from but absent from scores.profiles.</div>
        </div>
      </div>
    </section>`;
  }
  const dimensions = Object.entries(profile.dimensions);
  const body =
    dimensions.length > 0
      ? dimensions
          .map(([dimensionName, dimension]) => {
            const displayDimension = scoreDimensionWithRunEvidence(
              profileName,
              dimensionName,
              dimension,
              eventIndex.size > 0 ? eventIndex.values() : undefined,
            );
            const evidence = renderScoreEvidenceDetails(displayDimension.evidence, eventIndex);
            return `<div class="score-dimension ${displayDimension.score === null ? 'is-missing' : ''}">
              <div class="score-dimension-title">
                <span>${escapeHtml(displayName(dimensionName))}</span>
                ${
                  displayDimension.score === null
                    ? '<span class="score-value score-none">n/a</span>'
                    : `<strong class="score-value ${scoreToneClass(displayDimension.score)}">${escapeHtml(displayDimension.score.toFixed(1))}</strong>`
                }
              </div>
              <div class="score-dimension-rationale">${escapeHtml(displayDimension.rationale)}${evidence}</div>
            </div>`;
          })
          .join('')
      : `<div class="score-dimension is-missing">
          <div class="score-dimension-title"><span>Profile</span><span class="score-value score-none">n/a</span></div>
          <div class="score-dimension-rationale">No dimension scores returned.</div>
        </div>`;
  return `<section class="score-profile-card">
    <div class="score-profile-head"><h3>${escapeHtml(profileLabel)}</h3><strong class="score-value ${scoreToneClass(rubricProfileNumericScore(profile))}">${escapeHtml(rubricProfileScoreLabel(profile))}</strong></div>
    <div class="score-dimension-list">${body}</div>
  </section>`;
}

function renderScoreEvidenceDetails(
  evidence: string[],
  eventIndex: Map<string, TraceEvent>,
): string {
  if (evidence.length === 0) return '';
  return `<details class="matrix-evidence">
    <summary>${escapeHtml(`${evidence.length} evidence ref${evidence.length === 1 ? '' : 's'}`)}</summary>
    <div class="matrix-evidence-list">${evidence.map((id) => renderEvidenceChip(id, eventIndex)).join('')}</div>
  </details>`;
}

function rubricProfileScoreLabel(profile: JudgeOutput['scores']['profiles'][string]): string {
  const score = rubricProfileNumericScore(profile);
  return score === null ? 'n/a' : score.toFixed(1);
}

function rubricProfileNumericScore(
  profile: JudgeOutput['scores']['profiles'][string],
): number | null {
  const dimensions = Object.values(profile.dimensions);
  if (dimensions.length > 0 && dimensions.every((dimension) => dimension.score === null)) {
    return null;
  }
  return profile.score;
}

function scoreToneClass(score: number | null): string {
  if (score === null || !Number.isFinite(score)) return 'score-none';
  if (score >= 8) return 'score-high';
  if (score >= 6) return 'score-mid';
  return 'score-low';
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

// Phase 9 fix: rewrite absolute clip paths to runDir-relative form so the
// report works whether opened as file:// or served over HTTP from runDir.
// Some orchestrators store repo-root-relative paths such as
// `iris-runs/<run>/evidence/clips/clip-001.webm`; these must also be rewritten
// because the HTML document is rooted at `<run>/report.html`.
function relativizeClipPaths(
  clips: Record<string, string>,
  runDir: string | undefined,
): Record<string, string> {
  if (!runDir) return clips;
  const out: Record<string, string> = {};
  const root = resolve(runDir);
  for (const [k, v] of Object.entries(clips)) {
    if (!v) continue;
    out[k] = relativizeRunAssetPath(v, root);
  }
  return out;
}

function relativizeRunAssetPath(path: string, runRoot: string): string {
  if (/^[a-z][a-z0-9+.-]*:\/\//i.test(path) || path.startsWith('data:') || path.startsWith('#')) {
    return path;
  }

  const cwdResolved = resolve(path);
  const cwdRel = relative(runRoot, cwdResolved);
  if (isInsideRunDir(cwdRel)) return cwdRel || '.';

  const runResolved = resolve(runRoot, path);
  const runRel = relative(runRoot, runResolved);
  if (isInsideRunDir(runRel)) return path;

  return path;
}

function isInsideRunDir(relPath: string): boolean {
  return relPath === '' || (!relPath.startsWith('..') && !isAbsolute(relPath));
}

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
  let videoRelPaths: string[] = [];
  if (existsSync(videosDir)) {
    const webms = readdirSync(videosDir).filter((f) => f.endsWith('.webm'));
    if (webms.length > 0) {
      webms.sort();
      videoRelPaths = webms.map((f) => `evidence/videos/${f}`);
    }
  }
  return { events, screenshots: { byObservationRef, byEventId }, videoRelPaths };
}

function formatDuration(s: number): string {
  if (s < 60) return `${s.toFixed(0)}s`;
  const m = Math.floor(s / 60);
  const sec = Math.round(s % 60);
  return `${m}m ${sec}s`;
}

function formatCompactInteger(n: number): string {
  if (!Number.isFinite(n)) return 'n/a';
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(n >= 10_000_000 ? 0 : 1)}M`;
  if (n >= 1_000) return `${(n / 1_000).toFixed(n >= 100_000 ? 0 : 1)}k`;
  return String(Math.round(n));
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
