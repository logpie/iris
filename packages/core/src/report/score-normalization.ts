import type { JudgeOutput } from '../judge/judge.js';
import { buildTraceIndexById, resolveTraceRefTypo } from '../trace/ref-resolver.js';
import type { TraceEvent } from '../trace/schema.js';

type Scores = JudgeOutput['scores'];
type ScoreProfile = Scores['profiles'][string];
type ScoreDimension = ScoreProfile['dimensions'][string];

const RESPONSIVE_UNTESTED_RATIONALE =
  'Not scored: mobile/responsive behavior was not exercised in this run.';
const AXE_FAILED_RATIONALE_PREFIX = 'Not scored: axe probe did not run.';
const INSTRUMENTATION_CONSOLE_RATIONALE =
  'No product console errors; ignored Iris instrumentation CSP error.';

export function normalizeReportScores(
  scores: Scores,
  opts: { traceEvents?: TraceEvent[] | undefined; confidenceCaveats?: string[] | undefined } = {},
): Scores {
  const mobileResponsiveExercised = opts.traceEvents
    ? traceHasMobileViewport(opts.traceEvents)
    : caveatsSayMobileWasTested(opts.confidenceCaveats ?? [])
      ? true
      : undefined;
  const traceIndexById = opts.traceEvents ? buildTraceIndexById(opts.traceEvents) : undefined;
  const traceEventById = opts.traceEvents
    ? new Map(opts.traceEvents.map((event) => [event.id, event]))
    : undefined;
  const resolveEvidence = (refs: string[]) =>
    opts.traceEvents && traceIndexById
      ? refs.map((ref) => resolveTraceRefTypo(ref, opts.traceEvents!, traceIndexById) ?? ref)
      : refs;
  return {
    ...scores,
    overall: {
      ...scores.overall,
      score: normalizeScore(scores.overall.score) ?? 0,
    },
    profiles: Object.fromEntries(
      Object.entries(scores.profiles).map(([profileName, profile]) => [
        profileName,
        {
          ...profile,
          score: normalizeScore(profile.score) ?? 0,
          dimensions: Object.fromEntries(
            Object.entries(profile.dimensions).map(([dimensionName, dimension]) => [
              dimensionName,
              normalizeReportScoreDimension(
                profileName,
                dimensionName,
                {
                  ...dimension,
                  evidence: resolveEvidence(dimension.evidence),
                },
                {
                  mobileResponsiveExercised,
                  ...(opts.traceEvents ? { traceEvents: opts.traceEvents } : {}),
                  ...(traceEventById ? { traceEventById } : {}),
                },
              ),
            ]),
          ),
        },
      ]),
    ),
  };
}

export function scoreDimensionWithRunEvidence(
  profileName: string,
  dimensionName: string,
  dimension: ScoreDimension,
  traceEvents: Iterable<TraceEvent> | undefined,
): ScoreDimension {
  if (!traceEvents) return dimension;
  return normalizeReportScoreDimension(profileName, dimensionName, dimension, {
    mobileResponsiveExercised: traceHasMobileViewport(traceEvents),
    preserveScale: true,
  });
}

function normalizeReportScoreDimension(
  profileName: string,
  dimensionName: string,
  dimension: ScoreDimension,
  opts: {
    mobileResponsiveExercised?: boolean | undefined;
    preserveScale?: boolean | undefined;
    traceEvents?: TraceEvent[] | undefined;
    traceEventById?: Map<string, TraceEvent> | undefined;
  },
): ScoreDimension {
  const normalized = opts.preserveScale
    ? dimension
    : { ...dimension, score: normalizeScore(dimension.score) };
  if (
    normalized.score !== null &&
    opts.mobileResponsiveExercised === false &&
    isResponsiveDimension(profileName, dimensionName)
  ) {
    return {
      ...normalized,
      score: null,
      evidence: [],
      rationale: RESPONSIVE_UNTESTED_RATIONALE,
    };
  }
  const probeNormalized = normalizeProbeBackedDimension(
    profileName,
    dimensionName,
    normalized,
    opts,
  );
  if (probeNormalized) return probeNormalized;
  return normalized;
}

export function deriveProbeConfidenceCaveats(events: TraceEvent[] | undefined): string[] {
  if (!events) return [];
  const caveats: string[] = [];
  for (const event of events) {
    if (!isProbeEvent(event, 'axe')) continue;
    if (probeOk(event) === false) {
      caveats.push(`${AXE_FAILED_RATIONALE_PREFIX} ${summarizeProbeError(event)}`);
      break;
    }
  }
  return caveats;
}

function normalizeProbeBackedDimension(
  profileName: string,
  dimensionName: string,
  dimension: ScoreDimension,
  opts: { traceEvents?: TraceEvent[] | undefined; traceEventById?: Map<string, TraceEvent> | undefined },
): ScoreDimension | undefined {
  if (!opts.traceEvents || !opts.traceEventById) return undefined;
  const text = `${profileName} ${dimensionName}`.replace(/[_-]/g, ' ').toLowerCase();
  const events = dimension.evidence
    .map((ref) => opts.traceEventById!.get(ref))
    .filter((event): event is TraceEvent => Boolean(event));

  if (isAxeDimension(text)) {
    const failedAxe = events.find((event) => isProbeEvent(event, 'axe') && probeOk(event) === false);
    if (failedAxe) {
      return {
        ...dimension,
        score: null,
        rationale: `${AXE_FAILED_RATIONALE_PREFIX} ${summarizeProbeError(failedAxe)}`,
        evidence: [failedAxe.id],
      };
    }
  }

  if (isConsoleCleanDimension(text)) {
    const consoleEvents = events.filter((event) => isProbeEvent(event, 'console_errors_since'));
    if (
      consoleEvents.length > 0 &&
      consoleEvents.every((event) => consoleProbeHasOnlyInstrumentationErrors(event))
    ) {
      return {
        ...dimension,
        score: 10,
        rationale: INSTRUMENTATION_CONSOLE_RATIONALE,
        evidence: consoleEvents.map((event) => event.id),
      };
    }
  }

  return undefined;
}

function isAxeDimension(text: string): boolean {
  return /\b(axe|a11y|accessibility)\b/.test(text);
}

function isConsoleCleanDimension(text: string): boolean {
  return /\bconsole clean\b|\bconsole\b/.test(text);
}

function isProbeEvent(event: TraceEvent, probe: string): boolean {
  const payload = event.payload as Record<string, unknown>;
  return event.kind === 'probe_result' && payload.probe === probe;
}

function probeOk(event: TraceEvent): boolean | undefined {
  const payload = event.payload as Record<string, unknown>;
  return typeof payload.ok === 'boolean' ? payload.ok : undefined;
}

function summarizeProbeError(event: TraceEvent): string {
  const payload = event.payload as Record<string, unknown>;
  const raw = typeof payload.error === 'string' ? payload.error : 'Probe failed.';
  if (/Content Security Policy|CSP/i.test(raw)) {
    return 'Content Security Policy blocked Iris instrumentation.';
  }
  return raw.length > 120 ? `${raw.slice(0, 117)}...` : raw;
}

function consoleProbeHasOnlyInstrumentationErrors(event: TraceEvent): boolean {
  const payload = event.payload as Record<string, unknown>;
  const summary = plainObject(payload.summary) ? payload.summary : {};
  const data = plainObject(payload.data) ? payload.data : {};
  const instrumentationCount = numberFrom(summary.instrumentation_error_count);
  const appErrors = Array.isArray(data.app_errors) ? data.app_errors : [];
  const productAppErrors = appErrors.filter((entry) => {
    const text =
      plainObject(entry) && typeof entry.text === 'string'
        ? entry.text
        : typeof entry === 'string'
          ? entry
          : '';
    return !isIrisInstrumentationConsoleError(text);
  });
  const inferredInstrumentationCount =
    instrumentationCount +
    appErrors.length -
    productAppErrors.length +
    (Array.isArray(data.instrumentation_errors) ? data.instrumentation_errors.length : 0);
  return inferredInstrumentationCount > 0 && productAppErrors.length === 0;
}

function isIrisInstrumentationConsoleError(text: string): boolean {
  return /Executing inline script violates .*Content Security Policy.*The action has been blocked/i.test(
    text,
  );
}

function numberFrom(value: unknown): number {
  const n = Number(value);
  return Number.isFinite(n) ? n : 0;
}

function normalizeScore(value: number | null): number | null {
  if (value === null) return null;
  if (!Number.isFinite(value)) return 0;
  const scaled = value > 10 && value <= 100 ? value / 10 : value;
  return Math.max(0, Math.min(10, Number(scaled.toFixed(2))));
}

function isResponsiveDimension(profileName: string, dimensionName: string): boolean {
  const text = `${profileName} ${dimensionName}`.replace(/[_-]/g, ' ').toLowerCase();
  return /\b(mobile|responsive)\b/.test(text);
}

function caveatsSayMobileWasTested(caveats: string[]): boolean {
  const joined = caveats.join(' ').toLowerCase();
  if (!joined) return false;
  return (
    /mobile/.test(joined) &&
    !/(no mobile|mobile (?:was )?not|not tested|not exercised)/.test(joined)
  );
}

function traceHasMobileViewport(events: Iterable<TraceEvent>): boolean {
  for (const event of events) {
    const viewport = viewportFromPayload(event.payload);
    if (viewport && viewport.width > 0 && viewport.width <= 640) return true;
  }
  return false;
}

function viewportFromPayload(
  payload: Record<string, unknown>,
): { width: number; height?: number } | undefined {
  const direct = plainObject(payload.viewport) ? payload.viewport : undefined;
  const perception = plainObject(payload.perception_state) ? payload.perception_state : undefined;
  const nested = perception && plainObject(perception.viewport) ? perception.viewport : undefined;
  const raw = direct ?? nested;
  if (!raw) return undefined;
  const width = Number(raw.width);
  const height = Number(raw.height);
  if (!Number.isFinite(width)) return undefined;
  return { width, ...(Number.isFinite(height) ? { height } : {}) };
}

function plainObject(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === 'object' && !Array.isArray(value));
}
