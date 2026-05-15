import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import type { Page } from 'playwright';
import type {
  AdapterArtifacts,
  AdapterConfig,
  DiscoverySurvey,
  DiscoverySurveyCapture,
  DiscoverySurveyControl,
  DiscoverySurveySurface,
  DiscoverySurfaceKind,
  DiscoverySurfaceSource,
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
import { runUiState } from './probes/ui-state.js';
import {
  type StepScreenshotIndex,
  type ScreenshotFrame,
  computeClipWindows,
  findRunVideo,
  sliceEvidenceClips,
  sliceEvidenceScreenshotClips,
  sliceEvidenceScreenshots,
} from './recording/index.js';
import { click, hover, press, selectOption, type as typeText } from './tools/action.js';
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
  private screenshotTimeline: ScreenshotFrame[] = [];
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
      case 'select_option':
        return selectOption(
          page,
          args as { selector: string; value?: string; label?: string; index?: number },
        );
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
    const observedAt = Date.now() / 1000;
    await page.screenshot({ path: screenshotPath });
    this.screenshotIndex[ref] = screenshotPath;
    this.eventTimestamps[ref] = observedAt;
    this.screenshotTimeline.push({ ref, path: screenshotPath, ts: observedAt });

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

  async discoverySurvey(opts: {
    max_scrolls?: number;
    peek_menus?: boolean;
    dismiss_banners?: boolean;
    sample_links?: number;
  } = {}): Promise<DiscoverySurvey> {
    if (!this.targetUrl) return { summary: '' };
    const lifecycle = new WebLifecycle({
      headless: this.opts.headless ?? true,
      ...(this.opts.storage_state_path ? { storage_state_path: this.opts.storage_state_path } : {}),
    });
    const sections: string[] = [];
    const captures: DiscoverySurveyCapture[] = [];
    const surfaces: DiscoverySurveySurface[] = [];
    const links: Array<{
      label: string;
      href: string;
      same_origin: boolean;
      source: DiscoverySurfaceSource;
    }> = [];
    const surfaceKeys = new Set<string>();
    let surfaceCounter = 1;
    const maxScrolls = Math.max(0, Math.min(opts.max_scrolls ?? 2, 4));
    const maxSampleLinks = Math.max(0, Math.min(opts.sample_links ?? 3, 3));

    const capture = async (label: string) => {
      const page = lifecycle.getPage();
      const snapshot = await page.evaluate((sectionLabel) => {
        const text = (document.body?.innerText ?? '')
          .replace(/[ \t]+/g, ' ')
          .replace(/\n{2,}/g, '\n')
          .trim()
          .slice(0, 2200);
        const controls = Array.from(
          document.querySelectorAll('a, button, input, select, textarea, summary, [role=button]'),
        )
          .filter((el) => {
            const html = el as HTMLElement;
            const rect = html.getBoundingClientRect();
            const style = window.getComputedStyle(html);
            return (
              rect.width > 0 &&
              rect.height > 0 &&
              style.visibility !== 'hidden' &&
              style.display !== 'none'
            );
          })
          .slice(0, 60)
          .map((el) => {
            const html = el as HTMLElement;
            const input = el as HTMLInputElement;
            return {
              tag: el.tagName.toLowerCase(),
              name: (html.innerText || html.getAttribute('aria-label') || html.getAttribute('title') || '')
                .replace(/\s+/g, ' ')
                .trim()
                .slice(0, 120),
              href: el instanceof HTMLAnchorElement ? el.href : undefined,
              role: el.getAttribute('role') ?? undefined,
              type: el instanceof HTMLInputElement ? input.type : undefined,
              ariaExpanded: el.getAttribute('aria-expanded') ?? undefined,
              checked: el instanceof HTMLInputElement ? input.checked : undefined,
              disabled:
                el instanceof HTMLButtonElement ||
                el instanceof HTMLInputElement ||
                el instanceof HTMLSelectElement ||
                el instanceof HTMLTextAreaElement
                  ? el.disabled
                  : undefined,
            };
          });
        return {
          label: sectionLabel,
          url: location.href,
          title: document.title,
          scrollY: window.scrollY,
          text,
          controls,
        };
      }, label);
      const captureId = `C${String(captures.length + 1).padStart(3, '0')}`;
      const source = discoverySourceForLabel(label);
      const captureRecord: DiscoverySurveyCapture = {
        id: captureId,
        label: snapshot.label,
        url: snapshot.url,
        title: snapshot.title,
        scrollY: snapshot.scrollY,
        text: snapshot.text,
        controls: snapshot.controls.map((control) => surveyControl(control)),
      };
      const controlsText = snapshot.controls
        .map((control) => {
          const parts = [control.tag, control.name ? `"${control.name}"` : '', control.href ?? '']
            .filter(Boolean)
            .join(' ');
          return `- ${parts}`;
        })
        .join('\n');
      const sectionText =
        `### ${label}\nURL: ${snapshot.url}\nSCROLL_Y: ${snapshot.scrollY}\nVISIBLE TEXT:\n${snapshot.text}\nVISIBLE CONTROLS:\n${controlsText}`.trim();
      if (label.startsWith('after primary')) {
        captures.unshift(captureRecord);
        sections.unshift(sectionText);
      } else {
        captures.push(captureRecord);
        sections.push(sectionText);
      }
      const pageSurface = surfaceFromCapture(captureRecord, source, captureId);
      addSurface(pageSurface);
      for (const control of captureRecord.controls ?? []) {
        const surface = surfaceFromControl(control, captureRecord.url, source, captureId);
        if (surface) addSurface(surface);
        if (control.href) {
          links.push({
            label: control.name ?? control.href,
            href: control.href,
            same_origin: sameOrigin(control.href, this.targetUrl ?? control.href),
            source,
          });
        }
      }
    };

    const addSurface = (surface: Omit<DiscoverySurveySurface, 'id'>) => {
      const key = `${surface.kind}|${surface.url}|${surface.label.toLowerCase()}|${
        surface.controls?.map((control) => control.href ?? control.name ?? '').join('|') ?? ''
      }`;
      if (surfaceKeys.has(key)) return;
      surfaceKeys.add(key);
      surfaces.push({
        id: `S${String(surfaceCounter++).padStart(3, '0')}`,
        ...surface,
      });
    };

    try {
      await lifecycle.start();
      const page = lifecycle.getPage();
      await page.goto(this.targetUrl, { waitUntil: 'domcontentloaded' });
      await page.waitForLoadState('networkidle', { timeout: 5000 }).catch(() => {});
      await capture('initial viewport');
      await capturePrimarySearchJourney(page, capture);

      if (opts.peek_menus !== false) {
        const menuSelectors = await page
          .evaluate(() =>
            Array.from(document.querySelectorAll('button, summary, [role=button], label'))
              .filter((el) => {
                const html = el as HTMLElement;
                const text = `${html.innerText} ${html.getAttribute('aria-label') ?? ''} ${
                  html.getAttribute('title') ?? ''
                }`;
                const style = window.getComputedStyle(html);
                const rect = html.getBoundingClientRect();
                return (
                  rect.width > 0 &&
                  rect.height > 0 &&
                  style.display !== 'none' &&
                  style.visibility !== 'hidden' &&
                  (/menu|more|tools|appearance|settings|filter|sort|language|nav|☰|⋯|hide|show/i.test(
                    text,
                  ) ||
                    el.getAttribute('aria-haspopup') === 'true')
                );
              })
              .slice(0, 5)
              .map((el, index) => {
                const html = el as HTMLElement;
                if (!html.getAttribute('data-iris-survey-menu')) {
                  html.setAttribute('data-iris-survey-menu', String(index));
                }
                return `[data-iris-survey-menu="${index}"]`;
              }),
          )
          .catch(() => []);
        for (const selector of menuSelectors) {
          await page.click(selector, { timeout: 1000 }).catch(() => {});
          await page.waitForTimeout(150);
          await capture(`after peeking ${selector}`);
        }
      }

      if (opts.dismiss_banners) {
        const dismissSelectors = await page
          .evaluate(() =>
            Array.from(document.querySelectorAll('button, [role=button]'))
              .filter((el) => {
                const html = el as HTMLElement;
                const text = `${html.innerText} ${html.getAttribute('aria-label') ?? ''} ${
                  html.getAttribute('title') ?? ''
                }`;
                return /close|dismiss|no thanks|not now|hide|×|x/i.test(text);
              })
              .slice(0, 3)
              .map((el, index) => {
                const html = el as HTMLElement;
                html.setAttribute('data-iris-survey-dismiss', String(index));
                return `[data-iris-survey-dismiss="${index}"]`;
              }),
          )
          .catch(() => []);
        for (const selector of dismissSelectors) {
          await page.click(selector, { timeout: 1000 }).catch(() => {});
          await page.waitForTimeout(150);
          await capture(`after dismissing ${selector}`);
        }
      }

      const scrollHeight = await page.evaluate(() => document.documentElement.scrollHeight);
      const viewportHeight = await page.evaluate(() => window.innerHeight);
      for (let i = 1; i <= maxScrolls && scrollHeight > viewportHeight; i++) {
        await page.evaluate(
          ({ i: step, total }) => {
            const maxY = Math.max(0, document.documentElement.scrollHeight - window.innerHeight);
            window.scrollTo(0, Math.round((maxY * step) / total));
          },
          { i, total: maxScrolls },
        );
        await page.waitForTimeout(150);
        await capture(`scroll sample ${i}/${maxScrolls}`);
      }

      if (maxSampleLinks > 0) {
        const candidates = await discoverySampleLinks(page, this.targetUrl, maxSampleLinks);
        for (const candidate of candidates) {
          await page.goto(candidate.href, { waitUntil: 'domcontentloaded' }).catch(() => {});
          await page.waitForLoadState('domcontentloaded', { timeout: 2500 }).catch(() => {});
          await page.waitForLoadState('networkidle', { timeout: 2500 }).catch(() => {});
          await page.waitForTimeout(250);
          await capture(`sample nav: ${candidate.label}`);
        }
      }
    } finally {
      await lifecycle.stop().catch(() => {});
    }

    return {
      summary: `## DISCOVERY SURVEY\nDisposable browser context; the primary run state was not mutated.\n\n${sections.join('\n\n')}`.slice(
        0,
        12000,
      ),
      payload: {
        v: 2,
        captures,
        surfaces,
        links: dedupeDiscoveryLinks(links).slice(0, 80),
        limits: {
          max_scrolls: maxScrolls,
          peek_menus: opts.peek_menus !== false,
          dismiss_banners: opts.dismiss_banners === true,
          sample_links: maxSampleLinks,
        },
        sections: captures,
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
    if (name === 'ui_state') return runUiState(page, args as { selectors?: string[] });
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
    const clipsDir = join(this.evidenceDir, 'clips');
    const screenshotClips = await sliceEvidenceScreenshotClips(
      refs,
      this.screenshotTimeline,
      clipsDir,
    );
    const sequenceMatchedIds = new Set(screenshotClips.map((c) => c.finding_id));
    const remaining = refs.filter((r) => !sequenceMatchedIds.has(r.finding_id));
    if (remaining.length === 0) return screenshotClips;

    const video = findRunVideo(this.videoDir);
    if (video) {
      const recordingDuration = Date.now() / 1000 - this.recordingStartedTs;
      const windows = computeClipWindows(remaining, {
        event_ts: this.eventTimestamps,
        recording_started_ts: this.recordingStartedTs,
        recording_duration_s: recordingDuration,
      });
      if (windows.length > 0) {
        const clips = await sliceEvidenceClips(remaining, video, windows, clipsDir);
        if (clips.length > 0) {
          // Fill in any refs that didn't get clips with screenshots
          const matchedIds = new Set(clips.map((c) => c.finding_id));
          const missing = remaining.filter((r) => !matchedIds.has(r.finding_id));
          const screenshots = sliceEvidenceScreenshots(missing, this.screenshotIndex);
          return [...screenshotClips, ...clips, ...screenshots];
        }
      }
    }
    return [...screenshotClips, ...sliceEvidenceScreenshots(remaining, this.screenshotIndex)];
  }
}

function surveyControl(control: {
  tag?: string | undefined;
  role?: string | undefined;
  name?: string | undefined;
  href?: string | undefined;
  type?: string | undefined;
  ariaExpanded?: string | undefined;
  checked?: boolean | undefined;
  disabled?: boolean | undefined;
}): DiscoverySurveyControl {
  return {
    ...(control.tag ? { tag: control.tag } : {}),
    ...(control.role ? { role: control.role } : {}),
    ...(control.name ? { name: control.name } : {}),
    ...(control.href ? { href: control.href } : {}),
    ...(control.type ? { type: control.type } : {}),
    ...(control.ariaExpanded ? { ariaExpanded: control.ariaExpanded } : {}),
    ...(control.checked !== undefined ? { checked: control.checked } : {}),
    ...(control.disabled !== undefined ? { disabled: control.disabled } : {}),
  };
}

function discoverySourceForLabel(label: string): DiscoverySurfaceSource {
  if (label.startsWith('after primary')) return 'primary_journey';
  if (label.startsWith('after peeking')) return 'menu_peek';
  if (label.startsWith('after dismissing')) return 'banner_dismiss';
  if (label.startsWith('scroll sample')) return 'scroll';
  if (label.startsWith('sample nav')) return 'sample_nav';
  return 'initial';
}

function surfaceFromCapture(
  capture: DiscoverySurveyCapture,
  source: DiscoverySurfaceSource,
  captureId: string,
): Omit<DiscoverySurveySurface, 'id'> {
  const firstLine = capture.text?.split('\n').find((line) => line.trim().length > 0)?.trim();
  const label = (capture.title || firstLine || capture.label || 'Page surface').slice(0, 160);
  return {
    label,
    kind: source === 'primary_journey' || source === 'sample_nav' ? 'content' : 'page',
    url: capture.url,
    source,
    value: source === 'initial' || source === 'primary_journey' ? 'core' : 'important_secondary',
    confidence: 0.8,
    evidence: [{ ref: captureId, note: capture.label }],
    ...(capture.controls && capture.controls.length > 0
      ? { controls: capture.controls.slice(0, 12) }
      : {}),
  };
}

function surfaceFromControl(
  control: DiscoverySurveyControl,
  url: string,
  source: DiscoverySurfaceSource,
  captureId: string,
): Omit<DiscoverySurveySurface, 'id'> | null {
  const label = (control.name || control.href || control.role || control.tag || '').trim();
  if (!label) return null;
  const kind = discoveryKindForControl(control, url);
  const value = discoveryValueForSurface(kind, label, control.href, url);
  return {
    label: label.slice(0, 160),
    kind,
    url,
    source,
    value,
    confidence: 0.75,
    evidence: [{ ref: captureId, note: `${control.tag ?? 'control'} ${label}` }],
    controls: [control],
  };
}

function discoveryKindForControl(
  control: DiscoverySurveyControl,
  pageUrl: string,
): DiscoverySurfaceKind {
  const text = `${control.name ?? ''} ${control.href ?? ''}`.toLowerCase();
  if (control.href && !sameOrigin(control.href, pageUrl)) return 'external';
  if (/\b(search|find)\b/.test(text) || control.type === 'search') return 'search';
  if (/(log in|login|sign in|sign up|create account|account|profile)/.test(text)) {
    return 'account';
  }
  if (/(settings|preferences|appearance|theme)/.test(text)) return 'settings';
  if (/(menu|more|tools|filter|sort|language|hide|show)/.test(text) || control.ariaExpanded) {
    return 'menu';
  }
  if (/(privacy|terms|license|legal|copyright|cookies)/.test(text)) return 'footer';
  if (control.tag === 'input' || control.tag === 'select' || control.tag === 'textarea') {
    return 'form';
  }
  if (control.tag === 'a') return 'nav';
  if (control.tag === 'button' || control.role === 'button') return 'menu';
  return 'unknown';
}

function discoveryValueForSurface(
  kind: DiscoverySurfaceKind,
  label: string,
  href: string | undefined,
  pageUrl: string,
): 'core' | 'important_secondary' | 'peripheral' {
  const text = `${label} ${href ?? ''}`.toLowerCase();
  if (kind === 'external' || (href && !sameOrigin(href, pageUrl))) return 'peripheral';
  if (kind === 'footer' || /(privacy|terms|license|legal|app store|google play)/.test(text)) {
    return 'peripheral';
  }
  if (kind === 'search' || kind === 'form' || kind === 'content' || kind === 'table') return 'core';
  if (kind === 'account' || kind === 'settings' || kind === 'menu' || kind === 'nav') {
    return 'important_secondary';
  }
  return 'important_secondary';
}

async function discoverySampleLinks(
  page: Page,
  targetUrl: string,
  limit: number,
): Promise<Array<{ label: string; href: string }>> {
  return page
    .evaluate(
      ({ baseUrl, max }) => {
        const base = new URL(baseUrl);
        const seen = new Set<string>();
        const rows = Array.from(document.querySelectorAll('a[href]'))
          .map((el) => {
            const anchor = el as HTMLAnchorElement;
            const html = el as HTMLElement;
            const rect = html.getBoundingClientRect();
            const style = window.getComputedStyle(html);
            if (
              rect.width <= 0 ||
              rect.height <= 0 ||
              style.display === 'none' ||
              style.visibility === 'hidden'
            ) {
              return null;
            }
            const href = anchor.href;
            let parsed: URL;
            try {
              parsed = new URL(href);
            } catch {
              return null;
            }
            if (parsed.origin !== base.origin) return null;
            if (parsed.href === location.href || parsed.hash) return null;
            const label = (
              html.innerText ||
              html.getAttribute('aria-label') ||
              html.getAttribute('title') ||
              href
            )
              .replace(/\s+/g, ' ')
              .trim();
            const haystack = `${label} ${parsed.pathname}`.toLowerCase();
            if (/(privacy|terms|license|legal|copyright|cookie|facebook|twitter|x\.com)/.test(haystack)) {
              return null;
            }
            let score = 0;
            if (/(article|docs?|learn|guide|dashboard|workspace|project|settings|billing|account|login|sign|pricing|search|edit|history)/.test(haystack)) {
              score += 5;
            }
            if (/(help|about|features|product|content|source)/.test(haystack)) score += 2;
            if (score <= 0) return null;
            return { label: label.slice(0, 120), href, score };
          })
          .filter(Boolean) as Array<{ label: string; href: string; score: number }>;
        return rows
          .filter((row) => {
            if (seen.has(row.href)) return false;
            seen.add(row.href);
            return true;
          })
          .sort((a, b) => b.score - a.score || a.label.localeCompare(b.label))
          .slice(0, max)
          .map(({ label, href }) => ({ label, href }));
      },
      { baseUrl: targetUrl, max: limit },
    )
    .catch(() => []);
}

function sameOrigin(href: string, base: string): boolean {
  try {
    return new URL(href, base).origin === new URL(base).origin;
  } catch {
    return false;
  }
}

function dedupeDiscoveryLinks(
  links: Array<{
    label: string;
    href: string;
    same_origin: boolean;
    source: DiscoverySurfaceSource;
  }>,
): Array<{
  label: string;
  href: string;
  same_origin: boolean;
  source: DiscoverySurfaceSource;
}> {
  const seen = new Set<string>();
  const out: typeof links = [];
  for (const link of links) {
    const key = `${link.href}|${link.label.toLowerCase()}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(link);
  }
  return out;
}

async function capturePrimarySearchJourney(
  page: Page,
  capture: (label: string) => Promise<void>,
): Promise<void> {
  const searchSelector = await page
    .evaluate(() => {
      const candidates = Array.from(
        document.querySelectorAll('input[type=search], input[name*=search i], input[placeholder*=search i], [role=searchbox]'),
      );
      const visible = candidates.find((el) => {
        const html = el as HTMLElement;
        const rect = html.getBoundingClientRect();
        const style = window.getComputedStyle(html);
        return (
          rect.width > 0 &&
          rect.height > 0 &&
          style.display !== 'none' &&
          style.visibility !== 'hidden'
        );
      }) as HTMLElement | undefined;
      if (!visible) return null;
      if (!visible.getAttribute('data-iris-primary-search')) {
        visible.setAttribute('data-iris-primary-search', 'true');
      }
      return '[data-iris-primary-search="true"]';
    })
    .catch(() => null);
  if (!searchSelector) return;

  const beforeUrl = page.url();
  const beforeTitle = await page.title().catch(() => '');
  await page.fill(searchSelector, 'OpenAI', { timeout: 1000 }).catch(() => {});
  await page.keyboard.press('Enter').catch(() => {});
  await page.waitForLoadState('domcontentloaded', { timeout: 5000 }).catch(() => {});
  await page.waitForLoadState('networkidle', { timeout: 5000 }).catch(() => {});
  await page.waitForTimeout(250);
  if (page.url() === beforeUrl) {
    await page
      .click('button[type=submit], input[type=submit], button:has-text("Search")', {
        timeout: 1000,
      })
      .catch(() => {});
    await page.waitForLoadState('domcontentloaded', { timeout: 5000 }).catch(() => {});
    await page.waitForLoadState('networkidle', { timeout: 5000 }).catch(() => {});
    await page.waitForTimeout(250);
  }
  const afterUrl = page.url();
  const afterTitle = await page.title().catch(() => '');
  if (afterUrl !== beforeUrl || afterTitle !== beforeTitle) {
    await capture('after primary search journey');
    await page.goto(beforeUrl, { waitUntil: 'domcontentloaded' }).catch(() => {});
    await page.waitForLoadState('networkidle', { timeout: 5000 }).catch(() => {});
  }
}
