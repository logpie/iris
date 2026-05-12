// Phase 11: rich content extractor. Iris's observation previously read only
// `document.body.innerText`, which is BLIND to:
//   - <textarea> and <input> current values
//   - contenteditable rich-text editors (ProseMirror, Lexical, Slate, …)
//   - code editors (CodeMirror v5/v6, Monaco, ACE)
//
// On Dillinger (CodeMirror) the Explorer typed Markdown but every observation
// was identical because the typed text never appeared in `innerText`. The
// Judge then concluded "typing failed" when the product worked fine — Iris
// was blind.
//
// This module returns a compact section that names each rich-content surface
// and its current text, suitable for inclusion in the observation summary.

import type { Page } from 'playwright';

export interface RichContentItem {
  kind: 'textarea' | 'input' | 'contenteditable' | 'codemirror' | 'monaco' | 'ace';
  label: string; // selector-ish identifier ("#editor", ".cm-editor[0]")
  text: string; // the visible content
}

const MAX_PER_ITEM = 800;
const MAX_TOTAL = 4000;

export async function richContent(page: Page): Promise<RichContentItem[]> {
  return await page.evaluate(
    ({ maxPerItem }) => {
      const out: Array<{ kind: string; label: string; text: string }> = [];

      const isVisible = (el: Element): boolean => {
        const e = el as HTMLElement;
        if (!e || !e.getBoundingClientRect) return false;
        const r = e.getBoundingClientRect();
        if (r.width === 0 || r.height === 0) return false;
        const style = window.getComputedStyle(e);
        return style.display !== 'none' && style.visibility !== 'hidden';
      };

      const labelFor = (el: Element, fallback: string): string => {
        const id = el.id ? `#${el.id}` : '';
        const aria = el.getAttribute('aria-label');
        const name = el.getAttribute('name');
        if (id) return `${fallback}${id}`;
        if (aria) return `${fallback}[aria-label="${aria.slice(0, 40)}"]`;
        if (name) return `${fallback}[name="${name}"]`;
        return fallback;
      };

      const trunc = (s: string): string =>
        s.length > maxPerItem ? `${s.slice(0, maxPerItem - 1)}…` : s;

      // 1. <textarea>
      for (const ta of Array.from(document.querySelectorAll('textarea'))) {
        if (!isVisible(ta)) continue;
        const value = (ta as HTMLTextAreaElement).value ?? '';
        if (!value.trim()) continue;
        out.push({ kind: 'textarea', label: labelFor(ta, 'textarea'), text: trunc(value) });
      }

      // 2. <input> — only meaningful types (skip hidden/checkbox/radio/file/button/submit).
      const INPUT_TEXTUAL_TYPES = new Set([
        'text',
        'search',
        'url',
        'email',
        'password',
        'tel',
        'number',
        'date',
        'time',
        'datetime-local',
        'month',
        'week',
        'color',
        '',
      ]);
      for (const inp of Array.from(document.querySelectorAll('input'))) {
        if (!isVisible(inp)) continue;
        const i = inp as HTMLInputElement;
        const type = (i.type ?? 'text').toLowerCase();
        if (!INPUT_TEXTUAL_TYPES.has(type)) continue;
        const value = i.value ?? '';
        if (!value.trim()) continue;
        out.push({
          kind: 'input',
          label: labelFor(inp, `input[type=${type || 'text'}]`),
          text: trunc(value),
        });
      }

      // 3. contenteditable — ProseMirror/Lexical/Slate use this.
      // Skip nested ones (a contenteditable inside another contenteditable);
      // only report the outermost.
      const ceAll = Array.from(
        document.querySelectorAll('[contenteditable="true"], [contenteditable=""]'),
      );
      const ceTop = ceAll.filter(
        (el) => !ceAll.some((other) => other !== el && other.contains(el)),
      );
      for (const ce of ceTop) {
        if (!isVisible(ce)) continue;
        const text = (ce as HTMLElement).innerText?.trim() ?? '';
        if (!text) continue;
        out.push({
          kind: 'contenteditable',
          label: labelFor(ce, '[contenteditable]'),
          text: trunc(text),
        });
      }

      // 4. CodeMirror v6 — lines live in `.cm-line` divs inside `.cm-editor .cm-content`.
      for (const cm of Array.from(document.querySelectorAll('.cm-editor'))) {
        if (!isVisible(cm)) continue;
        const lines = Array.from(cm.querySelectorAll('.cm-line'))
          .map((el) => (el as HTMLElement).textContent ?? '')
          .join('\n')
          .replace(/​/g, ''); // CM uses zero-width spaces for indentation guides
        if (!lines.trim()) continue;
        out.push({ kind: 'codemirror', label: labelFor(cm, '.cm-editor'), text: trunc(lines) });
      }

      // 5. CodeMirror v5 — `.CodeMirror` container, `.CodeMirror-line` per line.
      for (const cm of Array.from(document.querySelectorAll('.CodeMirror'))) {
        if (!isVisible(cm)) continue;
        const lines = Array.from(cm.querySelectorAll('.CodeMirror-line'))
          .map((el) => (el as HTMLElement).textContent ?? '')
          .join('\n')
          .replace(/​/g, '');
        if (!lines.trim()) continue;
        out.push({ kind: 'codemirror', label: labelFor(cm, '.CodeMirror'), text: trunc(lines) });
      }

      // 6. Monaco — `.monaco-editor` container, `.view-line` per visible line.
      // (Note: Monaco virtualizes — only visible lines are in DOM. That's fine
      // for our purposes; we want what the user sees.)
      for (const m of Array.from(document.querySelectorAll('.monaco-editor'))) {
        if (!isVisible(m)) continue;
        const lines = Array.from(m.querySelectorAll('.view-line'))
          .map((el) => (el as HTMLElement).textContent ?? '')
          .join('\n');
        if (!lines.trim()) continue;
        out.push({ kind: 'monaco', label: labelFor(m, '.monaco-editor'), text: trunc(lines) });
      }

      // 7. ACE — `.ace_editor` container, `.ace_line` per line.
      for (const a of Array.from(document.querySelectorAll('.ace_editor'))) {
        if (!isVisible(a)) continue;
        const lines = Array.from(a.querySelectorAll('.ace_line'))
          .map((el) => (el as HTMLElement).textContent ?? '')
          .join('\n');
        if (!lines.trim()) continue;
        out.push({ kind: 'ace', label: labelFor(a, '.ace_editor'), text: trunc(lines) });
      }

      return out as Array<{
        kind: 'textarea' | 'input' | 'contenteditable' | 'codemirror' | 'monaco' | 'ace';
        label: string;
        text: string;
      }>;
    },
    { maxPerItem: MAX_PER_ITEM },
  );
}

// Format a list of rich content items into a compact text section for
// inclusion in the observation summary.
export function formatRichContent(items: RichContentItem[]): string {
  if (items.length === 0) return '';
  const lines: string[] = [];
  let totalLen = 0;
  for (const item of items) {
    const block = `[${item.kind} ${item.label}]\n${item.text}`;
    if (totalLen + block.length > MAX_TOTAL) {
      lines.push(`… ${items.length - lines.length} more rich-content surfaces truncated`);
      break;
    }
    lines.push(block);
    totalLen += block.length;
  }
  return lines.join('\n\n');
}
