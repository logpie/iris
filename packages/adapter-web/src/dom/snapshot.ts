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
