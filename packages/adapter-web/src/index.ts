import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import type {
  AdapterArtifacts,
  AdapterConfig,
  EvidenceFile,
  EvidenceRef,
  Observation,
  ProbeResult,
  ProbeSpec,
  TargetAdapter,
  TargetKind,
  ToolResult,
  ToolSpec,
} from '@iris/adapter-types';
import { domOutline } from './dom/snapshot.js';
import { WebLifecycle } from './lifecycle.js';
import { runAxe } from './probes/axe.js';
import { ConsoleProbe } from './probes/console.js';
import { NetworkProbe } from './probes/network.js';
import { WEB_PROBE_SPECS } from './probes/probe-spec.js';
import {
  type StepScreenshotIndex,
  findRunVideo,
  sliceEvidenceScreenshots,
} from './recording/index.js';
import { click, hover, press, type as typeText } from './tools/action.js';
import { back, forward, navigate, reload, scroll, waitFor } from './tools/navigation.js';
import { WEB_TOOL_SPECS } from './tools/tool-spec.js';
import { screenshot, visionClick, visionDescribe } from './tools/vision.js';

export interface WebTargetAdapterOptions {
  headless?: boolean;
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
    });
    await this.lifecycle.start();

    const page = this.lifecycle.getPage();
    this.consoleProbe = new ConsoleProbe(page);
    this.networkProbe = new NetworkProbe(page);
    this.consoleProbe.attach();
    this.networkProbe.attach();

    if (config.target) {
      await page.goto(config.target);
    }
  }

  async stop(): Promise<AdapterArtifacts> {
    if (this.lifecycle) {
      this.consoleProbe?.detach();
      this.networkProbe?.detach();
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
      case 'vision_describe':
        return visionDescribe(page, args);
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

    const outline = await domOutline(page);
    const url = page.url();
    const title = await page.title();
    return {
      observation_ref: ref,
      summary: `${title}\n${outline.slice(0, 4000)}`,
      payload: {
        url,
        title,
        screenshot_ref: screenshotPath,
        outline,
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
    if (name.startsWith('console_') && this.consoleProbe) {
      return this.consoleProbe.runProbe(name, args);
    }
    if (name.startsWith('network_') && this.networkProbe) {
      return this.networkProbe.runProbe(name, args);
    }
    return { ok: false, probe: name, error: `unknown probe: ${name}` };
  }

  async sliceEvidence(refs: EvidenceRef[]): Promise<EvidenceFile[]> {
    return sliceEvidenceScreenshots(refs, this.screenshotIndex);
  }
}
