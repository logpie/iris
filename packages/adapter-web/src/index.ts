import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import type {
  AdapterArtifacts,
  AdapterConfig,
  EvidenceFile,
  EvidenceRef,
  InteractionKit,
  Observation,
  OutcomeContract,
  PreflightProbe,
  ProbeResult,
  ProbeSpec,
  TargetAdapter,
  TargetKind,
  ToolResult,
  ToolSpec,
} from '@iris/adapter-types';
import type { llm } from '@iris/core';
import { WEB_INTERACTION_KIT, WEB_OUTCOME_CONTRACT } from './contract.js';
import { type RichContentItem, formatRichContent, richContent } from './dom/rich-content.js';
export { richContent, formatRichContent, type RichContentItem };
import { domOutline } from './dom/snapshot.js';
import { WebLifecycle } from './lifecycle.js';
import { runAxe } from './probes/axe.js';
import { ConsoleProbe } from './probes/console.js';
import { runLighthouse } from './probes/lighthouse.js';
import { NetworkProbe } from './probes/network.js';
import { runNotificationsProbe } from './probes/notifications.js';
import { WEB_PROBE_SPECS } from './probes/probe-spec.js';
import {
  type StepScreenshotIndex,
  computeClipWindows,
  findRunVideo,
  sliceEvidenceClips,
  sliceEvidenceScreenshots,
} from './recording/index.js';
import { click, hover, press, type as typeText } from './tools/action.js';
import {
  doubleClick,
  hoverWait,
  rightClick,
  visionDoubleClick,
  visionHoverWait,
  visionRightClick,
} from './tools/click-variants.js';
import { drag, visionDrag } from './tools/drag.js';
import { keyChord } from './tools/key-chord.js';
import { back, forward, navigate, reload, scroll, waitFor } from './tools/navigation.js';
import { paste, visionPaste } from './tools/paste.js';
import { WEB_TOOL_SPECS } from './tools/tool-spec.js';
import { upload } from './tools/upload.js';
import { screenshot, visionClick, visionDescribe } from './tools/vision.js';

// Phase 8: vision_describer is a transport-agnostic callback the adapter uses
// for vision_describe. The SDK transport passes a function that calls the
// Agent SDK with an image message; the api transport passes one backed by
// the existing LlmClient. This avoids forcing the SDK to construct an
// LlmClient just for vision.
export type VisionDescriber = (input: {
  imagePath: string;
  prompt: string;
  model?: string;
}) => Promise<{ text: string }>;

export interface WebTargetAdapterOptions {
  headless?: boolean;
  vision_llm_client?: llm.LlmClient;
  vision_describer?: VisionDescriber;
  /** Phase 18: hydrate the BrowserContext from a storageState JSON file (cookies +
   * localStorage). When provided, the session starts already authenticated.
   * Pair with exportStorageState() on a "boot" adapter to share auth across
   * parallel sessions. */
  storage_state_path?: string;
}

export class WebTargetAdapter implements TargetAdapter {
  readonly kind: TargetKind = 'web';

  private lifecycle: WebLifecycle | null = null;
  private outDir = '';
  private evidenceDir = '';
  private screenshotsDir = '';
  private videoDir = '';
  private tracePath = '';
  private observationCounter = 0;
  private screenshotIndex: StepScreenshotIndex = {};
  private consoleProbe: ConsoleProbe | null = null;
  private networkProbe: NetworkProbe | null = null;
  private eventTimestamps: Record<string, number> = {};
  private recordingStartedTs = 0;
  private targetUrl = '';
  private startGotoStatus = 0;
  private startGotoErrorKind: PreflightProbe['gotoErrorKind'];
  private pageErrorListener: ((e: Error) => void) | null = null;

  constructor(private readonly opts: WebTargetAdapterOptions = {}) {}

  async start(config: AdapterConfig): Promise<void> {
    this.outDir = config.out_dir;
    this.evidenceDir = join(config.out_dir, 'evidence');
    this.screenshotsDir = join(this.evidenceDir, 'screenshots');
    this.videoDir = join(this.evidenceDir, 'videos');
    this.tracePath = join(this.evidenceDir, 'trace.zip');
    mkdirSync(this.screenshotsDir, { recursive: true });
    mkdirSync(this.videoDir, { recursive: true });

    this.lifecycle = new WebLifecycle({
      headless: this.opts.headless ?? true,
      record_video_dir: this.videoDir,
      trace_out_path: this.tracePath,
      ...(this.opts.storage_state_path
        ? { storage_state_path: this.opts.storage_state_path }
        : {}),
    });
    await this.lifecycle.start();
    this.recordingStartedTs = Date.now() / 1000;

    const page = this.lifecycle.getPage();
    this.consoleProbe = new ConsoleProbe(page);
    this.networkProbe = new NetworkProbe(page);
    this.consoleProbe.attach();
    this.networkProbe.attach();

    // Forward pageerror (uncaught exceptions) into the console probe buffer
    // so preflight's console-clean check can see them.
    this.pageErrorListener = (err: Error) => {
      this.consoleProbe?.pushExternal('pageerror', `Uncaught: ${err.message}`);
    };
    page.on('pageerror', this.pageErrorListener);

    this.targetUrl = config.target ?? '';
    if (config.target) {
      try {
        const response = await page.goto(config.target, { waitUntil: 'domcontentloaded' });
        this.startGotoStatus = response?.status() ?? 0;
      } catch (err) {
        this.startGotoStatus = 0;
        const msg = err instanceof Error ? err.message : String(err);
        if (/ERR_NAME_NOT_RESOLVED|getaddrinfo/i.test(msg)) this.startGotoErrorKind = 'dns';
        else if (/Timeout/i.test(msg)) this.startGotoErrorKind = 'timeout';
        else if (/ERR_CONNECTION|ERR_SSL/i.test(msg)) this.startGotoErrorKind = 'connection';
        else this.startGotoErrorKind = 'other';
      }
    }
  }

  async preflightProbe(opts: { timeoutS: number }): Promise<PreflightProbe> {
    if (!this.lifecycle) {
      return {
        httpStatus: 0,
        loadFinished: false,
        gotoErrorKind: 'other',
        consoleMessages: [],
        bodyStats: { textChars: 0, interactiveCount: 0 },
      };
    }
    const page = this.lifecycle.getPage();
    // Wait for networkidle to ensure SPAs hydrate before we measure content.
    // start() already did domcontentloaded; this completes the load.
    let loadFinished = true;
    try {
      await page.waitForLoadState('networkidle', { timeout: opts.timeoutS * 1000 });
    } catch {
      loadFinished = false;
    }
    // If start() failed (DNS/connection), report that explicitly.
    if (this.startGotoErrorKind) loadFinished = false;

    let bodyStats = { textChars: 0, interactiveCount: 0 };
    try {
      bodyStats = await page.evaluate(() => ({
        textChars: document.body?.innerText?.length ?? 0,
        interactiveCount: document.querySelectorAll(
          'a, button, input, select, textarea, [role=button], [role=link]',
        ).length,
      }));
    } catch {
      // Page never rendered. bodyStats stays zero; body_has_content fails.
    }

    const screenshotPath = join(this.screenshotsDir, 'preflight.png');
    try {
      await page.screenshot({ path: screenshotPath });
    } catch {
      // Screenshot failures are non-fatal.
    }

    const consoleMessages =
      this.consoleProbe?.snapshot().map((e) => ({ level: e.type, text: e.text })) ?? [];

    const probe: PreflightProbe = {
      httpStatus: this.startGotoStatus,
      loadFinished,
      consoleMessages,
      bodyStats,
      screenshot: screenshotPath,
    };
    if (this.startGotoErrorKind) probe.gotoErrorKind = this.startGotoErrorKind;
    return probe;
  }

  /** Phase 18: serialize the current BrowserContext's cookies + localStorage to
   * a JSON file. Call BEFORE stop(). The output path can then be passed to
   * another adapter via WebTargetAdapterOptions.storage_state_path to start
   * that session already authenticated. */
  async exportStorageState(outPath: string): Promise<void> {
    if (!this.lifecycle) throw new Error('adapter not started');
    await this.lifecycle.getContext().storageState({ path: outPath });
  }

  async stop(): Promise<AdapterArtifacts> {
    if (this.lifecycle) {
      this.consoleProbe?.detach();
      this.networkProbe?.detach();
      if (this.pageErrorListener) {
        try {
          this.lifecycle.getPage().off('pageerror', this.pageErrorListener);
        } catch {
          // page may be gone already
        }
        this.pageErrorListener = null;
      }
      await this.lifecycle.stop();
      this.lifecycle = null;
    }
    const video = findRunVideo(this.videoDir);
    return {
      evidence_dir: this.evidenceDir,
      artifact_files: {
        ...(video ? { full_recording: video } : {}),
        trace_zip: this.tracePath,
      },
    };
  }

  listTools(): ToolSpec[] {
    return WEB_TOOL_SPECS;
  }

  async callTool(name: string, args: Record<string, unknown>): Promise<ToolResult> {
    if (!this.lifecycle) return { ok: false, error: 'adapter not started' };
    const page = this.lifecycle.getPage();
    switch (name) {
      case 'click':
        return click(page, args as { selector: string });
      case 'type':
        return typeText(page, args as { selector: string; text: string });
      case 'press':
        return press(page, args as { key: string });
      case 'hover':
        return hover(page, args as { selector: string });
      case 'navigate':
        return navigate(page, args as { url: string });
      case 'back':
        return back(page, args);
      case 'forward':
        return forward(page, args);
      case 'reload':
        return reload(page, args);
      case 'scroll':
        return scroll(page, args as { dx: number; dy: number });
      case 'wait_for':
        return waitFor(
          page,
          args as { selector?: string; network_idle?: boolean; timeout_ms?: number },
        );
      case 'screenshot': {
        const stepName = `step-${String(this.observationCounter).padStart(4, '0')}-${Date.now()}`;
        const fullPage = (args as { full_page?: boolean }).full_page;
        const r = await screenshot(page, {
          out_dir: this.screenshotsDir,
          name: stepName,
          ...(fullPage !== undefined ? { full_page: fullPage } : {}),
        });
        return r;
      }
      case 'vision_click':
        return visionClick(page, args as { x: number; y: number; reason?: string });
      case 'vision_describe': {
        const stepName = `vision-${String(this.observationCounter).padStart(4, '0')}-${Date.now()}`;
        return visionDescribe(page, {
          out_dir: this.screenshotsDir,
          name: stepName,
          ...(this.opts.vision_llm_client ? { llm_client: this.opts.vision_llm_client } : {}),
          ...(this.opts.vision_describer ? { describer: this.opts.vision_describer } : {}),
          ...(args as { region?: string; model?: string }),
        });
      }
      // Phase 9 — new interaction primitives.
      case 'drag':
        return drag(page, args as { selector: string; dx: number; dy: number; hold_ms?: number });
      case 'vision_drag':
        return visionDrag(
          page,
          args as {
            from: { x: number; y: number };
            to: { x: number; y: number };
            hold_ms?: number;
            reason?: string;
          },
        );
      case 'key_chord':
        return keyChord(page, args as { keys: string[] });
      case 'paste':
        return paste(page, args as { selector: string; text: string });
      case 'vision_paste':
        return visionPaste(page, args as { x: number; y: number; text: string });
      case 'right_click':
        return rightClick(page, args as { selector: string });
      case 'vision_right_click':
        return visionRightClick(page, args as { x: number; y: number; reason?: string });
      case 'double_click':
        return doubleClick(page, args as { selector: string });
      case 'vision_double_click':
        return visionDoubleClick(page, args as { x: number; y: number; reason?: string });
      case 'hover_wait':
        return hoverWait(page, args as { selector: string; wait_ms?: number });
      case 'vision_hover_wait':
        return visionHoverWait(page, args as { x: number; y: number; wait_ms?: number });
      case 'upload':
        return upload(page, args as { selector: string; file_path?: string; mime?: string });
      default:
        return { ok: false, error: `unknown tool: ${name}` };
    }
  }

  async observe(): Promise<Observation> {
    if (!this.lifecycle) throw new Error('adapter not started');
    const page = this.lifecycle.getPage();
    this.observationCounter++;
    const ref = `OBS-${String(this.observationCounter).padStart(6, '0')}`;
    const stepName = `step-${String(this.observationCounter).padStart(4, '0')}`;
    const screenshotPath = join(this.screenshotsDir, `${stepName}.png`);
    await page.screenshot({ path: screenshotPath });
    this.screenshotIndex[ref] = screenshotPath;
    this.eventTimestamps[ref] = Date.now() / 1000;

    const outline = await domOutline(page);
    // Dogfood discovery 2026-05-11: a11y outline lists structural elements
    // (header / nav / h1 / button / link) but skips paragraph/span/div text.
    // On every real marketing page tested (Stripe, Linear, Anthropic) the
    // Explorer was effectively blind to the actual product copy. Include
    // body innerText alongside the outline so the Explorer can read what
    // a user reads.
    const bodyText = await page
      .evaluate(() => {
        const t = document.body?.innerText ?? '';
        // Normalize whitespace, drop runs of blank lines.
        return t
          .replace(/[ \t]+/g, ' ')
          .replace(/\n{2,}/g, '\n')
          .trim();
      })
      .catch(() => '');
    const url = page.url();
    const title = await page.title();

    // Phase 11: extract content from rich-input surfaces (textarea / input
    // values, contenteditable text, CodeMirror/Monaco/ACE editors).
    // body.innerText is blind to all of these — Dillinger's editor content
    // never appeared in observations before this change.
    const richItems = await richContent(page).catch(() => []);
    const richSection = formatRichContent(richItems);

    const outlinePart = outline.slice(0, 2500);
    const textPart = bodyText.slice(0, 3000);
    const richPart = richSection ? `\n\n## RICH CONTENT\n${richSection}` : '';
    const summary =
      `${title}\n\n## VISIBLE TEXT\n${textPart}${richPart}\n\n## OUTLINE\n${outlinePart}`.trim();
    return {
      observation_ref: ref,
      summary,
      payload: {
        url,
        title,
        screenshot_ref: screenshotPath,
        outline,
        body_text: bodyText,
        rich_content: richItems,
      },
    };
  }

  listProbes(): ProbeSpec[] {
    return WEB_PROBE_SPECS;
  }

  async runProbe(name: string, args: Record<string, unknown>): Promise<ProbeResult> {
    if (!this.lifecycle) return { ok: false, probe: name, error: 'adapter not started' };
    const page = this.lifecycle.getPage();
    if (name === 'axe') return runAxe(page);
    if (name === 'lighthouse') return runLighthouse(page);
    if (name === 'notifications_visible') return runNotificationsProbe(page);
    if (name.startsWith('console_') && this.consoleProbe) {
      return this.consoleProbe.runProbe(name, args);
    }
    if (name.startsWith('network_') && this.networkProbe) {
      return this.networkProbe.runProbe(name, args);
    }
    return { ok: false, probe: name, error: `unknown probe: ${name}` };
  }

  // Phase 6 F3: orchestrator can inject the {event_id → ts} map built from
  // trace.jsonl (the trace events use ULID ids; the adapter's internal
  // eventTimestamps map is keyed by observation_ref). Merging these gives
  // sliceEvidence enough to clip videos for findings citing trace event ids.
  injectEventTimestamps(extra: Record<string, number>): void {
    for (const [id, ts] of Object.entries(extra)) {
      this.eventTimestamps[id] = ts;
    }
  }

  // Phase 9: declared interaction surface. Orchestrator emits this as an
  // interaction_kit trace event at run start so the Judge sees the kit.
  interactionKit(): InteractionKit {
    return WEB_INTERACTION_KIT;
  }

  // Phase 9: outcome-evidence contract. Goal-claim validator uses this to
  // verify the Judge's `verified` claims cite real outcome artifacts.
  outcomeContract(): OutcomeContract {
    return WEB_OUTCOME_CONTRACT;
  }

  async sliceEvidence(refs: EvidenceRef[]): Promise<EvidenceFile[]> {
    const video = findRunVideo(this.videoDir);
    if (video) {
      const recordingDuration = Date.now() / 1000 - this.recordingStartedTs;
      const windows = computeClipWindows(refs, {
        event_ts: this.eventTimestamps,
        recording_started_ts: this.recordingStartedTs,
        recording_duration_s: recordingDuration,
      });
      if (windows.length > 0) {
        const clipsDir = join(this.evidenceDir, 'clips');
        const clips = await sliceEvidenceClips(refs, video, windows, clipsDir);
        if (clips.length > 0) {
          // Fill in any refs that didn't get clips with screenshots
          const matchedIds = new Set(clips.map((c) => c.finding_id));
          const missing = refs.filter((r) => !matchedIds.has(r.finding_id));
          const screenshots = sliceEvidenceScreenshots(missing, this.screenshotIndex);
          return [...clips, ...screenshots];
        }
      }
    }
    return sliceEvidenceScreenshots(refs, this.screenshotIndex);
  }
}
