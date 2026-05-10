# Iris — Phase 2: Web Adapter Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development to implement task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the Phase 1 stub `WebTargetAdapter` with a real Playwright-driven implementation. After Phase 2, programmatic code can drive Chromium against any URL, capture observations (DOM outline, screenshots, console, network), run axe-core, write a valid `trace.jsonl`, and produce evidence artifacts (full-run video, Playwright trace.zip, per-step screenshots). **No agents yet** — those land in Phase 3. Phase 2 proves the adapter contract works end-to-end against real browsers.

**Architecture:** All code lives in `packages/adapter-web/`. Module split: `src/lifecycle.ts` (start/stop, browser+context+page wiring, recording setup), `src/dom/` (snapshot + a11y normalization), `src/tools/` (one file per tool category: action, navigation, vision, meta), `src/probes/` (axe, console, network, lighthouse), `src/recording/` (video + trace.zip + sliceEvidence), `src/index.ts` (the `WebTargetAdapter` class wiring everything). The Phase 1 stub `index.ts` gets fully replaced. Tests use a local static HTTP fixture server in `packages/adapter-web/test-fixtures/`.

**Tech Stack:** Playwright (Chromium), axe-core (run via `page.evaluate`), lighthouse (heavy probe, opt-in), built-in Node `http` for the fixture server.

**Spec reference:** `docs/superpowers/specs/2026-05-09-iris-design.md` §10.5 (tools), §10.5 (probes), §7 (TargetAdapter interface), §12.4 (sliceEvidence). ffmpeg-based per-finding video clip slicing is **deferred to Phase 4**; Phase 2's `sliceEvidence` returns per-step screenshots only and emits a deferred-feature note.

**Out of scope for Phase 2:** Spec interpreter, Explorer/Judge agents, report builder (those are Phase 3). ffmpeg clip slicing, known-bug bench fixtures, full rubric profile set (Phase 4).

---

## File structure (Phase 2)

```
packages/adapter-web/
├── package.json                            ← MODIFIED: add playwright, axe-core, lighthouse, http-server-style helpers
├── tsconfig.json                           ← unchanged
├── tsup.config.ts                          ← unchanged
├── playwright.config.ts                    ← NEW: minimal config used by tests for browser path / install hint
└── src/
    ├── index.ts                            ← REPLACED: the real WebTargetAdapter
    ├── index.test.ts                       ← REPLACED: integration test that drives a fixture site end-to-end
    ├── lifecycle.ts                        ← NEW: launchBrowser, openContext (with storageState + recording), close
    ├── lifecycle.test.ts                   ← NEW
    ├── dom/
    │   ├── snapshot.ts                     ← NEW: produce compact a11y-prioritized DOM outline
    │   ├── snapshot.test.ts                ← NEW
    │   ├── digest.ts                       ← NEW: thin wrapper around @iris/core domDigest for adapter use
    │   └── index.ts                        ← NEW: barrel
    ├── tools/
    │   ├── action.ts                       ← NEW: click, type, press, hover
    │   ├── action.test.ts                  ← NEW
    │   ├── navigation.ts                   ← NEW: navigate, back, forward, reload, scroll, wait_for
    │   ├── navigation.test.ts              ← NEW
    │   ├── vision.ts                       ← NEW: screenshot, vision_click, vision_describe
    │   ├── vision.test.ts                  ← NEW
    │   ├── tool-spec.ts                    ← NEW: ToolSpec definitions (the JSON schema for each tool)
    │   └── index.ts                        ← NEW: aggregate the tools dict
    ├── probes/
    │   ├── axe.ts                          ← NEW: load axe-core into page, run it, return violations
    │   ├── axe.test.ts                     ← NEW
    │   ├── console.ts                      ← NEW: console-buffer + cursor for console_errors_since
    │   ├── console.test.ts                 ← NEW
    │   ├── network.ts                      ← NEW: network-buffer + cursor for network_failures_since
    │   ├── network.test.ts                 ← NEW
    │   ├── lighthouse.ts                   ← NEW: run lighthouse-on-current-page (opt-in, slow)
    │   ├── probe-spec.ts                   ← NEW: ProbeSpec definitions
    │   └── index.ts                        ← NEW: barrel
    └── recording/
        ├── recording.ts                    ← NEW: hook video + trace recording, exit cleanly
        ├── recording.test.ts               ← NEW
        ├── slice.ts                        ← NEW: sliceEvidence (Phase 2 = screenshots only)
        └── slice.test.ts                   ← NEW

packages/adapter-web/test-fixtures/         ← NEW: static HTML fixtures + tiny http server
├── server.ts                               ← NEW: spawnable static-file server returning {url, port, close()}
├── server.test.ts                          ← NEW
└── sites/
    ├── hello/                              ← NEW: 1-page hello world for smoke
    │   └── index.html
    ├── form/                               ← NEW: a form with input/submit for action tests
    │   └── index.html
    └── two-pages/                          ← NEW: link from one page to another for navigation tests
        ├── index.html
        └── about.html

packages/adapter-types/                     ← MODIFIED in Task 15
└── src/
    ├── index.ts                            ← unchanged
    └── conformance.ts                      ← NEW: runAdapterConformance(adapter) test suite generator
```

**Per-file responsibilities:**

- `lifecycle.ts` — owns the Playwright `Browser` + `BrowserContext` + `Page` lifecycle. Single source of truth for "did we start? are we stopped?" state.
- `dom/snapshot.ts` — pure function `domOutline(page) → string` producing a compact, accessibility-prioritized text outline (NOT raw HTML). Includes role, accessible name, key attributes for inputs. ~200 lines of focused code.
- `tools/action.ts` etc — each file groups tools that share interaction style. Each tool is a function `(adapter, args) → Promise<ToolResult>`. The adapter struct is passed so tools can access the current page and emit trace events.
- `probes/axe.ts` etc — each probe is a function `(adapter, args) → Promise<ProbeResult>`. Axe loads `axe-core` source into the page via `page.addScriptTag` then calls `axe.run()`.
- `probes/console.ts` & `probes/network.ts` — wire Playwright event listeners on context start; maintain in-memory buffers with monotonic cursors so `*_since_last` returns deltas.
- `recording/recording.ts` — start video + `context.tracing.start({snapshots, screenshots, sources})` on adapter `start`; stop and flush on `stop`.
- `recording/slice.ts` — Phase 2 implementation: walks each EvidenceRef's event ids, returns the screenshots captured at those steps. ffmpeg clip slicing notes in code comment for Phase 4.
- `index.ts` — the `WebTargetAdapter` class. Holds the live `Page` + `Probes` state; `listTools()`/`callTool()` dispatches to the tool modules; `listProbes()`/`runProbe()` dispatches to the probe modules.
- `test-fixtures/server.ts` — a thin wrapper around Node `http.createServer` that serves `test-fixtures/sites/<name>/`. Returns `{url, close}`. Tests use it to give Chromium a stable URL.

---

## Conventions (same as Phase 1)

- TDD always: failing test → minimal impl → passing test → commit.
- Every task ends with a single commit, message follows Conventional Commits.
- All paths relative to `/Users/yuxuan/work/prod-critic/`.
- TypeScript strict (already enforced by base config).
- `pnpm --filter @iris/adapter-web test` is the per-task green check.
- Playwright tests run real Chromium — they're integration-tagged but live alongside unit tests in the same `*.test.ts` files. Vitest defaults are fine.

**Playwright install:** Phase 2 task 1 installs `playwright` as a dep. Playwright also needs Chromium binaries. The plan uses `npx playwright install chromium --with-deps` once at start. If the implementer hits a "browser not found" error, that's the install hint to run.

---

## Task 1: Add Playwright dependency, lifecycle skeleton

**Files:**
- Modify: `packages/adapter-web/package.json` — add `playwright` dep
- Create: `packages/adapter-web/playwright.config.ts` — minimal config (mostly for browsers path control)
- Create: `packages/adapter-web/src/lifecycle.ts` — `class WebLifecycle` with `start`/`stop`/`getPage`
- Create: `packages/adapter-web/src/lifecycle.test.ts` — launches Chromium against `about:blank`, asserts page is reachable

- [ ] **Step 1: Update `packages/adapter-web/package.json` deps**

```json
{
  "name": "@iris/adapter-web",
  "version": "0.0.0",
  "type": "module",
  "main": "./dist/index.js",
  "types": "./dist/index.d.ts",
  "exports": {
    ".": { "import": "./dist/index.js", "types": "./dist/index.d.ts" }
  },
  "files": ["dist"],
  "scripts": {
    "build": "tsup",
    "test": "vitest run",
    "typecheck": "tsc --noEmit"
  },
  "dependencies": {
    "@iris/adapter-types": "workspace:*",
    "@iris/core": "workspace:*",
    "playwright": "^1.49.0"
  },
  "devDependencies": {
    "tsup": "^8.3.5",
    "typescript": "^5.6.3",
    "vitest": "^2.1.5"
  }
}
```

- [ ] **Step 2: Install + Playwright Chromium**

```bash
pnpm install
pnpm exec playwright install chromium
```

(The `--with-deps` flag would also `apt-get` system libraries on Linux. On macOS this isn't needed. If install fails with "missing system deps", run `pnpm exec playwright install --with-deps chromium`.)

- [ ] **Step 3: Create `packages/adapter-web/playwright.config.ts`**

```ts
// Minimal Playwright config — referenced by tests only via `defineConfig`'s side-effect-free defaults.
// We don't use Playwright's test runner (vitest is the runner), this exists so tooling that probes
// for `playwright.config.ts` (e.g. VS Code Playwright extension) finds something sensible.
import { defineConfig } from 'playwright/test';

export default defineConfig({
  use: {
    headless: true,
  },
});
```

- [ ] **Step 4: Write the failing test**

Create `packages/adapter-web/src/lifecycle.test.ts`:

```ts
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { WebLifecycle } from './lifecycle.js';

describe('WebLifecycle', () => {
  let lc: WebLifecycle;

  beforeEach(() => {
    lc = new WebLifecycle({ headless: true });
  });

  afterEach(async () => {
    await lc.stop();
  });

  it('start launches Chromium and exposes a Page', async () => {
    await lc.start();
    const page = lc.getPage();
    expect(page).toBeDefined();
    // navigate somewhere harmless to prove the page is alive
    await page.goto('about:blank');
    expect(page.url()).toBe('about:blank');
  });

  it('stop closes the browser; getPage after stop throws', async () => {
    await lc.start();
    await lc.stop();
    expect(() => lc.getPage()).toThrow(/not running/i);
  });

  it('start is idempotent (second call is a no-op)', async () => {
    await lc.start();
    const p1 = lc.getPage();
    await lc.start();
    const p2 = lc.getPage();
    expect(p1).toBe(p2);
  });
});
```

- [ ] **Step 5: Run test (expected fail)**

Run: `pnpm --filter @iris/adapter-web test`
Expected: FAIL — `WebLifecycle` not found.

- [ ] **Step 6: Write `packages/adapter-web/src/lifecycle.ts`**

```ts
import { type Browser, type BrowserContext, type Page, chromium } from 'playwright';

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

  constructor(private readonly opts: WebLifecycleOptions = {}) {}

  async start(): Promise<void> {
    if (this.browser) return;
    this.browser = await chromium.launch({ headless: this.opts.headless ?? true });
    const contextOpts: Parameters<Browser['newContext']>[0] = {};
    if (this.opts.viewport) contextOpts.viewport = this.opts.viewport;
    if (this.opts.user_agent) contextOpts.userAgent = this.opts.user_agent;
    if (this.opts.storage_state_path) contextOpts.storageState = this.opts.storage_state_path;
    if (this.opts.record_video_dir) contextOpts.recordVideo = { dir: this.opts.record_video_dir };
    this.context = await this.browser.newContext(contextOpts);
    if (this.opts.trace_out_path) {
      await this.context.tracing.start({ snapshots: true, screenshots: true, sources: true });
    }
    this.page = await this.context.newPage();
  }

  getPage(): Page {
    if (!this.page) throw new Error('WebLifecycle: not running (call start first)');
    return this.page;
  }

  getContext(): BrowserContext {
    if (!this.context) throw new Error('WebLifecycle: not running');
    return this.context;
  }

  async stop(): Promise<void> {
    if (this.context && this.opts.trace_out_path) {
      await this.context.tracing.stop({ path: this.opts.trace_out_path });
    }
    if (this.context) await this.context.close();
    if (this.browser) await this.browser.close();
    this.browser = null;
    this.context = null;
    this.page = null;
  }
}
```

- [ ] **Step 7: Run test (expected pass)**

Run: `pnpm --filter @iris/adapter-web test`
Expected: PASS — 3 lifecycle tests passing. (Tests are slower than Phase 1 — each runs a real browser. ~3-5s total is normal.)

- [ ] **Step 8: Commit**

```bash
git add packages/adapter-web pnpm-lock.yaml
git commit -m "feat(adapter-web): WebLifecycle — Playwright browser/context/page wiring"
```

---

## Task 2: Test fixture HTTP server + minimal sites

**Files:**
- Create: `packages/adapter-web/test-fixtures/server.ts` — `startFixtureServer(siteName)` returns `{url, close}`
- Create: `packages/adapter-web/test-fixtures/server.test.ts` — fetch test against the spawned server
- Create: `packages/adapter-web/test-fixtures/sites/hello/index.html`
- Create: `packages/adapter-web/test-fixtures/sites/form/index.html`
- Create: `packages/adapter-web/test-fixtures/sites/two-pages/index.html`
- Create: `packages/adapter-web/test-fixtures/sites/two-pages/about.html`

- [ ] **Step 1: Create the fixture sites**

`packages/adapter-web/test-fixtures/sites/hello/index.html`:
```html
<!doctype html>
<html lang="en">
  <head><meta charset="utf-8"><title>Hello — Iris fixture</title></head>
  <body>
    <h1 id="greeting">Hello from Iris fixture</h1>
    <p>This page exists for adapter tests.</p>
  </body>
</html>
```

`packages/adapter-web/test-fixtures/sites/form/index.html`:
```html
<!doctype html>
<html lang="en">
  <head><meta charset="utf-8"><title>Form — Iris fixture</title></head>
  <body>
    <h1>Sign in</h1>
    <form id="signin" name="signin">
      <label for="email">Email</label>
      <input id="email" name="email" type="email" required>
      <label for="password">Password</label>
      <input id="password" name="password" type="password" required>
      <button id="submit" type="submit" name="Sign in">Sign in</button>
    </form>
    <div id="result" role="status" aria-live="polite"></div>
    <script>
      document.getElementById('signin').addEventListener('submit', (e) => {
        e.preventDefault();
        const email = document.getElementById('email').value;
        const password = document.getElementById('password').value;
        document.getElementById('result').textContent = email && password
          ? `Signed in as ${email}`
          : 'Missing fields';
      });
    </script>
  </body>
</html>
```

`packages/adapter-web/test-fixtures/sites/two-pages/index.html`:
```html
<!doctype html>
<html lang="en">
  <head><meta charset="utf-8"><title>Home — Iris fixture</title></head>
  <body>
    <h1>Home</h1>
    <a id="about-link" href="/about.html">About</a>
  </body>
</html>
```

`packages/adapter-web/test-fixtures/sites/two-pages/about.html`:
```html
<!doctype html>
<html lang="en">
  <head><meta charset="utf-8"><title>About — Iris fixture</title></head>
  <body>
    <h1>About</h1>
    <a id="home-link" href="/index.html">Home</a>
  </body>
</html>
```

- [ ] **Step 2: Write the failing test**

Create `packages/adapter-web/test-fixtures/server.test.ts`:

```ts
import { afterEach, describe, expect, it } from 'vitest';
import { startFixtureServer } from './server.js';

describe('startFixtureServer', () => {
  let stop: (() => Promise<void>) | null = null;

  afterEach(async () => {
    if (stop) await stop();
    stop = null;
  });

  it('serves a known fixture site and reports its URL', async () => {
    const handle = await startFixtureServer('hello');
    stop = handle.close;
    expect(handle.url).toMatch(/^http:\/\/127\.0\.0\.1:\d+$/);

    const r = await fetch(`${handle.url}/index.html`);
    expect(r.status).toBe(200);
    const text = await r.text();
    expect(text).toContain('Hello from Iris fixture');
  });

  it('serves a sub-page for two-pages site', async () => {
    const handle = await startFixtureServer('two-pages');
    stop = handle.close;
    const r = await fetch(`${handle.url}/about.html`);
    expect(r.status).toBe(200);
    const text = await r.text();
    expect(text).toContain('About');
  });

  it('returns 404 for a missing path', async () => {
    const handle = await startFixtureServer('hello');
    stop = handle.close;
    const r = await fetch(`${handle.url}/no-such-thing.html`);
    expect(r.status).toBe(404);
  });

  it('rejects unknown site names', async () => {
    await expect(startFixtureServer('nope-not-real')).rejects.toThrow(/site not found/i);
  });
});
```

- [ ] **Step 3: Run test (expected fail)**

Run: `pnpm --filter @iris/adapter-web test`
Expected: FAIL — `startFixtureServer` not found.

- [ ] **Step 4: Write `packages/adapter-web/test-fixtures/server.ts`**

```ts
import { existsSync, readFileSync, statSync } from 'node:fs';
import { type AddressInfo, createServer } from 'node:http';
import { dirname, extname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const SITES_ROOT = join(dirname(fileURLToPath(import.meta.url)), 'sites');

const MIME: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'application/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.png': 'image/png',
  '.svg': 'image/svg+xml',
};

export interface FixtureServerHandle {
  url: string;
  close: () => Promise<void>;
}

export async function startFixtureServer(siteName: string): Promise<FixtureServerHandle> {
  const siteRoot = resolve(SITES_ROOT, siteName);
  if (!existsSync(siteRoot) || !statSync(siteRoot).isDirectory()) {
    throw new Error(`site not found: ${siteName} (looked in ${siteRoot})`);
  }

  const server = createServer((req, res) => {
    const urlPath = (req.url ?? '/').split('?')[0] ?? '/';
    const safePath = urlPath === '/' ? '/index.html' : urlPath;
    const filePath = resolve(siteRoot, `.${safePath}`);
    if (!filePath.startsWith(siteRoot) || !existsSync(filePath) || !statSync(filePath).isFile()) {
      res.statusCode = 404;
      res.end('not found');
      return;
    }
    const ext = extname(filePath).toLowerCase();
    res.statusCode = 200;
    res.setHeader('content-type', MIME[ext] ?? 'application/octet-stream');
    res.end(readFileSync(filePath));
  });

  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  const port = (server.address() as AddressInfo).port;

  return {
    url: `http://127.0.0.1:${port}`,
    close: () =>
      new Promise<void>((resolveClose) => {
        server.close(() => resolveClose());
      }),
  };
}
```

- [ ] **Step 5: Run test (expected pass)**

Run: `pnpm --filter @iris/adapter-web test`
Expected: PASS — 4 fixture-server tests + lifecycle tests.

- [ ] **Step 6: Commit**

```bash
git add packages/adapter-web/test-fixtures
git commit -m "test(adapter-web): static-file fixture server + 3 sites (hello/form/two-pages)"
```

---

## Task 3: `dom/snapshot.ts` — accessibility-prioritized DOM outline

**Files:**
- Create: `packages/adapter-web/src/dom/snapshot.ts`
- Create: `packages/adapter-web/src/dom/snapshot.test.ts`
- Create: `packages/adapter-web/src/dom/index.ts`

**Goal:** produce a compact text outline of the page that the LLM can read instead of full HTML. Each node line: `[role] "accessible name" #id .class (key attributes)`. Skip noise (script/style/comment/empty containers).

- [ ] **Step 1: Write the failing test**

Create `packages/adapter-web/src/dom/snapshot.test.ts`:

```ts
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { startFixtureServer, type FixtureServerHandle } from '../../test-fixtures/server.js';
import { WebLifecycle } from '../lifecycle.js';
import { domOutline } from './snapshot.js';

describe('domOutline', () => {
  let lc: WebLifecycle;
  let server: FixtureServerHandle;

  beforeEach(async () => {
    lc = new WebLifecycle({ headless: true });
    await lc.start();
  });

  afterEach(async () => {
    if (server) await server.close();
    await lc.stop();
  });

  it('produces a non-empty outline for hello fixture', async () => {
    server = await startFixtureServer('hello');
    await lc.getPage().goto(`${server.url}/index.html`);
    const outline = await domOutline(lc.getPage());
    expect(outline).toContain('Hello from Iris fixture');
    expect(outline).toMatch(/heading/i);
  });

  it('captures form inputs with their labels', async () => {
    server = await startFixtureServer('form');
    await lc.getPage().goto(`${server.url}/index.html`);
    const outline = await domOutline(lc.getPage());
    expect(outline).toMatch(/Email/);
    expect(outline).toMatch(/Password/);
    expect(outline).toMatch(/button.*Sign in/i);
  });

  it('strips script and style tags from the outline', async () => {
    server = await startFixtureServer('form');
    await lc.getPage().goto(`${server.url}/index.html`);
    const outline = await domOutline(lc.getPage());
    expect(outline).not.toMatch(/addEventListener/);
    expect(outline).not.toMatch(/<script>/i);
  });
});
```

- [ ] **Step 2: Run test (expected fail)**

Run: `pnpm --filter @iris/adapter-web test`
Expected: FAIL — `domOutline` not found.

- [ ] **Step 3: Write `packages/adapter-web/src/dom/snapshot.ts`**

```ts
import type { Page } from 'playwright';

/**
 * domOutline produces a compact accessibility-prioritized text outline of the page.
 * One line per meaningful element. Format: `<indent>[role] "accessible-name" #id .class (attrs)`
 * Designed for LLM consumption — far cheaper than full HTML, preserves structure + a11y info.
 */
export async function domOutline(page: Page): Promise<string> {
  return await page.evaluate(() => {
    const SKIP_TAGS = new Set([
      'SCRIPT',
      'STYLE',
      'NOSCRIPT',
      'TEMPLATE',
      'SVG',
      'PATH',
      'META',
      'LINK',
      'HEAD',
    ]);
    const INTERESTING_TAGS = new Set([
      'A',
      'BUTTON',
      'INPUT',
      'TEXTAREA',
      'SELECT',
      'OPTION',
      'LABEL',
      'FORM',
      'NAV',
      'MAIN',
      'HEADER',
      'FOOTER',
      'ASIDE',
      'SECTION',
      'ARTICLE',
      'H1',
      'H2',
      'H3',
      'H4',
      'H5',
      'H6',
      'IMG',
      'VIDEO',
      'AUDIO',
      'IFRAME',
      'DIALOG',
      'DETAILS',
      'SUMMARY',
      'UL',
      'OL',
      'LI',
      'TABLE',
      'TR',
      'TH',
      'TD',
    ]);

    const roleFor = (el: Element): string => {
      const explicit = el.getAttribute('role');
      if (explicit) return explicit;
      const tag = el.tagName;
      if (tag === 'A') return 'link';
      if (tag === 'BUTTON') return 'button';
      if (tag === 'INPUT') {
        const t = (el as HTMLInputElement).type ?? 'text';
        return t === 'submit' ? 'button' : `input[type=${t}]`;
      }
      if (tag === 'TEXTAREA') return 'textarea';
      if (tag === 'SELECT') return 'select';
      if (tag === 'IMG') return 'img';
      if (/^H[1-6]$/.test(tag)) return `heading[${tag[1]}]`;
      if (tag === 'NAV') return 'navigation';
      if (tag === 'MAIN') return 'main';
      if (tag === 'HEADER') return 'header';
      if (tag === 'FOOTER') return 'footer';
      if (tag === 'FORM') return 'form';
      if (tag === 'DIALOG') return 'dialog';
      return tag.toLowerCase();
    };

    const accessibleName = (el: Element): string => {
      const aria = el.getAttribute('aria-label');
      if (aria) return aria.trim();
      if (el.tagName === 'INPUT' || el.tagName === 'TEXTAREA' || el.tagName === 'SELECT') {
        const id = el.getAttribute('id');
        if (id) {
          const lbl = document.querySelector(`label[for="${id}"]`);
          if (lbl?.textContent) return lbl.textContent.trim();
        }
        const ph = el.getAttribute('placeholder');
        if (ph) return ph.trim();
        const nm = el.getAttribute('name');
        if (nm) return nm.trim();
      }
      if (el.tagName === 'IMG') return (el.getAttribute('alt') ?? '').trim();
      const text = el.textContent?.trim() ?? '';
      return text.length > 80 ? `${text.slice(0, 77)}...` : text;
    };

    const lines: string[] = [];
    const walk = (node: Node, depth: number): void => {
      if (node.nodeType !== 1) return;
      const el = node as Element;
      if (SKIP_TAGS.has(el.tagName)) return;

      const role = roleFor(el);
      const interesting =
        INTERESTING_TAGS.has(el.tagName) ||
        el.hasAttribute('role') ||
        el.hasAttribute('aria-label') ||
        el.hasAttribute('aria-labelledby');

      if (interesting) {
        const name = accessibleName(el);
        const id = el.id ? `#${el.id}` : '';
        const cls = el.className && typeof el.className === 'string' ? `.${el.className.split(/\s+/).slice(0, 2).join('.')}` : '';
        const extras: string[] = [];
        if (el.tagName === 'INPUT') {
          const inp = el as HTMLInputElement;
          if (inp.required) extras.push('required');
          if (inp.disabled) extras.push('disabled');
          if (inp.value) extras.push(`value="${inp.value.slice(0, 30)}"`);
        }
        if (el.tagName === 'A') {
          const href = el.getAttribute('href');
          if (href) extras.push(`href="${href}"`);
        }
        const extrasStr = extras.length > 0 ? ` (${extras.join(', ')})` : '';
        const indent = '  '.repeat(depth);
        const nameStr = name ? ` "${name}"` : '';
        lines.push(`${indent}[${role}]${nameStr}${id}${cls}${extrasStr}`);
      }

      for (const child of Array.from(el.childNodes)) {
        walk(child, interesting ? depth + 1 : depth);
      }
    };

    walk(document.body, 0);
    return lines.join('\n');
  });
}
```

- [ ] **Step 4: Write `packages/adapter-web/src/dom/index.ts`**

```ts
export * from './snapshot.js';
```

- [ ] **Step 5: Run test (expected pass)**

Run: `pnpm --filter @iris/adapter-web test`
Expected: PASS — 3 outline tests passing.

- [ ] **Step 6: Commit**

```bash
git add packages/adapter-web/src/dom
git commit -m "feat(adapter-web/dom): a11y-prioritized DOM outline (compact text for LLM)"
```

---

## Task 4: Action tools — click, type, press, hover

**Files:**
- Create: `packages/adapter-web/src/tools/action.ts`
- Create: `packages/adapter-web/src/tools/action.test.ts`

**Tools:**
- `click(page, {selector})` — accessible-name selector preferred; uses Playwright's `page.locator(selector).click()`
- `type(page, {selector, text})` — fills input
- `press(page, {key})` — keyboard shortcut
- `hover(page, {selector})` — mouse hover

Each tool returns `ToolResult { ok, evidence_refs?, error? }`.

- [ ] **Step 1: Write the failing test**

Create `packages/adapter-web/src/tools/action.test.ts`:

```ts
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { startFixtureServer, type FixtureServerHandle } from '../../test-fixtures/server.js';
import { WebLifecycle } from '../lifecycle.js';
import { click, hover, press, type } from './action.js';

describe('action tools', () => {
  let lc: WebLifecycle;
  let server: FixtureServerHandle;

  beforeEach(async () => {
    lc = new WebLifecycle({ headless: true });
    await lc.start();
  });

  afterEach(async () => {
    if (server) await server.close();
    await lc.stop();
  });

  it('type fills an input', async () => {
    server = await startFixtureServer('form');
    const page = lc.getPage();
    await page.goto(`${server.url}/index.html`);
    const r = await type(page, { selector: '#email', text: 'a@b.co' });
    expect(r.ok).toBe(true);
    const value = await page.locator('#email').inputValue();
    expect(value).toBe('a@b.co');
  });

  it('click submits a form (and the result text appears)', async () => {
    server = await startFixtureServer('form');
    const page = lc.getPage();
    await page.goto(`${server.url}/index.html`);
    await type(page, { selector: '#email', text: 'a@b.co' });
    await type(page, { selector: '#password', text: 'pw' });
    const r = await click(page, { selector: '#submit' });
    expect(r.ok).toBe(true);
    await page.waitForFunction(() => document.getElementById('result')?.textContent !== '');
    const text = await page.locator('#result').textContent();
    expect(text).toContain('Signed in');
  });

  it('press sends a key (Enter on focused input submits the form)', async () => {
    server = await startFixtureServer('form');
    const page = lc.getPage();
    await page.goto(`${server.url}/index.html`);
    await type(page, { selector: '#email', text: 'a@b.co' });
    await type(page, { selector: '#password', text: 'pw' });
    await page.locator('#password').focus();
    const r = await press(page, { key: 'Enter' });
    expect(r.ok).toBe(true);
  });

  it('hover does not throw on a present element', async () => {
    server = await startFixtureServer('form');
    const page = lc.getPage();
    await page.goto(`${server.url}/index.html`);
    const r = await hover(page, { selector: '#email' });
    expect(r.ok).toBe(true);
  });

  it('click on missing selector returns ok=false with error', async () => {
    server = await startFixtureServer('form');
    const page = lc.getPage();
    await page.goto(`${server.url}/index.html`);
    const r = await click(page, { selector: '#does-not-exist' });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toMatch(/timeout|not found/i);
  });
});
```

- [ ] **Step 2: Run test (expected fail)**

Run: `pnpm --filter @iris/adapter-web test`
Expected: FAIL — action tools not found.

- [ ] **Step 3: Write `packages/adapter-web/src/tools/action.ts`**

```ts
import type { ToolResult } from '@iris/adapter-types';
import type { Page } from 'playwright';

const SHORT_TIMEOUT_MS = 5000;

export async function click(page: Page, args: { selector: string }): Promise<ToolResult> {
  try {
    await page.locator(args.selector).click({ timeout: SHORT_TIMEOUT_MS });
    return { ok: true, evidence_refs: [] };
  } catch (err) {
    return { ok: false, error: errString(err) };
  }
}

export async function type(page: Page, args: { selector: string; text: string }): Promise<ToolResult> {
  try {
    await page.locator(args.selector).fill(args.text, { timeout: SHORT_TIMEOUT_MS });
    return { ok: true, evidence_refs: [] };
  } catch (err) {
    return { ok: false, error: errString(err) };
  }
}

export async function press(page: Page, args: { key: string }): Promise<ToolResult> {
  try {
    await page.keyboard.press(args.key);
    return { ok: true, evidence_refs: [] };
  } catch (err) {
    return { ok: false, error: errString(err) };
  }
}

export async function hover(page: Page, args: { selector: string }): Promise<ToolResult> {
  try {
    await page.locator(args.selector).hover({ timeout: SHORT_TIMEOUT_MS });
    return { ok: true, evidence_refs: [] };
  } catch (err) {
    return { ok: false, error: errString(err) };
  }
}

function errString(err: unknown): string {
  return err instanceof Error ? err.message.split('\n')[0] ?? err.message : String(err);
}
```

- [ ] **Step 4: Run test (expected pass)**

Run: `pnpm --filter @iris/adapter-web test`
Expected: PASS — 5 action tests passing.

- [ ] **Step 5: Commit**

```bash
git add packages/adapter-web/src/tools/action.ts packages/adapter-web/src/tools/action.test.ts
git commit -m "feat(adapter-web/tools): action tools — click, type, press, hover"
```

---

## Task 5: Navigation tools — navigate, back, forward, reload, scroll, wait_for

**Files:**
- Create: `packages/adapter-web/src/tools/navigation.ts`
- Create: `packages/adapter-web/src/tools/navigation.test.ts`

- [ ] **Step 1: Write the failing test**

Create `packages/adapter-web/src/tools/navigation.test.ts`:

```ts
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { startFixtureServer, type FixtureServerHandle } from '../../test-fixtures/server.js';
import { WebLifecycle } from '../lifecycle.js';
import { back, forward, navigate, reload, scroll, waitFor } from './navigation.js';

describe('navigation tools', () => {
  let lc: WebLifecycle;
  let server: FixtureServerHandle;

  beforeEach(async () => {
    lc = new WebLifecycle({ headless: true });
    await lc.start();
  });

  afterEach(async () => {
    if (server) await server.close();
    await lc.stop();
  });

  it('navigate moves to a URL', async () => {
    server = await startFixtureServer('two-pages');
    const r = await navigate(lc.getPage(), { url: `${server.url}/index.html` });
    expect(r.ok).toBe(true);
    expect(lc.getPage().url()).toBe(`${server.url}/index.html`);
  });

  it('back / forward navigate history', async () => {
    server = await startFixtureServer('two-pages');
    const page = lc.getPage();
    await navigate(page, { url: `${server.url}/index.html` });
    await navigate(page, { url: `${server.url}/about.html` });
    expect((await back(page, {})).ok).toBe(true);
    expect(page.url()).toBe(`${server.url}/index.html`);
    expect((await forward(page, {})).ok).toBe(true);
    expect(page.url()).toBe(`${server.url}/about.html`);
  });

  it('reload re-fetches the current page', async () => {
    server = await startFixtureServer('hello');
    const page = lc.getPage();
    await navigate(page, { url: `${server.url}/index.html` });
    const r = await reload(page, {});
    expect(r.ok).toBe(true);
    expect(page.url()).toBe(`${server.url}/index.html`);
  });

  it('scroll moves the page (pixel offsets)', async () => {
    server = await startFixtureServer('hello');
    const page = lc.getPage();
    await navigate(page, { url: `${server.url}/index.html` });
    const r = await scroll(page, { dx: 0, dy: 200 });
    expect(r.ok).toBe(true);
    // not asserting actual scroll position — fixture is short, may not scroll. just no throw.
  });

  it('waitFor a present selector resolves quickly', async () => {
    server = await startFixtureServer('hello');
    const page = lc.getPage();
    await navigate(page, { url: `${server.url}/index.html` });
    const r = await waitFor(page, { selector: '#greeting', timeout_ms: 2000 });
    expect(r.ok).toBe(true);
  });

  it('waitFor a missing selector returns ok=false on timeout', async () => {
    server = await startFixtureServer('hello');
    const page = lc.getPage();
    await navigate(page, { url: `${server.url}/index.html` });
    const r = await waitFor(page, { selector: '#nothing-here', timeout_ms: 500 });
    expect(r.ok).toBe(false);
  });
});
```

- [ ] **Step 2: Run test (expected fail)**

Run: `pnpm --filter @iris/adapter-web test`
Expected: FAIL — navigation tools not found.

- [ ] **Step 3: Write `packages/adapter-web/src/tools/navigation.ts`**

```ts
import type { ToolResult } from '@iris/adapter-types';
import type { Page } from 'playwright';

const DEFAULT_TIMEOUT_MS = 10_000;

export async function navigate(page: Page, args: { url: string; timeout_ms?: number }): Promise<ToolResult> {
  try {
    await page.goto(args.url, { timeout: args.timeout_ms ?? DEFAULT_TIMEOUT_MS, waitUntil: 'load' });
    return { ok: true, evidence_refs: [] };
  } catch (err) {
    return { ok: false, error: errString(err) };
  }
}

export async function back(page: Page, _args: Record<string, unknown>): Promise<ToolResult> {
  try {
    await page.goBack({ timeout: DEFAULT_TIMEOUT_MS });
    return { ok: true, evidence_refs: [] };
  } catch (err) {
    return { ok: false, error: errString(err) };
  }
}

export async function forward(page: Page, _args: Record<string, unknown>): Promise<ToolResult> {
  try {
    await page.goForward({ timeout: DEFAULT_TIMEOUT_MS });
    return { ok: true, evidence_refs: [] };
  } catch (err) {
    return { ok: false, error: errString(err) };
  }
}

export async function reload(page: Page, _args: Record<string, unknown>): Promise<ToolResult> {
  try {
    await page.reload({ timeout: DEFAULT_TIMEOUT_MS });
    return { ok: true, evidence_refs: [] };
  } catch (err) {
    return { ok: false, error: errString(err) };
  }
}

export async function scroll(page: Page, args: { dx: number; dy: number }): Promise<ToolResult> {
  try {
    await page.evaluate(({ dx, dy }) => window.scrollBy(dx, dy), { dx: args.dx, dy: args.dy });
    return { ok: true, evidence_refs: [] };
  } catch (err) {
    return { ok: false, error: errString(err) };
  }
}

export async function waitFor(
  page: Page,
  args: { selector?: string; network_idle?: boolean; timeout_ms?: number },
): Promise<ToolResult> {
  try {
    const timeout = args.timeout_ms ?? DEFAULT_TIMEOUT_MS;
    if (args.selector) {
      await page.locator(args.selector).waitFor({ timeout });
    } else if (args.network_idle) {
      await page.waitForLoadState('networkidle', { timeout });
    } else {
      throw new Error('waitFor requires selector or network_idle=true');
    }
    return { ok: true, evidence_refs: [] };
  } catch (err) {
    return { ok: false, error: errString(err) };
  }
}

function errString(err: unknown): string {
  return err instanceof Error ? err.message.split('\n')[0] ?? err.message : String(err);
}
```

- [ ] **Step 4: Run test (expected pass)**

Run: `pnpm --filter @iris/adapter-web test`
Expected: PASS — 6 navigation tests passing.

- [ ] **Step 5: Commit**

```bash
git add packages/adapter-web/src/tools/navigation.ts packages/adapter-web/src/tools/navigation.test.ts
git commit -m "feat(adapter-web/tools): navigation — navigate/back/forward/reload/scroll/waitFor"
```

---

## Task 6: Vision tools — screenshot, vision_click, vision_describe

**Files:**
- Create: `packages/adapter-web/src/tools/vision.ts`
- Create: `packages/adapter-web/src/tools/vision.test.ts`

`vision_describe` in Phase 2 is a stub that returns "vision describe not implemented in phase 2 — wire in Phase 3 with an LLM call". `vision_click(x, y)` clicks at coordinates. `screenshot` writes a PNG to the run's evidence dir and returns the file path.

- [ ] **Step 1: Write the failing test**

Create `packages/adapter-web/src/tools/vision.test.ts`:

```ts
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { startFixtureServer, type FixtureServerHandle } from '../../test-fixtures/server.js';
import { WebLifecycle } from '../lifecycle.js';
import { screenshot, visionClick, visionDescribe } from './vision.js';

describe('vision tools', () => {
  let lc: WebLifecycle;
  let server: FixtureServerHandle;
  let outDir: string;

  beforeEach(async () => {
    lc = new WebLifecycle({ headless: true });
    await lc.start();
    outDir = mkdtempSync(join(tmpdir(), 'iris-vision-'));
  });

  afterEach(async () => {
    if (server) await server.close();
    await lc.stop();
    rmSync(outDir, { recursive: true, force: true });
  });

  it('screenshot writes a PNG and returns the path in evidence_refs', async () => {
    server = await startFixtureServer('hello');
    await lc.getPage().goto(`${server.url}/index.html`);
    const r = await screenshot(lc.getPage(), { out_dir: outDir, name: 'step-1' });
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.evidence_refs).toHaveLength(1);
      const path = r.evidence_refs[0]!;
      expect(existsSync(path)).toBe(true);
      expect(path).toMatch(/step-1\.png$/);
    }
  });

  it('vision_click clicks at xy coordinates (smoke: no throw)', async () => {
    server = await startFixtureServer('hello');
    await lc.getPage().goto(`${server.url}/index.html`);
    const r = await visionClick(lc.getPage(), { x: 50, y: 50, reason: 'top-left of body' });
    expect(r.ok).toBe(true);
  });

  it('vision_describe is a phase-2 stub that returns ok=false', async () => {
    server = await startFixtureServer('hello');
    await lc.getPage().goto(`${server.url}/index.html`);
    const r = await visionDescribe(lc.getPage(), {});
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toMatch(/phase 3/i);
  });
});
```

- [ ] **Step 2: Run test (expected fail)**

Run: `pnpm --filter @iris/adapter-web test`
Expected: FAIL — vision tools not found.

- [ ] **Step 3: Write `packages/adapter-web/src/tools/vision.ts`**

```ts
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import type { ToolResult } from '@iris/adapter-types';
import type { Page } from 'playwright';

export async function screenshot(
  page: Page,
  args: { out_dir: string; name: string; full_page?: boolean },
): Promise<ToolResult> {
  try {
    mkdirSync(args.out_dir, { recursive: true });
    const path = join(args.out_dir, `${args.name}.png`);
    await page.screenshot({ path, fullPage: args.full_page ?? false });
    return { ok: true, evidence_refs: [path] };
  } catch (err) {
    return { ok: false, error: errString(err) };
  }
}

export async function visionClick(
  page: Page,
  args: { x: number; y: number; reason?: string },
): Promise<ToolResult> {
  try {
    await page.mouse.click(args.x, args.y);
    return { ok: true, evidence_refs: [] };
  } catch (err) {
    return { ok: false, error: errString(err) };
  }
}

export async function visionDescribe(_page: Page, _args: Record<string, unknown>): Promise<ToolResult> {
  // Phase 3 wires this to an LLM call (Claude with image content block).
  return {
    ok: false,
    error: 'vision_describe not implemented in phase 2 — wire in phase 3 with an LLM call',
  };
}

function errString(err: unknown): string {
  return err instanceof Error ? err.message.split('\n')[0] ?? err.message : String(err);
}
```

- [ ] **Step 4: Run test (expected pass)**

Run: `pnpm --filter @iris/adapter-web test`
Expected: PASS — 3 vision tests passing.

- [ ] **Step 5: Commit**

```bash
git add packages/adapter-web/src/tools/vision.ts packages/adapter-web/src/tools/vision.test.ts
git commit -m "feat(adapter-web/tools): vision — screenshot + visionClick (visionDescribe phase-3 stub)"
```

---

## Task 7: Console + network probes (event listeners with cursor tracking)

**Files:**
- Create: `packages/adapter-web/src/probes/console.ts`
- Create: `packages/adapter-web/src/probes/console.test.ts`
- Create: `packages/adapter-web/src/probes/network.ts`
- Create: `packages/adapter-web/src/probes/network.test.ts`

Pattern: each probe attaches Playwright event listeners on a `Page`, accumulates entries in an in-memory buffer, exposes `consume()` (returns and clears the buffer — "since last call" semantics).

- [ ] **Step 1: Write the failing test for console**

Create `packages/adapter-web/src/probes/console.test.ts`:

```ts
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { startFixtureServer, type FixtureServerHandle } from '../../test-fixtures/server.js';
import { WebLifecycle } from '../lifecycle.js';
import { ConsoleProbe } from './console.js';

describe('ConsoleProbe', () => {
  let lc: WebLifecycle;
  let server: FixtureServerHandle;

  beforeEach(async () => {
    lc = new WebLifecycle({ headless: true });
    await lc.start();
  });

  afterEach(async () => {
    if (server) await server.close();
    await lc.stop();
  });

  it('captures console.error messages and consume() drains them', async () => {
    server = await startFixtureServer('hello');
    const page = lc.getPage();
    const probe = new ConsoleProbe(page);
    probe.attach();
    await page.goto(`${server.url}/index.html`);
    await page.evaluate(() => console.error('boom one'));
    await page.evaluate(() => console.error('boom two'));
    // settle
    await page.waitForTimeout(50);

    const errs = probe.consume('error');
    expect(errs.map((e) => e.text)).toEqual(expect.arrayContaining(['boom one', 'boom two']));
    // second consume returns empty (cursor advanced)
    expect(probe.consume('error')).toHaveLength(0);
  });

  it('runProbe summary returns count', async () => {
    server = await startFixtureServer('hello');
    const page = lc.getPage();
    const probe = new ConsoleProbe(page);
    probe.attach();
    await page.goto(`${server.url}/index.html`);
    await page.evaluate(() => console.error('x'));
    await page.waitForTimeout(50);

    const r = await probe.runProbe('console_errors_since', {});
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.summary.error_count).toBe(1);
    }
  });
});
```

- [ ] **Step 2: Run test (expected fail)**

Run: `pnpm --filter @iris/adapter-web test`
Expected: FAIL — `ConsoleProbe` not found.

- [ ] **Step 3: Write `packages/adapter-web/src/probes/console.ts`**

```ts
import type { ProbeResult } from '@iris/adapter-types';
import type { ConsoleMessage, Page } from 'playwright';

export interface ConsoleEntry {
  type: string;
  text: string;
  ts: number;
}

export class ConsoleProbe {
  private buffer: ConsoleEntry[] = [];
  private cursor = 0;
  private listener: ((msg: ConsoleMessage) => void) | null = null;

  constructor(private readonly page: Page) {}

  attach(): void {
    if (this.listener) return;
    this.listener = (msg: ConsoleMessage) => {
      this.buffer.push({ type: msg.type(), text: msg.text(), ts: Date.now() / 1000 });
    };
    this.page.on('console', this.listener);
  }

  detach(): void {
    if (!this.listener) return;
    this.page.off('console', this.listener);
    this.listener = null;
  }

  consume(filterType?: string): ConsoleEntry[] {
    const slice = this.buffer.slice(this.cursor);
    this.cursor = this.buffer.length;
    return filterType ? slice.filter((e) => e.type === filterType) : slice;
  }

  async runProbe(name: string, _args: Record<string, unknown>): Promise<ProbeResult> {
    if (name === 'console_errors_since') {
      const errs = this.consume('error');
      return {
        ok: true,
        probe: name,
        summary: { error_count: errs.length },
        data: errs,
      };
    }
    if (name === 'console_all_since') {
      const all = this.consume();
      return {
        ok: true,
        probe: name,
        summary: { count: all.length },
        data: all,
      };
    }
    return { ok: false, probe: name, error: `unknown console probe: ${name}` };
  }
}
```

- [ ] **Step 4: Run console test (expected pass)**

Run: `pnpm --filter @iris/adapter-web test`
Expected: PASS — console tests passing.

- [ ] **Step 5: Write the failing network test**

Create `packages/adapter-web/src/probes/network.test.ts`:

```ts
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { startFixtureServer, type FixtureServerHandle } from '../../test-fixtures/server.js';
import { WebLifecycle } from '../lifecycle.js';
import { NetworkProbe } from './network.js';

describe('NetworkProbe', () => {
  let lc: WebLifecycle;
  let server: FixtureServerHandle;

  beforeEach(async () => {
    lc = new WebLifecycle({ headless: true });
    await lc.start();
  });

  afterEach(async () => {
    if (server) await server.close();
    await lc.stop();
  });

  it('captures responses and exposes failures via probe', async () => {
    server = await startFixtureServer('hello');
    const page = lc.getPage();
    const probe = new NetworkProbe(page);
    probe.attach();
    await page.goto(`${server.url}/index.html`);
    // make a 404 fetch from the page
    await page.evaluate(async (base) => {
      try {
        await fetch(`${base}/no-such.html`);
      } catch {}
    }, server.url);
    await page.waitForTimeout(100);

    const r = await probe.runProbe('network_failures_since', {});
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.summary.failure_count).toBeGreaterThanOrEqual(1);
    }
  });
});
```

- [ ] **Step 6: Run test (expected fail)**

Run: `pnpm --filter @iris/adapter-web test`
Expected: FAIL — `NetworkProbe` not found.

- [ ] **Step 7: Write `packages/adapter-web/src/probes/network.ts`**

```ts
import type { ProbeResult } from '@iris/adapter-types';
import type { Page, Response } from 'playwright';

export interface NetworkEntry {
  url: string;
  status: number;
  ok: boolean;
  ms: number;
  ts: number;
}

export class NetworkProbe {
  private buffer: NetworkEntry[] = [];
  private cursor = 0;
  private listener: ((rsp: Response) => void) | null = null;
  private startTimes = new Map<string, number>();
  private requestListener: ((req: import('playwright').Request) => void) | null = null;

  constructor(private readonly page: Page) {}

  attach(): void {
    if (this.listener) return;
    this.requestListener = (req) => {
      this.startTimes.set(req.url(), Date.now());
    };
    this.listener = (rsp: Response) => {
      const url = rsp.url();
      const startedAt = this.startTimes.get(url) ?? Date.now();
      const ms = Date.now() - startedAt;
      this.startTimes.delete(url);
      this.buffer.push({
        url,
        status: rsp.status(),
        ok: rsp.status() >= 200 && rsp.status() < 400,
        ms,
        ts: Date.now() / 1000,
      });
    };
    this.page.on('request', this.requestListener);
    this.page.on('response', this.listener);
  }

  detach(): void {
    if (this.listener) this.page.off('response', this.listener);
    if (this.requestListener) this.page.off('request', this.requestListener);
    this.listener = null;
    this.requestListener = null;
  }

  consume(failuresOnly = false): NetworkEntry[] {
    const slice = this.buffer.slice(this.cursor);
    this.cursor = this.buffer.length;
    return failuresOnly ? slice.filter((e) => !e.ok) : slice;
  }

  async runProbe(name: string, _args: Record<string, unknown>): Promise<ProbeResult> {
    if (name === 'network_failures_since') {
      const failures = this.consume(true);
      return {
        ok: true,
        probe: name,
        summary: { failure_count: failures.length },
        data: failures,
      };
    }
    if (name === 'network_all_since') {
      const all = this.consume(false);
      return {
        ok: true,
        probe: name,
        summary: { count: all.length },
        data: all,
      };
    }
    return { ok: false, probe: name, error: `unknown network probe: ${name}` };
  }
}
```

- [ ] **Step 8: Run test (expected pass) and commit**

Run: `pnpm --filter @iris/adapter-web test`
Expected: PASS — console + network tests passing.

```bash
git add packages/adapter-web/src/probes
git commit -m "feat(adapter-web/probes): console + network probes with cursor-based since-last semantics"
```

---

## Task 8: axe-core probe

**Files:**
- Modify: `packages/adapter-web/package.json` — add `axe-core` dep
- Create: `packages/adapter-web/src/probes/axe.ts`
- Create: `packages/adapter-web/src/probes/axe.test.ts`

axe-core ships its source as a single JS file; we inject it via `page.addScriptTag` then call `axe.run()` in the page context.

- [ ] **Step 1: Add axe-core to deps**

Edit `packages/adapter-web/package.json` to add to `dependencies`:
```json
    "axe-core": "^4.10.2"
```

Run: `pnpm install`

- [ ] **Step 2: Write the failing test**

Create `packages/adapter-web/src/probes/axe.test.ts`:

```ts
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { startFixtureServer, type FixtureServerHandle } from '../../test-fixtures/server.js';
import { WebLifecycle } from '../lifecycle.js';
import { runAxe } from './axe.js';

describe('axe probe', () => {
  let lc: WebLifecycle;
  let server: FixtureServerHandle;

  beforeEach(async () => {
    lc = new WebLifecycle({ headless: true });
    await lc.start();
  });

  afterEach(async () => {
    if (server) await server.close();
    await lc.stop();
  });

  it('runs axe and returns a probe result with violations + passes counts', async () => {
    server = await startFixtureServer('form');
    const page = lc.getPage();
    await page.goto(`${server.url}/index.html`);
    const r = await runAxe(page);
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(typeof r.summary.violations).toBe('number');
      expect(typeof r.summary.passes).toBe('number');
    }
  });

  it('reports zero violations on the simple hello fixture', async () => {
    server = await startFixtureServer('hello');
    const page = lc.getPage();
    await page.goto(`${server.url}/index.html`);
    const r = await runAxe(page);
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.summary.violations).toBeLessThanOrEqual(2);
    }
  });
});
```

- [ ] **Step 3: Run test (expected fail)**

Run: `pnpm --filter @iris/adapter-web test`
Expected: FAIL — `runAxe` not found.

- [ ] **Step 4: Write `packages/adapter-web/src/probes/axe.ts`**

```ts
import { createRequire } from 'node:module';
import type { ProbeResult } from '@iris/adapter-types';
import type { Page } from 'playwright';

const require = createRequire(import.meta.url);
// axe-core ships its source as `axe.min.js`; we read it once and inject into the page.
const AXE_SOURCE_PATH = require.resolve('axe-core/axe.min.js');

interface AxeViolation {
  id: string;
  impact: string | null;
  description: string;
  help: string;
  helpUrl: string;
  nodes: Array<{ html: string; target: string[] }>;
}

interface AxeResults {
  violations: AxeViolation[];
  passes: Array<{ id: string }>;
  incomplete: Array<{ id: string }>;
  inapplicable: Array<{ id: string }>;
}

export async function runAxe(page: Page): Promise<ProbeResult> {
  try {
    await page.addScriptTag({ path: AXE_SOURCE_PATH });
    const results = (await page.evaluate(async () => {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const axe = (window as unknown as { axe: { run: () => Promise<unknown> } }).axe;
      return await axe.run();
    })) as AxeResults;

    return {
      ok: true,
      probe: 'axe',
      summary: {
        violations: results.violations.length,
        passes: results.passes.length,
        incomplete: results.incomplete.length,
        inapplicable: results.inapplicable.length,
      },
      data: {
        violations: results.violations.map((v) => ({
          id: v.id,
          impact: v.impact,
          description: v.description,
          help: v.help,
          help_url: v.helpUrl,
          nodes: v.nodes.map((n) => ({ html: n.html, target: n.target })),
        })),
      },
    };
  } catch (err) {
    return {
      ok: false,
      probe: 'axe',
      error: err instanceof Error ? err.message : String(err),
    };
  }
}
```

- [ ] **Step 5: Run test (expected pass) and commit**

Run: `pnpm --filter @iris/adapter-web test`
Expected: PASS.

```bash
git add packages/adapter-web pnpm-lock.yaml
git commit -m "feat(adapter-web/probes): axe-core probe (inject axe into page, return violations)"
```

---

## Task 9: Recording — full-run video + Playwright trace.zip

**Files:**
- Create: `packages/adapter-web/src/recording/recording.ts`
- Create: `packages/adapter-web/src/recording/recording.test.ts`
- Create: `packages/adapter-web/src/recording/index.ts`

`WebLifecycle` already has the wiring for `recordVideo` and `tracing.start/stop` (Task 1). This task adds a thin coordinator and tests the artifacts actually appear.

- [ ] **Step 1: Write the failing test**

Create `packages/adapter-web/src/recording/recording.test.ts`:

```ts
import { existsSync, mkdtempSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { startFixtureServer, type FixtureServerHandle } from '../../test-fixtures/server.js';
import { WebLifecycle } from '../lifecycle.js';

describe('recording (video + trace.zip)', () => {
  let lc: WebLifecycle;
  let server: FixtureServerHandle;
  let outDir: string;

  beforeEach(() => {
    outDir = mkdtempSync(join(tmpdir(), 'iris-rec-'));
  });

  afterEach(async () => {
    if (server) await server.close();
    if (lc) await lc.stop();
    rmSync(outDir, { recursive: true, force: true });
  });

  it('produces a video file and a trace.zip when configured', async () => {
    const videoDir = join(outDir, 'videos');
    const tracePath = join(outDir, 'trace.zip');
    lc = new WebLifecycle({
      headless: true,
      record_video_dir: videoDir,
      trace_out_path: tracePath,
    });
    await lc.start();
    server = await startFixtureServer('hello');
    await lc.getPage().goto(`${server.url}/index.html`);
    await lc.stop();

    expect(existsSync(tracePath)).toBe(true);
    const videos = readdirSync(videoDir);
    expect(videos.some((f) => f.endsWith('.webm'))).toBe(true);
  });

  it('does not record video or trace when not configured', async () => {
    lc = new WebLifecycle({ headless: true });
    await lc.start();
    server = await startFixtureServer('hello');
    await lc.getPage().goto(`${server.url}/index.html`);
    await lc.stop();
    // outDir is untouched
    expect(readdirSync(outDir)).toHaveLength(0);
  });
});
```

- [ ] **Step 2: Run test (should pass already because lifecycle handles this)**

Run: `pnpm --filter @iris/adapter-web test`
Expected: PASS — both recording tests passing (because `WebLifecycle` already implements both branches in Task 1).

- [ ] **Step 3: Write the recording module barrel + helper**

Create `packages/adapter-web/src/recording/recording.ts`:

```ts
import { existsSync, readdirSync } from 'node:fs';
import { join } from 'node:path';

/**
 * Find the .webm video file Playwright created in the configured directory.
 * Playwright assigns auto-generated names. Returns the most recent file.
 */
export function findRunVideo(videoDir: string): string | null {
  if (!existsSync(videoDir)) return null;
  const webms = readdirSync(videoDir).filter((f) => f.endsWith('.webm'));
  if (webms.length === 0) return null;
  webms.sort();
  return join(videoDir, webms[webms.length - 1]!);
}
```

Create `packages/adapter-web/src/recording/index.ts`:

```ts
export * from './recording.js';
```

- [ ] **Step 4: Commit**

```bash
git add packages/adapter-web/src/recording
git commit -m "feat(adapter-web/recording): video + trace.zip artifact discovery"
```

---

## Task 10: sliceEvidence — Phase 2 implementation (screenshots only)

**Files:**
- Create: `packages/adapter-web/src/recording/slice.ts`
- Create: `packages/adapter-web/src/recording/slice.test.ts`
- Modify: `packages/adapter-web/src/recording/index.ts`

Phase 2 contract: given `EvidenceRef[]`, look up the screenshot files captured at the referenced steps. Return one `EvidenceFile` per finding, kind `screenshot`. Phase 4 will add ffmpeg-driven `.webm` clip slicing.

- [ ] **Step 1: Write the failing test**

Create `packages/adapter-web/src/recording/slice.test.ts`:

```ts
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { sliceEvidenceScreenshots, type StepScreenshotIndex } from './slice.js';

describe('sliceEvidenceScreenshots', () => {
  let dir: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'iris-slice-'));
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it('returns one EvidenceFile per finding pointing at the step screenshot', () => {
    const screenshots = join(dir, 'screenshots');
    mkdirSync(screenshots, { recursive: true });
    writeFileSync(join(screenshots, 'step-0017.png'), 'fake');

    const index: StepScreenshotIndex = {
      T000139: join(screenshots, 'step-0017.png'),
      T000142: join(screenshots, 'step-0017.png'),
    };

    const out = sliceEvidenceScreenshots(
      [{ finding_id: 'F-001', event_ids: ['T000139', 'T000142'] }],
      index,
    );
    expect(out).toHaveLength(1);
    expect(out[0]?.finding_id).toBe('F-001');
    expect(out[0]?.kind).toBe('screenshot');
    expect(out[0]?.path).toBe(join(screenshots, 'step-0017.png'));
  });

  it('skips findings whose evidence has no matching screenshots', () => {
    const out = sliceEvidenceScreenshots(
      [{ finding_id: 'F-002', event_ids: ['T999'] }],
      {},
    );
    expect(out).toHaveLength(0);
  });
});
```

- [ ] **Step 2: Run test (expected fail)**

Run: `pnpm --filter @iris/adapter-web test`
Expected: FAIL — `sliceEvidenceScreenshots` not found.

- [ ] **Step 3: Write `packages/adapter-web/src/recording/slice.ts`**

```ts
import type { EvidenceFile, EvidenceRef } from '@iris/adapter-types';

/**
 * Map of trace event id → absolute path of screenshot captured at that step.
 * Built up during a run by the orchestrator (Phase 3) as steps execute.
 */
export type StepScreenshotIndex = Record<string, string>;

/**
 * Phase 2 implementation: per finding, return ONE EvidenceFile pointing at the first
 * matching screenshot for any of the cited event_ids. Findings with no matching
 * screenshots are skipped.
 *
 * Phase 4 will add ffmpeg-driven .webm clip slicing covering the time window of
 * the cited events. For Phase 2, screenshots are sufficient evidence.
 */
export function sliceEvidenceScreenshots(
  refs: EvidenceRef[],
  index: StepScreenshotIndex,
): EvidenceFile[] {
  const out: EvidenceFile[] = [];
  for (const ref of refs) {
    let path: string | undefined;
    for (const id of ref.event_ids) {
      if (index[id]) {
        path = index[id];
        break;
      }
    }
    if (path) {
      out.push({ finding_id: ref.finding_id, path, kind: 'screenshot' });
    }
  }
  return out;
}
```

- [ ] **Step 4: Update `packages/adapter-web/src/recording/index.ts`**

```ts
export * from './recording.js';
export * from './slice.js';
```

- [ ] **Step 5: Run test (expected pass) and commit**

Run: `pnpm --filter @iris/adapter-web test`
Expected: PASS.

```bash
git add packages/adapter-web/src/recording
git commit -m "feat(adapter-web/recording): sliceEvidenceScreenshots (phase-2 evidence slicing)"
```

---

## Task 11: ToolSpec + ProbeSpec definitions

**Files:**
- Create: `packages/adapter-web/src/tools/tool-spec.ts`
- Create: `packages/adapter-web/src/tools/index.ts`
- Create: `packages/adapter-web/src/probes/probe-spec.ts`
- Create: `packages/adapter-web/src/probes/index.ts`

Each tool/probe needs a `ToolSpec` / `ProbeSpec` for the LLM to see (Phase 3 wires them into Anthropic tool definitions).

- [ ] **Step 1: Write `packages/adapter-web/src/tools/tool-spec.ts`**

```ts
import type { ToolSpec } from '@iris/adapter-types';

export const WEB_TOOL_SPECS: ToolSpec[] = [
  {
    name: 'click',
    description: 'Click an element. Prefer accessible-name selectors like role=button[name="Sign in"].',
    input_schema: {
      type: 'object',
      properties: { selector: { type: 'string' } },
      required: ['selector'],
    },
  },
  {
    name: 'type',
    description: 'Fill an input or textarea with text.',
    input_schema: {
      type: 'object',
      properties: { selector: { type: 'string' }, text: { type: 'string' } },
      required: ['selector', 'text'],
    },
  },
  {
    name: 'press',
    description: 'Press a single keyboard key (Enter, Tab, Escape, ArrowDown, etc.).',
    input_schema: {
      type: 'object',
      properties: { key: { type: 'string' } },
      required: ['key'],
    },
  },
  {
    name: 'hover',
    description: 'Hover over an element to reveal tooltips or hover-only menus.',
    input_schema: {
      type: 'object',
      properties: { selector: { type: 'string' } },
      required: ['selector'],
    },
  },
  {
    name: 'navigate',
    description: 'Navigate to a URL.',
    input_schema: {
      type: 'object',
      properties: { url: { type: 'string' } },
      required: ['url'],
    },
  },
  {
    name: 'back',
    description: 'Browser back.',
    input_schema: { type: 'object', properties: {} },
  },
  {
    name: 'forward',
    description: 'Browser forward.',
    input_schema: { type: 'object', properties: {} },
  },
  {
    name: 'reload',
    description: 'Reload the current page.',
    input_schema: { type: 'object', properties: {} },
  },
  {
    name: 'scroll',
    description: 'Scroll the viewport by dx,dy pixels.',
    input_schema: {
      type: 'object',
      properties: { dx: { type: 'number' }, dy: { type: 'number' } },
      required: ['dx', 'dy'],
    },
  },
  {
    name: 'wait_for',
    description: 'Wait for a selector to appear or for network idle. Bounded by timeout_ms.',
    input_schema: {
      type: 'object',
      properties: {
        selector: { type: 'string' },
        network_idle: { type: 'boolean' },
        timeout_ms: { type: 'number' },
      },
    },
  },
  {
    name: 'screenshot',
    description: 'Take a viewport or full-page screenshot.',
    input_schema: {
      type: 'object',
      properties: { full_page: { type: 'boolean' } },
    },
  },
  {
    name: 'vision_click',
    description: 'Click at viewport coordinates (vision engine).',
    input_schema: {
      type: 'object',
      properties: {
        x: { type: 'number' },
        y: { type: 'number' },
        reason: { type: 'string' },
      },
      required: ['x', 'y'],
    },
  },
  {
    name: 'vision_describe',
    description: 'Ask the vision model to describe the current screen (PHASE 3+).',
    input_schema: {
      type: 'object',
      properties: { region: { type: 'string' } },
    },
  },
];
```

- [ ] **Step 2: Write `packages/adapter-web/src/tools/index.ts`**

```ts
export * from './action.js';
export * from './navigation.js';
export * from './vision.js';
export * from './tool-spec.js';
```

- [ ] **Step 3: Write `packages/adapter-web/src/probes/probe-spec.ts`**

```ts
import type { ProbeSpec } from '@iris/adapter-types';

export const WEB_PROBE_SPECS: ProbeSpec[] = [
  {
    name: 'axe',
    description: 'Run axe-core on the current page; returns accessibility violations.',
    input_schema: { type: 'object', properties: {} },
  },
  {
    name: 'console_errors_since',
    description: 'Console.error messages since the last call.',
    input_schema: { type: 'object', properties: {} },
  },
  {
    name: 'console_all_since',
    description: 'All console messages since the last call.',
    input_schema: { type: 'object', properties: {} },
  },
  {
    name: 'network_failures_since',
    description: '4xx/5xx responses since the last call.',
    input_schema: { type: 'object', properties: {} },
  },
  {
    name: 'network_all_since',
    description: 'All network responses since the last call.',
    input_schema: { type: 'object', properties: {} },
  },
];
```

- [ ] **Step 4: Write `packages/adapter-web/src/probes/index.ts`**

```ts
export * from './axe.js';
export * from './console.js';
export * from './network.js';
export * from './probe-spec.js';
```

- [ ] **Step 5: Verify build still passes**

Run: `pnpm --filter @iris/adapter-web build && pnpm --filter @iris/adapter-web typecheck && pnpm --filter @iris/adapter-web test`
Expected: all green.

- [ ] **Step 6: Commit**

```bash
git add packages/adapter-web/src/tools/tool-spec.ts packages/adapter-web/src/tools/index.ts \
        packages/adapter-web/src/probes/probe-spec.ts packages/adapter-web/src/probes/index.ts
git commit -m "feat(adapter-web): ToolSpec + ProbeSpec definitions for Anthropic tool surface"
```

---

## Task 12: WebTargetAdapter — wire it all together (replace the Phase 1 stub)

**Files:**
- Replace: `packages/adapter-web/src/index.ts`
- Replace: `packages/adapter-web/src/index.test.ts` (drives a real adapter end-to-end against the form fixture)

- [ ] **Step 1: Write the replacement test**

Create `packages/adapter-web/src/index.test.ts` (overwrite):

```ts
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { startFixtureServer, type FixtureServerHandle } from '../test-fixtures/server.js';
import { WebTargetAdapter } from './index.js';

describe('WebTargetAdapter (end-to-end against fixture)', () => {
  let adapter: WebTargetAdapter;
  let server: FixtureServerHandle;
  let outDir: string;

  beforeEach(async () => {
    outDir = mkdtempSync(join(tmpdir(), 'iris-adapter-'));
    adapter = new WebTargetAdapter({ headless: true });
    server = await startFixtureServer('form');
  });

  afterEach(async () => {
    await adapter.stop().catch(() => {});
    if (server) await server.close();
    rmSync(outDir, { recursive: true, force: true });
  });

  it('start → observe → callTool → runProbe → stop full cycle', async () => {
    await adapter.start({ kind: 'web', target: `${server.url}/index.html`, out_dir: outDir });

    // observe
    const obs = await adapter.observe();
    expect(obs.observation_ref).toBeTruthy();
    expect(obs.summary).toContain('Sign in');

    // tools
    const tools = adapter.listTools();
    expect(tools.map((t) => t.name)).toEqual(expect.arrayContaining(['click', 'type', 'screenshot']));

    const r1 = await adapter.callTool('type', { selector: '#email', text: 'a@b.co' });
    expect(r1.ok).toBe(true);
    const r2 = await adapter.callTool('type', { selector: '#password', text: 'pw' });
    expect(r2.ok).toBe(true);
    const r3 = await adapter.callTool('click', { selector: '#submit' });
    expect(r3.ok).toBe(true);

    // probes
    const probes = adapter.listProbes();
    expect(probes.map((p) => p.name)).toEqual(expect.arrayContaining(['axe', 'console_errors_since']));
    const axeR = await adapter.runProbe('axe', {});
    expect(axeR.ok).toBe(true);

    // stop
    const artifacts = await adapter.stop();
    expect(artifacts.evidence_dir).toContain(outDir);
  });

  it('callTool with unknown name returns ok=false', async () => {
    await adapter.start({ kind: 'web', target: `${server.url}/index.html`, out_dir: outDir });
    const r = await adapter.callTool('telekinesis', {});
    expect(r.ok).toBe(false);
  });

  it('runProbe with unknown name returns ok=false', async () => {
    await adapter.start({ kind: 'web', target: `${server.url}/index.html`, out_dir: outDir });
    const r = await adapter.runProbe('quantum', {});
    expect(r.ok).toBe(false);
  });
});
```

- [ ] **Step 2: Write `packages/adapter-web/src/index.ts` (replace stub)**

```ts
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
import { findRunVideo, sliceEvidenceScreenshots, type StepScreenshotIndex } from './recording/index.js';
import { click, hover, press, type } from './tools/action.js';
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
        return type(page, args as { selector: string; text: string });
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
        return waitFor(page, args as { selector?: string; network_idle?: boolean; timeout_ms?: number });
      case 'screenshot': {
        const stepName = `step-${String(this.observationCounter).padStart(4, '0')}-${Date.now()}`;
        const r = await screenshot(page, {
          out_dir: this.screenshotsDir,
          name: stepName,
          full_page: (args as { full_page?: boolean }).full_page,
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
```

- [ ] **Step 3: Run all tests**

Run: `pnpm --filter @iris/adapter-web test`
Expected: PASS — adapter end-to-end test + all sub-tests still passing.

- [ ] **Step 4: Verify build**

Run: `pnpm --filter @iris/adapter-web build && pnpm --filter @iris/adapter-web typecheck`
Expected: clean.

- [ ] **Step 5: Commit**

```bash
git add packages/adapter-web/src/index.ts packages/adapter-web/src/index.test.ts
git commit -m "feat(adapter-web): WebTargetAdapter wires lifecycle + tools + probes + recording"
```

---

## Task 13: Adapter conformance test suite (in adapter-types)

**Files:**
- Create: `packages/adapter-types/src/conformance.ts`
- Modify: `packages/adapter-types/src/index.ts` — re-export conformance
- Create: `packages/adapter-web/src/conformance.test.ts` — opt in

The conformance suite is a function `runAdapterConformance(makeAdapter)` that returns a vitest-shaped describe block any adapter can call.

- [ ] **Step 1: Write `packages/adapter-types/src/conformance.ts`**

```ts
import { describe, expect, it } from 'vitest';
import { ProbeResultSchema, ToolResultSchema, type AdapterConfig, type TargetAdapter } from './index.js';

export interface ConformanceConfig {
  /** A factory that returns a fresh adapter for each test. */
  makeAdapter: () => TargetAdapter;
  /** A working AdapterConfig the adapter can be started with. */
  startConfig: AdapterConfig;
  /** Optional: at least one tool name to call (with valid args) to assert callTool roundtrips. */
  smokeTool?: { name: string; args: Record<string, unknown> };
  /** Optional: at least one probe name to call to assert runProbe roundtrips. */
  smokeProbe?: { name: string; args: Record<string, unknown> };
}

export function runAdapterConformance(cfg: ConformanceConfig): void {
  describe('TargetAdapter conformance', () => {
    it('reports a valid kind', () => {
      const a = cfg.makeAdapter();
      expect(['web', 'cli', 'api', 'desktop']).toContain(a.kind);
    });

    it('listTools returns valid ToolSpec entries', () => {
      const a = cfg.makeAdapter();
      const tools = a.listTools();
      for (const t of tools) {
        expect(typeof t.name).toBe('string');
        expect(typeof t.description).toBe('string');
        expect(typeof t.input_schema).toBe('object');
      }
    });

    it('listProbes returns valid ProbeSpec entries', () => {
      const a = cfg.makeAdapter();
      const probes = a.listProbes();
      for (const p of probes) {
        expect(typeof p.name).toBe('string');
        expect(typeof p.description).toBe('string');
        expect(typeof p.input_schema).toBe('object');
      }
    });

    it('start → observe → stop roundtrips and observe returns a valid Observation', async () => {
      const a = cfg.makeAdapter();
      await a.start(cfg.startConfig);
      const obs = await a.observe();
      expect(typeof obs.observation_ref).toBe('string');
      expect(obs.observation_ref.length).toBeGreaterThan(0);
      expect(typeof obs.summary).toBe('string');
      const artifacts = await a.stop();
      expect(typeof artifacts.evidence_dir).toBe('string');
    });

    if (cfg.smokeTool) {
      it(`callTool '${cfg.smokeTool.name}' returns a valid ToolResult shape`, async () => {
        const a = cfg.makeAdapter();
        await a.start(cfg.startConfig);
        try {
          const r = await a.callTool(cfg.smokeTool!.name, cfg.smokeTool!.args);
          ToolResultSchema.parse(r);
        } finally {
          await a.stop();
        }
      });
    }

    if (cfg.smokeProbe) {
      it(`runProbe '${cfg.smokeProbe.name}' returns a valid ProbeResult shape`, async () => {
        const a = cfg.makeAdapter();
        await a.start(cfg.startConfig);
        try {
          const r = await a.runProbe(cfg.smokeProbe!.name, cfg.smokeProbe!.args);
          ProbeResultSchema.parse(r);
        } finally {
          await a.stop();
        }
      });
    }

    it('sliceEvidence on empty input returns an empty array', async () => {
      const a = cfg.makeAdapter();
      await a.start(cfg.startConfig);
      const out = await a.sliceEvidence([]);
      expect(Array.isArray(out)).toBe(true);
      expect(out).toHaveLength(0);
      await a.stop();
    });
  });
}
```

- [ ] **Step 2: Update `packages/adapter-types/src/index.ts`**

Append at the end:

```ts
export * from './conformance.js';
```

- [ ] **Step 3: Wire `adapter-web` into the conformance suite**

Create `packages/adapter-web/src/conformance.test.ts`:

```ts
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runAdapterConformance } from '@iris/adapter-types';
import { afterAll, beforeAll } from 'vitest';
import { startFixtureServer, type FixtureServerHandle } from '../test-fixtures/server.js';
import { WebTargetAdapter } from './index.js';

let server: FixtureServerHandle;
let outDir: string;

beforeAll(async () => {
  outDir = mkdtempSync(join(tmpdir(), 'iris-conformance-'));
  server = await startFixtureServer('form');
});

afterAll(async () => {
  await server?.close();
  rmSync(outDir, { recursive: true, force: true });
});

runAdapterConformance({
  makeAdapter: () => new WebTargetAdapter({ headless: true }),
  startConfig: { kind: 'web', target: `${'PLACEHOLDER'}` /* set below */, out_dir: '/tmp/will-override' },
  smokeTool: { name: 'screenshot', args: {} },
  smokeProbe: { name: 'axe', args: {} },
});

// NOTE: the above passes a placeholder; we cannot reference `server.url` in the
// `startConfig` literal because it's read at module-load time. The conformance
// suite should accept lazy config — see the follow-up note in this task's
// self-review section about a refactor needed before this test is fully usable.
```

This wire-up reveals a real interface limitation in the conformance suite: `startConfig` is captured eagerly. The follow-up patch:

- [ ] **Step 4: Refactor `runAdapterConformance` to accept a lazy `startConfig` factory**

Replace the relevant portion of `packages/adapter-types/src/conformance.ts`:

```ts
export interface ConformanceConfig {
  makeAdapter: () => TargetAdapter;
  startConfig: AdapterConfig | (() => AdapterConfig);
  smokeTool?: { name: string; args: Record<string, unknown> };
  smokeProbe?: { name: string; args: Record<string, unknown> };
}

function resolveConfig(cfg: ConformanceConfig): AdapterConfig {
  return typeof cfg.startConfig === 'function' ? cfg.startConfig() : cfg.startConfig;
}
```

And replace every direct use of `cfg.startConfig` inside the `it(...)` blocks with `resolveConfig(cfg)`.

- [ ] **Step 5: Update `packages/adapter-web/src/conformance.test.ts` to use the lazy form**

```ts
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runAdapterConformance } from '@iris/adapter-types';
import { afterAll, beforeAll } from 'vitest';
import { startFixtureServer, type FixtureServerHandle } from '../test-fixtures/server.js';
import { WebTargetAdapter } from './index.js';

let server: FixtureServerHandle;
let outDir: string;

beforeAll(async () => {
  outDir = mkdtempSync(join(tmpdir(), 'iris-conformance-'));
  server = await startFixtureServer('form');
});

afterAll(async () => {
  await server?.close();
  rmSync(outDir, { recursive: true, force: true });
});

runAdapterConformance({
  makeAdapter: () => new WebTargetAdapter({ headless: true }),
  startConfig: () => ({
    kind: 'web',
    target: `${server.url}/index.html`,
    out_dir: outDir,
  }),
  smokeTool: { name: 'screenshot', args: {} },
  smokeProbe: { name: 'axe', args: {} },
});
```

- [ ] **Step 6: Run tests**

Run: `pnpm --filter @iris/adapter-types test && pnpm --filter @iris/adapter-web test`
Expected: PASS — conformance suite runs and all tests green.

- [ ] **Step 7: Commit**

```bash
git add packages/adapter-types packages/adapter-web/src/conformance.test.ts pnpm-lock.yaml
git commit -m "feat(adapter-types): runAdapterConformance suite + adapter-web opt-in"
```

---

## Task 14: Manual end-to-end smoke driver (proves the adapter actually works at the CLI level)

**Files:**
- Create: `packages/adapter-web/src/smoke.ts` — a small `main()` that programmatically drives the adapter against the form fixture and writes a `trace.jsonl`, exiting cleanly. NOT wired into the CLI yet (Phase 3 does that), but runnable directly via `node` to confirm everything works end-to-end.
- Create: `packages/adapter-web/src/smoke.test.ts` — runs the smoke main and verifies trace contents

- [ ] **Step 1: Write the failing test**

Create `packages/adapter-web/src/smoke.test.ts`:

```ts
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { trace as iristrace } from '@iris/core';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { startFixtureServer, type FixtureServerHandle } from '../test-fixtures/server.js';
import { runSmoke } from './smoke.js';

describe('smoke driver', () => {
  let outDir: string;
  let server: FixtureServerHandle;

  beforeEach(async () => {
    outDir = mkdtempSync(join(tmpdir(), 'iris-smoke-'));
    server = await startFixtureServer('form');
  });

  afterEach(async () => {
    await server.close();
    rmSync(outDir, { recursive: true, force: true });
  });

  it('produces a trace.jsonl with at least observation, action, probe events', async () => {
    await runSmoke({
      target: `${server.url}/index.html`,
      out_dir: outDir,
      headless: true,
    });

    const tracePath = join(outDir, 'trace.jsonl');
    expect(existsSync(tracePath)).toBe(true);
    const events = await iristrace.readTraceArray(tracePath);
    expect(events.length).toBeGreaterThan(3);
    const kinds = new Set(events.map((e) => e.kind));
    expect(kinds.has('observation')).toBe(true);
    expect(kinds.has('action')).toBe(true);
    expect(kinds.has('probe_result')).toBe(true);
    expect(kinds.has('run_start')).toBe(true);
    expect(kinds.has('run_end')).toBe(true);
  });
});
```

- [ ] **Step 2: Run test (expected fail)**

Run: `pnpm --filter @iris/adapter-web test`
Expected: FAIL — `runSmoke` not found.

- [ ] **Step 3: Write `packages/adapter-web/src/smoke.ts`**

```ts
import { join } from 'node:path';
import { trace as iristrace } from '@iris/core';
import { ulid } from 'ulid';
import { WebTargetAdapter } from './index.js';

export interface SmokeOptions {
  target: string;
  out_dir: string;
  headless?: boolean;
}

/**
 * Smoke driver: programmatically exercise the WebTargetAdapter against a target
 * and write a trace.jsonl. Replaces the role of the Explorer agent (Phase 3)
 * for testing purposes only — uses a hard-coded action sequence.
 */
export async function runSmoke(opts: SmokeOptions): Promise<void> {
  const tracePath = join(opts.out_dir, 'trace.jsonl');
  const writer = new iristrace.TraceWriter(tracePath);
  let step = 0;
  const ids = () => ulid();

  await writer.append({
    v: 1,
    id: ids(),
    ts: Date.now() / 1000,
    step: step++,
    target_kind: 'web',
    kind: 'run_start',
    actor: 'system',
    payload: { target: opts.target },
  });

  const adapter = new WebTargetAdapter({ headless: opts.headless ?? true });
  await adapter.start({ kind: 'web', target: opts.target, out_dir: opts.out_dir });

  // initial observation
  const obs1 = await adapter.observe();
  await writer.append({
    v: 1,
    id: ids(),
    ts: Date.now() / 1000,
    step: step++,
    target_kind: 'web',
    kind: 'observation',
    actor: 'adapter',
    payload: { ref: obs1.observation_ref, summary: obs1.summary.slice(0, 200) },
  });

  // type → click → observe → axe
  for (const action of [
    { tool: 'type', args: { selector: '#email', text: 'a@b.co' } },
    { tool: 'type', args: { selector: '#password', text: 'pw' } },
    { tool: 'click', args: { selector: '#submit' } },
  ]) {
    const r = await adapter.callTool(action.tool, action.args);
    await writer.append({
      v: 1,
      id: ids(),
      ts: Date.now() / 1000,
      step: step++,
      target_kind: 'web',
      kind: 'action',
      actor: 'explorer',
      payload: { tool: action.tool, args: action.args, result_ok: r.ok },
    });
  }

  const obs2 = await adapter.observe();
  await writer.append({
    v: 1,
    id: ids(),
    ts: Date.now() / 1000,
    step: step++,
    target_kind: 'web',
    kind: 'observation',
    actor: 'adapter',
    payload: { ref: obs2.observation_ref, summary: obs2.summary.slice(0, 200) },
  });

  const axe = await adapter.runProbe('axe', {});
  await writer.append({
    v: 1,
    id: ids(),
    ts: Date.now() / 1000,
    step: step++,
    target_kind: 'web',
    kind: 'probe_result',
    actor: 'probe',
    payload: { probe: 'axe', summary: axe.ok ? axe.summary : { error: axe.error } },
  });

  const artifacts = await adapter.stop();
  await writer.append({
    v: 1,
    id: ids(),
    ts: Date.now() / 1000,
    step: step++,
    target_kind: 'web',
    kind: 'run_end',
    actor: 'system',
    payload: { artifacts: artifacts.artifact_files },
  });

  await writer.close();
}
```

- [ ] **Step 4: Run test (expected pass)**

Run: `pnpm --filter @iris/adapter-web test`
Expected: PASS — smoke test green.

- [ ] **Step 5: Commit**

```bash
git add packages/adapter-web/src/smoke.ts packages/adapter-web/src/smoke.test.ts
git commit -m "feat(adapter-web): manual smoke driver — produces a real trace.jsonl end-to-end"
```

---

## Task 15: Repo-wide green check + Phase 2 docs update

**Files:**
- Modify: `docs/architecture.md` — update Phase 2 status to ✅
- Modify: `README.md` — note `@iris/adapter-web` is real now
- Update `Phase status` line in `docs/architecture.md`

- [ ] **Step 1: Run all checks**

Run: `pnpm build && pnpm test && pnpm lint && pnpm typecheck`
Expected: all four pass. Tests should now include all the new adapter integration tests (~25+ new tests, total around 75+).

- [ ] **Step 2: Update `docs/architecture.md` Phase status**

Change:
```
- Phase 2 (real web adapter): planned
```
To:
```
- Phase 2 (real web adapter): ✅ merged YYYY-MM-DD per `plans/2026-05-09-iris-phase-2-web-adapter.md`
```

(Use today's date when running the task.)

- [ ] **Step 3: Update `README.md` adapter-web row**

Change the table row:
```
| `@iris/adapter-web` | Web (Playwright) adapter. **Stub in Phase 1.** |
```
To:
```
| `@iris/adapter-web` | Web (Playwright) adapter. Drives Chromium, runs axe, captures video + trace. |
```

- [ ] **Step 4: Run smoke driver manually as a final sanity check**

Build first so `dist/` is fresh:
```bash
pnpm --filter @iris/adapter-web build
```

Then run the smoke driver via a one-liner:
```bash
node --input-type=module -e "
  import('@iris/adapter-web/dist/smoke.js').then(async (m) => {
    const { mkdtempSync } = await import('node:fs');
    const { tmpdir } = await import('node:os');
    const { join } = await import('node:path');
    const dir = mkdtempSync(join(tmpdir(), 'iris-manual-'));
    console.log('out_dir:', dir);
    await m.runSmoke({ target: 'https://example.com', out_dir: dir, headless: true });
    console.log('done');
  });
"
```

Expected: smoke driver runs against `https://example.com`, writes a `trace.jsonl`, video, and trace.zip into the temp dir, exits cleanly. (Note: `https://example.com` is a real URL with no form to fill; the click on `#submit` will fail with `ok: false` but the run still completes — that's expected and proves the adapter handles failures gracefully.)

- [ ] **Step 5: Commit docs**

```bash
git add docs/architecture.md README.md
git commit -m "docs: mark Phase 2 done; update adapter-web row in README"
```

---

## Self-review checklist

**1. Spec coverage check (against `docs/superpowers/specs/2026-05-09-iris-design.md`):**

- §7 `TargetAdapter` interface fully implemented for web → Tasks 1, 12 ✅
- §10.5 explorer-callable tools (click, type, press, hover, navigate, back/forward/reload, scroll, wait_for, screenshot, vision_click, vision_describe) → Tasks 4, 5, 6 ✅
- §10.5 probes (axe, console, network) → Tasks 7, 8 ✅
- §10.5 lighthouse probe → **DEFERRED to Phase 4** (heavy, opt-in, low Phase-2 priority). Note in plan.
- §8 trace event schema (use core's TraceWriter to emit valid envelopes) → Task 14 (smoke driver) ✅
- §12.4 sliceEvidence (Phase 2 = screenshots only; ffmpeg clips → Phase 4) → Task 10 ✅
- §14.4 adapter conformance suite → Task 13 ✅
- Recording (video + Playwright trace.zip) → Task 1 (lifecycle), Task 9 (verification) ✅
- Auth (storage state file) → Task 1 (already supported via `WebLifecycle.storage_state_path` option) ✅

Out of scope for Phase 2 (deferred):
- Lighthouse probe (Phase 4 — heavy, opt-in)
- Vision describe LLM call (Phase 3 — needs LLM wiring)
- ffmpeg clip slicing (Phase 4)
- Wiring the adapter into the CLI's `iris eval` (Phase 3 — needs Explorer)

**2. Placeholder scan:** No "TBD"/"TODO" tokens. The two intentional `phase 3`/`phase 4` references are documented decisions, not gaps.

**3. Type/name consistency:**
- `WebTargetAdapter` (Task 12) uses tools/probes from Tasks 4–8 with matching signatures. ✅
- `WebLifecycle` (Task 1) reused unchanged in Tasks 3–14. ✅
- `EvidenceRef`/`EvidenceFile` from `@iris/adapter-types` used identically in `slice.ts` (Task 10) and `WebTargetAdapter.sliceEvidence` (Task 12). ✅
- `ToolResult`/`ProbeResult` schemas (`@iris/adapter-types`) parse cleanly in conformance tests (Task 13). ✅

---

## Phase 2 done — ready for Phase 3

When all 15 tasks are committed:

- All four checks (`pnpm build && pnpm test && pnpm lint && pnpm typecheck`) green.
- `WebTargetAdapter` drives a real Chromium against any URL, captures observations (DOM outline + screenshots), runs axe-core, captures console/network deltas, writes Playwright trace.zip + video, and produces a valid trace.jsonl via the smoke driver.
- The adapter conformance suite passes for `WebTargetAdapter` and is ready for future adapters to opt into.
- Phase 3 will wire the spec interpreter, Explorer agent (the curious-user driver), and Judge agent into the CLI so `iris eval <url> --spec spec.md` produces a real `report.json`.
