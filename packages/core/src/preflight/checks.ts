// Preflight checks — fast, pure functions that decide whether a target is
// healthy enough to evaluate. Designed to run against the data captured by
// the adapter's preflightProbe() — no side effects, no LLM calls.

export interface CheckResult {
  ok: boolean;
  name: string;
  detail?: string;
}

// Patterns that match the kind of JavaScript errors a real user notices.
// We intentionally keep this list short and conservative — false positives
// (an app gets blocked because of a noisy CORS warning) erode trust faster
// than missed crashes.
const FATAL_PATTERNS: RegExp[] = [
  /Uncaught\s+(TypeError|ReferenceError|SyntaxError|RangeError)/i,
  /Minified React error/i,
  /Cannot read prop(erties)? of (null|undefined)/i,
  /is not a function/i,
  /ChunkLoadError/i,
];

export function checkHttpStatus(status: number, gotoErrorKind?: string): CheckResult {
  if (gotoErrorKind === 'dns') {
    return { ok: false, name: 'http_status', detail: 'DNS resolution failed' };
  }
  if (gotoErrorKind === 'connection') {
    return { ok: false, name: 'http_status', detail: 'connection refused or SSL error' };
  }
  if (status >= 200 && status < 400) return { ok: true, name: 'http_status' };
  if (status === 0) return { ok: false, name: 'http_status', detail: 'no response' };
  return { ok: false, name: 'http_status', detail: `HTTP ${status}` };
}

export function checkPageReady(loadFinished: boolean, timeoutS: number): CheckResult {
  if (loadFinished) return { ok: true, name: 'page_ready' };
  return {
    ok: false,
    name: 'page_ready',
    detail: `page did not reach networkidle within ${timeoutS}s`,
  };
}

export function checkConsoleClean(messages: Array<{ level: string; text: string }>): CheckResult {
  const fatals = messages.filter(
    (m) =>
      (m.level === 'error' || m.level === 'pageerror') &&
      FATAL_PATTERNS.some((p) => p.test(m.text)),
  );
  if (fatals.length === 0) return { ok: true, name: 'console_clean' };
  const first = fatals[0];
  return {
    ok: false,
    name: 'console_clean',
    detail: `${fatals.length} fatal console error(s); first: "${first?.text.slice(0, 120) ?? ''}"`,
  };
}

export function checkBodyHasContent(stats: {
  textChars: number;
  interactiveCount: number;
}): CheckResult {
  // Thresholds re-tuned 2026-05-11 after dogfooding caught a real bug:
  // a legitimate small sign-in form (11 chars / 3 interactive) was being
  // blocked. Real-world apps vary wildly in visible-text density; the only
  // case worth catching here is "truly nothing rendered." Make the check
  // strict-AND with very low thresholds so it doesn't fire on minimal-but-real
  // pages.
  //
  // Verified post-fix:
  //   blank page:           0 chars / 0 interactive → FAIL (correct)
  //   bench fixture 02:    11 chars / 3 interactive → pass
  //   example.com:        129 chars / 1 interactive → pass
  //   TodoMVC SPA:        616 chars / 12 interactive → pass
  //   404 (with rich body): caught by http_status check, not this one
  const veryLittleText = stats.textChars < 10;
  const noInteractive = stats.interactiveCount < 1;
  if (veryLittleText && noInteractive) {
    return {
      ok: false,
      name: 'body_has_content',
      detail: `body has ${stats.textChars} chars / ${stats.interactiveCount} interactive elements`,
    };
  }
  return { ok: true, name: 'body_has_content' };
}
