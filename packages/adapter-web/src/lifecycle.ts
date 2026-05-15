import { type Browser, type BrowserContext, type Page, chromium } from 'playwright';
import { CURSOR_OVERLAY_INIT_SCRIPT } from './recording/cursor-overlay.js';

export interface WebLifecycleOptions {
  headless?: boolean;
  viewport?: { width: number; height: number };
  user_agent?: string;
  storage_state_path?: string;
  record_video_dir?: string;
  trace_out_path?: string;
}

export class WebLifecycle {
  private browser: Browser | null = null;
  private context: BrowserContext | null = null;
  private page: Page | null = null;
  private tracingStarted = false;

  constructor(private readonly opts: WebLifecycleOptions = {}) {}

  async start(): Promise<void> {
    if (this.browser) return;
    try {
      this.browser = await chromium.launch({ headless: this.opts.headless ?? true });
      const contextOpts: Parameters<Browser['newContext']>[0] = {};
      if (this.opts.viewport) contextOpts.viewport = this.opts.viewport;
      if (this.opts.user_agent) contextOpts.userAgent = this.opts.user_agent;
      if (this.opts.storage_state_path) contextOpts.storageState = this.opts.storage_state_path;
      if (this.opts.record_video_dir) contextOpts.recordVideo = { dir: this.opts.record_video_dir };
      this.context = await this.browser.newContext(contextOpts);
      if (this.opts.record_video_dir) {
        await this.context.addInitScript(CURSOR_OVERLAY_INIT_SCRIPT);
      }
      if (this.opts.trace_out_path) {
        await this.context.tracing.start({ snapshots: true, screenshots: true, sources: true });
        this.tracingStarted = true;
      }
      this.context.on('page', (page) => this.activatePage(page));
      this.activatePage(await this.context.newPage());
    } catch (err) {
      await this.stop().catch(() => undefined);
      throw err;
    }
  }

  getPage(): Page {
    if (!this.page) throw new Error('WebLifecycle: not running (call start first)');
    return this.page;
  }

  getContext(): BrowserContext {
    if (!this.context) throw new Error('WebLifecycle: not running');
    return this.context;
  }

  private activatePage(page: Page): void {
    this.page = page;
    page.once('close', () => {
      if (this.page !== page) return;
      const fallback = this.context?.pages().find((candidate) => !candidate.isClosed()) ?? null;
      this.page = fallback;
    });
  }

  async stop(): Promise<void> {
    const context = this.context;
    const browser = this.browser;
    const shouldStopTracing = this.tracingStarted && !!this.opts.trace_out_path;
    this.browser = null;
    this.context = null;
    this.page = null;
    this.tracingStarted = false;

    const errors: unknown[] = [];
    if (context && shouldStopTracing) {
      try {
        await context.tracing.stop({ path: this.opts.trace_out_path as string });
      } catch (err) {
        errors.push(err);
      }
    }
    if (context) {
      try {
        await context.close();
      } catch (err) {
        errors.push(err);
      }
    }
    if (browser) {
      try {
        await browser.close();
      } catch (err) {
        errors.push(err);
      }
    }
    if (errors.length > 0) {
      const detail = errors
        .map((err) => (err instanceof Error ? err.message : String(err)))
        .join('; ');
      throw new Error(`WebLifecycle stop failed: ${detail}`);
    }
  }
}
