import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { type FixtureServerHandle, startFixtureServer } from '../../test-fixtures/server.js';
import { WebLifecycle } from '../lifecycle.js';
import { runNotificationsProbe } from './notifications.js';

describe('runNotificationsProbe', () => {
  let lc: WebLifecycle;
  let server: FixtureServerHandle;

  beforeEach(async () => {
    lc = new WebLifecycle({ headless: true });
    await lc.start();
    server = await startFixtureServer('toasts');
    await lc.getPage().goto(`${server.url}/index.html`);
  });

  afterEach(async () => {
    if (server) await server.close();
    await lc.stop();
  });

  it('captures aria-live, role=alert, role=status, class-based, and corner toasts', async () => {
    const r = await runNotificationsProbe(lc.getPage());
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    const items = r.data as Array<{ text: string; source: string }>;
    const texts = items.map((i) => i.text);
    expect(texts).toContain('Saved successfully'); // aria-live
    expect(texts).toContain('Invalid email address'); // role=alert
    expect(texts).toContain('Loading complete'); // role=status
    expect(texts).toContain('Exported as HTML'); // Toastify class
    expect(texts).toContain('Settings updated'); // MUI class
    expect(texts).toContain('Preparing HTML...'); // fixed corner
  });

  it('skips empty and hidden notifications', async () => {
    const r = await runNotificationsProbe(lc.getPage());
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    const items = r.data as Array<{ text: string }>;
    // The empty aria-live region has empty text and should be skipped.
    expect(items.some((i) => i.text.trim() === '')).toBe(false);
    // The hidden role=alert ("This is hidden — invisible") should be skipped.
    expect(items.some((i) => i.text.includes('This is hidden'))).toBe(false);
  });
});
