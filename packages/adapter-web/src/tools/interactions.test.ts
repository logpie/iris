import { platform } from 'node:os';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { type FixtureServerHandle, startFixtureServer } from '../../test-fixtures/server.js';
import { WebLifecycle } from '../lifecycle.js';
import { doubleClick, hoverWait, rightClick } from './click-variants.js';
import { drag, visionDrag } from './drag.js';
import { keyChord } from './key-chord.js';
import { paste } from './paste.js';
import { upload } from './upload.js';

describe('phase 9 interaction primitives', () => {
  let lc: WebLifecycle;
  let server: FixtureServerHandle;

  beforeEach(async () => {
    lc = new WebLifecycle({ headless: true });
    await lc.start();
    server = await startFixtureServer('interactions');
    await lc.getPage().goto(`${server.url}/index.html`);
  });

  afterEach(async () => {
    if (server) await server.close();
    await lc.stop();
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
});
