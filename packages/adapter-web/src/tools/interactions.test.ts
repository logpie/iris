import { existsSync, readFileSync } from 'node:fs';
import { mkdtempSync, rmSync } from 'node:fs';
import { platform, tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { type FixtureServerHandle, startFixtureServer } from '../../test-fixtures/server.js';
import { WebLifecycle } from '../lifecycle.js';
import { click } from './action.js';
import { doubleClick, hoverWait, rightClick } from './click-variants.js';
import { clickDownload } from './download.js';
import { drag, visionDrag } from './drag.js';
import { clickUpload } from './file-chooser.js';
import { keyChord } from './key-chord.js';
import { paste } from './paste.js';
import { upload } from './upload.js';

describe('phase 9 interaction primitives', () => {
  let lc: WebLifecycle;
  let server: FixtureServerHandle;
  let tmp: string;

  beforeEach(async () => {
    tmp = mkdtempSync(join(tmpdir(), 'iris-interactions-'));
    lc = new WebLifecycle({ headless: true });
    await lc.start();
    server = await startFixtureServer('interactions');
    await lc.getPage().goto(`${server.url}/index.html`);
  });

  afterEach(async () => {
    if (server) await server.close();
    await lc.stop();
    rmSync(tmp, { recursive: true, force: true });
  });

  it('drag (selector form) drags by dx/dy and creates a shape', async () => {
    const page = lc.getPage();
    const r = await drag(page, { selector: '#canvas', dx: 60, dy: 40 });
    expect(r.ok).toBe(true);
    const log = await page.locator('#drag-log').textContent();
    // The shape is created with size approximately (60, 40). Allow ±5 to
    // tolerate sub-pixel rounding and the fact that we started from element
    // center then moved to center + (dx,dy).
    const m = log?.match(/shape:(\d+)x(\d+)/);
    expect(m).toBeTruthy();
    const w = Number(m?.[1]);
    const h = Number(m?.[2]);
    expect(Math.abs(w - 60)).toBeLessThan(6);
    expect(Math.abs(h - 40)).toBeLessThan(6);
  });

  it('vision_drag draws a shape on canvas from coordinate to coordinate', async () => {
    const page = lc.getPage();
    const box = await page.locator('#canvas').boundingBox();
    if (!box) throw new Error('no canvas box');
    const r = await visionDrag(page, {
      from: { x: box.x + 20, y: box.y + 20 },
      to: { x: box.x + 100, y: box.y + 80 },
    });
    expect(r.ok).toBe(true);
    const log = await page.locator('#drag-log').textContent();
    expect(log).toMatch(/shape:\d+x\d+/);
  });

  it('right_click opens a context menu', async () => {
    const page = lc.getPage();
    const r = await rightClick(page, { selector: '#ctx-target' });
    expect(r.ok).toBe(true);
    expect(await page.locator('#right-click-log').textContent()).toBe('context-menu-opened');
    const display = await page.locator('#ctx-menu').evaluate((el) => getComputedStyle(el).display);
    expect(display).not.toBe('none');
  });

  it('double_click fires dblclick', async () => {
    const page = lc.getPage();
    const r = await doubleClick(page, { selector: '#dbl-target' });
    expect(r.ok).toBe(true);
    expect(await page.locator('#double-click-log').textContent()).toBe('double-clicked');
  });

  it('key_chord fires modifier + key combo', async () => {
    const page = lc.getPage();
    await page.locator('#chord-input').focus();
    const mod = platform() === 'darwin' ? 'Meta' : 'Control';
    const r = await keyChord(page, { keys: [mod, 'a'] });
    expect(r.ok).toBe(true);
    const log = await page.locator('#key-chord-log').textContent();
    expect(log).toContain('chord');
    // We expect at least a modifier-prefixed event.
    expect(log).toMatch(/chord:(Ctrl|Meta)\+/);
  });

  it('key_chord normalizes CmdOrCtrl to the platform default', async () => {
    const page = lc.getPage();
    await page.locator('#chord-input').focus();
    const r = await keyChord(page, { keys: ['CmdOrCtrl', 'z'] });
    expect(r.ok).toBe(true);
    const log = await page.locator('#key-chord-log').textContent();
    expect(log).toMatch(/chord:(Ctrl|Meta)\+z/);
  });

  it('paste fires a paste event with the text', async () => {
    const page = lc.getPage();
    const r = await paste(page, { selector: '#paste-target', text: 'hello world' });
    expect(r.ok).toBe(true);
    expect(await page.locator('#paste-log').textContent()).toBe('pasted:hello world');
    // The textarea value should also have been updated by the fallback insert.
    expect(await page.locator('#paste-target').inputValue()).toBe('hello world');
  });

  it('hover_wait reveals the tooltip after the wait', async () => {
    const page = lc.getPage();
    const r = await hoverWait(page, { selector: '#hover-target', wait_ms: 400 });
    expect(r.ok).toBe(true);
    expect(await page.locator('#hover-log').textContent()).toBe('tooltip-shown');
    const display = await page.locator('#hover-tip').evaluate((el) => getComputedStyle(el).display);
    expect(display).not.toBe('none');
  });

  it('upload sets a file on a file input (synthetic fixture)', async () => {
    const page = lc.getPage();
    const r = await upload(page, { selector: '#file-input' });
    expect(r.ok).toBe(true);
    const log = await page.locator('#upload-log').textContent();
    expect(log).toMatch(/^uploaded:fixture\.png:\d+$/);
  });

  it('click_upload handles a visible control that opens a native file chooser', async () => {
    const page = lc.getPage();
    const r = await clickUpload(page, { selector: '#hidden-upload-button' });
    expect(r.ok).toBe(true);
    if (!r.ok) throw new Error(r.error);
    expect(r.evidence_refs?.[0]).toMatch(/fixture\.png$/);
    const log = await page.locator('#hidden-upload-log').textContent();
    expect(log).toMatch(/^menu-uploaded:fixture\.png:\d+$/);
  });

  it('plain click refuses likely file chooser controls before consuming them', async () => {
    const page = lc.getPage();
    const r = await click(page, { selector: '#hidden-upload-button' });
    expect(r.ok).toBe(false);
    if (r.ok) throw new Error('expected click to reject upload-like control');
    expect(r.error).toContain('click_upload');
    expect(await page.locator('#hidden-upload-log').textContent()).toBe('');
  });

  it('click_download saves a downloaded file as evidence', async () => {
    const page = lc.getPage();
    const downloadsDir = join(tmp, 'downloads');
    const r = await clickDownload(page, { selector: '#download-button' }, downloadsDir);
    expect(r.ok).toBe(true);
    if (!r.ok) throw new Error(r.error);
    const downloaded = r.evidence_refs?.[0];
    expect(downloaded).toBeTruthy();
    expect(downloaded).toMatch(/artifact\.txt$/);
    expect(existsSync(downloaded as string)).toBe(true);
    expect(readFileSync(downloaded as string, 'utf8')).toContain('iris artifact');
    expect(await page.locator('#download-log').textContent()).toBe('download-started:artifact.txt');
  });

  it('plain click refuses likely download controls before consuming them', async () => {
    const page = lc.getPage();
    const r = await click(page, { selector: '#download-button' });
    expect(r.ok).toBe(false);
    if (r.ok) throw new Error('expected click to reject download-like control');
    expect(r.error).toContain('click_download');
    expect(await page.locator('#download-log').textContent()).toBe('');
  });
});
