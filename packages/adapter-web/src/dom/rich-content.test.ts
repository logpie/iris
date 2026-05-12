import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { type FixtureServerHandle, startFixtureServer } from '../../test-fixtures/server.js';
import { WebLifecycle } from '../lifecycle.js';
import { formatRichContent, richContent } from './rich-content.js';

describe('richContent extractor', () => {
  let lc: WebLifecycle;
  let server: FixtureServerHandle;

  beforeEach(async () => {
    lc = new WebLifecycle({ headless: true });
    await lc.start();
    server = await startFixtureServer('editors');
    await lc.getPage().goto(`${server.url}/index.html`);
  });

  afterEach(async () => {
    if (server) await server.close();
    await lc.stop();
  });

  it('extracts plain textarea value', async () => {
    const items = await richContent(lc.getPage());
    const ta = items.find((i) => i.kind === 'textarea' && i.label === 'textarea#plain-ta');
    expect(ta?.text).toBe('textarea preloaded value');
  });

  it('extracts plain input value', async () => {
    const items = await richContent(lc.getPage());
    const inp = items.find((i) => i.kind === 'input' && i.label === 'input[type=text]#plain-input');
    expect(inp?.text).toBe('input preloaded value');
  });

  it('extracts contenteditable text including nested formatting', async () => {
    const items = await richContent(lc.getPage());
    const ce = items.find((i) => i.kind === 'contenteditable');
    expect(ce?.text).toContain('contenteditable paragraph');
    expect(ce?.text).toContain('bold');
    expect(ce?.text).toContain('Second paragraph');
  });

  it('extracts CodeMirror v6 (.cm-editor .cm-line) — the Dillinger blindness case', async () => {
    const items = await richContent(lc.getPage());
    const cm = items.find((i) => i.kind === 'codemirror' && i.label.includes('.cm-editor'));
    expect(cm?.text).toContain('# My Test Heading');
    expect(cm?.text).toContain('- Item one');
    expect(cm?.text).toContain('- Item three');
  });

  it('extracts CodeMirror v5 (.CodeMirror .CodeMirror-line)', async () => {
    const items = await richContent(lc.getPage());
    const cm = items.find((i) => i.kind === 'codemirror' && i.label.includes('.CodeMirror'));
    expect(cm?.text).toContain('function hello()');
    expect(cm?.text).toContain('return 42');
  });

  it('extracts Monaco (.monaco-editor .view-line)', async () => {
    const items = await richContent(lc.getPage());
    const m = items.find((i) => i.kind === 'monaco');
    expect(m?.text).toContain('const greeting');
    expect(m?.text).toContain('Hello, Monaco');
    expect(m?.text).toContain('console.log');
  });

  it('extracts ACE (.ace_editor .ace_line)', async () => {
    const items = await richContent(lc.getPage());
    const a = items.find((i) => i.kind === 'ace');
    expect(a?.text).toContain('SELECT * FROM users');
    expect(a?.text).toContain('WHERE id = 1;');
  });

  it('skips empty textareas and empty editor surfaces', async () => {
    const items = await richContent(lc.getPage());
    const empties = items.filter(
      (i) =>
        (i.kind === 'textarea' && i.label === 'textarea#empty-ta') || i.text.trim().length === 0,
    );
    expect(empties).toHaveLength(0);
  });

  it('captures typed text in textarea AFTER user interaction (not just initial value)', async () => {
    const page = lc.getPage();
    await page.locator('#plain-ta').fill('user typed this');
    const items = await richContent(page);
    const ta = items.find((i) => i.kind === 'textarea' && i.label === 'textarea#plain-ta');
    expect(ta?.text).toBe('user typed this');
  });

  it('formatRichContent produces compact block output', () => {
    const fmt = formatRichContent([
      { kind: 'textarea', label: 'textarea#x', text: 'abc' },
      { kind: 'codemirror', label: '.cm-editor', text: 'line1\nline2' },
    ]);
    expect(fmt).toContain('[textarea textarea#x]');
    expect(fmt).toContain('abc');
    expect(fmt).toContain('[codemirror .cm-editor]');
    expect(fmt).toContain('line1\nline2');
  });

  it('formatRichContent returns empty string on empty input', () => {
    expect(formatRichContent([])).toBe('');
  });
});
