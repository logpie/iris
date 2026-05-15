import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { PerceptionState } from '@iris/adapter-types';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { type FixtureServerHandle, startFixtureServer } from '../test-fixtures/server.js';
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

    const obs = await adapter.observe();
    expect(obs.observation_ref).toBeTruthy();
    expect(obs.summary).toContain('Sign in');
    const state = obs.payload?.perception_state as PerceptionState | undefined;
    expect(state?.v).toBe(1);
    expect(state?.url).toContain('/index.html');
    const signIn = state?.elements.find((el) => el.name === 'Sign in' || el.text === 'Sign in');
    expect(signIn?.stable_hash).toMatch(/^h[0-9a-f]{8}$/);
    expect(signIn?.visible).toBe(true);
    expect(signIn?.bounds?.width).toBeGreaterThan(0);

    const tools = adapter.listTools();
    expect(tools.map((t) => t.name)).toEqual(
      expect.arrayContaining(['click', 'type', 'select_option', 'screenshot']),
    );

    const r1 = await adapter.callTool('type', { selector: '#email', text: 'a@b.co' });
    expect(r1.ok).toBe(true);
    const r2 = await adapter.callTool('type', { selector: '#password', text: 'pw' });
    expect(r2.ok).toBe(true);
    const r3 = await adapter.callTool('click', { selector: '#submit' });
    expect(r3.ok).toBe(true);

    const probes = adapter.listProbes();
    expect(probes.map((p) => p.name)).toEqual(
      expect.arrayContaining(['axe', 'console_errors_since']),
    );
    const axeR = await adapter.runProbe('axe', {});
    expect(axeR.ok).toBe(true);

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

  it('ui_state reports active element and selected element state', async () => {
    await adapter.start({ kind: 'web', target: `${server.url}/index.html`, out_dir: outDir });
    await adapter.callTool('click', { selector: '#email' });
    const r = await adapter.runProbe('ui_state', {
      selectors: ['#email', '#result', 'button:has-text("Sign in")'],
    });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.summary.activeElement).toMatchObject({ id: 'email' });
    expect(r.summary.selectors_found).toBe(3);
    expect((r.data as { selectors: Array<{ selector: string; found: boolean }> }).selectors).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ selector: '#email', found: true }),
        expect.objectContaining({ selector: 'button:has-text("Sign in")', found: true }),
      ]),
    );
  });

  it('select_option changes native select controls by visible label', async () => {
    await server.close();
    server = await startFixtureServer('survey');
    await adapter.start({ kind: 'web', target: `${server.url}/settings.html`, out_dir: outDir });

    const selected = await adapter.callTool('select_option', {
      selector: 'select[name="theme"]',
      label: 'Dark',
    });
    expect(selected.ok).toBe(true);
    const saved = await adapter.callTool('click', { selector: 'button:has-text("Save settings")' });
    expect(saved.ok).toBe(true);

    const obs = await adapter.observe();
    expect(obs.summary).toContain('Settings saved: Dark theme');
  });

  it('discoverySurvey sees menu and below-fold surfaces without mutating primary page', async () => {
    await server.close();
    server = await startFixtureServer('survey');
    await adapter.start({ kind: 'web', target: `${server.url}/index.html`, out_dir: outDir });
    const before = await adapter.runProbe('ui_state', { selectors: ['#menu-panel'] });
    expect(before.ok).toBe(true);
    if (!before.ok) return;
    expect(
      (before.data as { selectors: Array<{ selector: string; visible: boolean }> }).selectors[0]
        ?.visible,
    ).toBe(false);

    const survey = await adapter.discoverySurvey({ max_scrolls: 2, peek_menus: true });
    expect(survey.summary).toContain('Settings');
    expect(survey.summary).toContain('Privacy Policy');
    expect(survey.summary).toContain('after primary search journey');
    expect(survey.summary).toContain('OpenAI article');
    expect(survey.summary).toContain('View history');
    expect(survey.summary).toContain('sample nav: Settings');
    expect(survey.summary.indexOf('after primary search journey')).toBeLessThan(
      survey.summary.indexOf('initial viewport'),
    );
    const payload = survey.payload as {
      v: number;
      captures: Array<{ label: string }>;
      surfaces: Array<{ label: string; kind: string; source: string }>;
      links: Array<{ label: string; href: string; same_origin: boolean }>;
    };
    expect(payload.v).toBe(2);
    expect(payload.captures.some((capture) => capture.label === 'sample nav: Settings')).toBe(true);
    expect(payload.surfaces).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ label: 'Settings — Iris fixture', source: 'sample_nav' }),
        expect.objectContaining({ label: 'Search', kind: 'search' }),
        expect.objectContaining({ label: 'Privacy Policy', kind: 'footer' }),
      ]),
    );
    expect(payload.links).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ label: 'Settings', same_origin: true }),
      ]),
    );

    const after = await adapter.runProbe('ui_state', { selectors: ['#menu-panel'] });
    expect(after.ok).toBe(true);
    if (!after.ok) return;
    expect(
      (after.data as { selectors: Array<{ selector: string; visible: boolean }> }).selectors[0]
        ?.visible,
    ).toBe(false);
  });
});
