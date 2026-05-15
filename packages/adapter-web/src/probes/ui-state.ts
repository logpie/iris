import type { Page } from 'playwright';
import type { ProbeResult } from '@iris/adapter-types';

interface UiStateArgs {
  selectors?: string[];
}

export async function runUiState(page: Page, args: UiStateArgs = {}): Promise<ProbeResult> {
  const selectors = (args.selectors ?? [])
    .filter((selector) => typeof selector === 'string')
    .slice(0, 12);
  try {
    const base = await page.evaluate(() => {
      const shortText = (el: Element | null): string =>
        (el?.textContent ?? '').replace(/\s+/g, ' ').trim().slice(0, 160);
      const elementLabel = (el: Element | null) => {
        if (!el) return null;
        const html = el as HTMLElement;
        return {
          tag: el.tagName.toLowerCase(),
          id: html.id || null,
          className: html.className ? String(html.className).slice(0, 160) : null,
          role: el.getAttribute('role'),
          ariaLabel: el.getAttribute('aria-label'),
          name: el.getAttribute('name'),
          text: shortText(el),
        };
      };
      const bodyStyle = window.getComputedStyle(document.body);
      return {
        url: location.href,
        title: document.title,
        hash: location.hash,
        scroll: { x: window.scrollX, y: window.scrollY },
        viewport: { width: window.innerWidth, height: window.innerHeight },
        activeElement: elementLabel(document.activeElement),
        body: {
          className: document.body.className ? String(document.body.className).slice(0, 240) : '',
          fontSize: bodyStyle.fontSize,
          color: bodyStyle.color,
          backgroundColor: bodyStyle.backgroundColor,
        },
      };
    });
    const selectorStates = await Promise.all(selectors.map((selector) => selectorState(page, selector)));
    const data = { ...base, selectors: selectorStates };
    const found = data.selectors.filter((item) => item.found).length;
    return {
      ok: true,
      probe: 'ui_state',
      summary: {
        url: data.url,
        hash: data.hash,
        scroll: data.scroll,
        activeElement: data.activeElement,
        selectors_found: found,
        selectors_total: data.selectors.length,
      },
      data,
    };
  } catch (err) {
    return {
      ok: false,
      probe: 'ui_state',
      error: err instanceof Error ? err.message : String(err),
    };
  }
}

async function selectorState(page: Page, selector: string) {
  try {
    const locator = page.locator(selector).first();
    if ((await locator.count()) === 0) return { selector, found: false };
    return await locator.evaluate((el, inputSelector) => {
      const shortText = (target: Element | null): string =>
        (target?.textContent ?? '').replace(/\s+/g, ' ').trim().slice(0, 160);
      const html = el as HTMLElement;
      const rect = html.getBoundingClientRect();
      const style = window.getComputedStyle(html);
      const visible =
        rect.width > 0 &&
        rect.height > 0 &&
        style.display !== 'none' &&
        style.visibility !== 'hidden' &&
        Number(style.opacity || '1') > 0;
      const input = el as HTMLInputElement;
      return {
        selector: inputSelector,
        found: true,
        visible,
        text: shortText(el),
        rect: {
          x: Number(rect.x.toFixed(2)),
          y: Number(rect.y.toFixed(2)),
          width: Number(rect.width.toFixed(2)),
          height: Number(rect.height.toFixed(2)),
        },
        attributes: {
          id: html.id || null,
          className: html.className ? String(html.className).slice(0, 160) : null,
          role: el.getAttribute('role'),
          hidden: el.hasAttribute('hidden'),
          ariaExpanded: el.getAttribute('aria-expanded'),
          ariaHidden: el.getAttribute('aria-hidden'),
          ariaSelected: el.getAttribute('aria-selected'),
          ariaChecked: el.getAttribute('aria-checked'),
          checked: typeof input.checked === 'boolean' ? input.checked : null,
        },
        computed: {
          display: style.display,
          visibility: style.visibility,
          opacity: style.opacity,
          position: style.position,
          overflow: style.overflow,
          fontSize: style.fontSize,
          color: style.color,
          backgroundColor: style.backgroundColor,
          width: style.width,
          maxWidth: style.maxWidth,
        },
      };
    }, selector);
  } catch (err) {
    return {
      selector,
      found: false,
      error: err instanceof Error ? err.message : String(err),
    };
  }
}
