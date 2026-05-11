import { describe, expect, it } from 'vitest';
import {
  checkBodyHasContent,
  checkConsoleClean,
  checkHttpStatus,
  checkPageReady,
} from './checks.js';

describe('preflight checks', () => {
  describe('checkHttpStatus', () => {
    it('passes 2xx and 3xx', () => {
      expect(checkHttpStatus(200).ok).toBe(true);
      expect(checkHttpStatus(204).ok).toBe(true);
      expect(checkHttpStatus(307).ok).toBe(true);
    });
    it('fails 4xx and 5xx with detail', () => {
      expect(checkHttpStatus(404)).toEqual({ ok: false, name: 'http_status', detail: 'HTTP 404' });
      expect(checkHttpStatus(500).ok).toBe(false);
    });
    it('reports DNS failure distinctly', () => {
      expect(checkHttpStatus(0, 'dns')).toEqual({
        ok: false,
        name: 'http_status',
        detail: 'DNS resolution failed',
      });
    });
    it('reports connection failure distinctly', () => {
      expect(checkHttpStatus(0, 'connection').detail).toContain('connection');
    });
    it('fails on status=0 with no error kind', () => {
      expect(checkHttpStatus(0).ok).toBe(false);
    });
  });

  describe('checkPageReady', () => {
    it('passes when load finished', () => {
      expect(checkPageReady(true, 15).ok).toBe(true);
    });
    it('fails with timeout detail when not finished', () => {
      expect(checkPageReady(false, 15)).toEqual({
        ok: false,
        name: 'page_ready',
        detail: 'page did not reach networkidle within 15s',
      });
    });
  });

  describe('checkConsoleClean', () => {
    it('passes on empty input', () => {
      expect(checkConsoleClean([])).toEqual({ ok: true, name: 'console_clean' });
    });
    it('passes on warnings only', () => {
      expect(checkConsoleClean([{ level: 'warning', text: 'whatever' }]).ok).toBe(true);
    });
    it('passes on non-fatal errors (CORS, etc)', () => {
      expect(
        checkConsoleClean([
          { level: 'error', text: 'CORS warning: ignored cross-origin' },
        ]).ok,
      ).toBe(true);
    });
    it('fails on Uncaught TypeError', () => {
      const r = checkConsoleClean([{ level: 'error', text: 'Uncaught TypeError: x is null' }]);
      expect(r.ok).toBe(false);
      expect(r.detail).toContain('Uncaught TypeError');
    });
    it('fails on Minified React error', () => {
      expect(
        checkConsoleClean([{ level: 'error', text: 'Minified React error #418' }]).ok,
      ).toBe(false);
    });
    it('treats pageerror level as fatal source', () => {
      expect(
        checkConsoleClean([{ level: 'pageerror', text: 'Uncaught ReferenceError: foo' }]).ok,
      ).toBe(false);
    });
  });

  describe('checkBodyHasContent', () => {
    it('passes on real content (TodoMVC post-hydration)', () => {
      expect(checkBodyHasContent({ textChars: 616, interactiveCount: 12 }).ok).toBe(true);
    });
    it('passes on minimal text (example.com)', () => {
      expect(checkBodyHasContent({ textChars: 129, interactiveCount: 1 }).ok).toBe(true);
    });
    it('passes on many interactives but little text', () => {
      expect(checkBodyHasContent({ textChars: 10, interactiveCount: 6 }).ok).toBe(true);
    });
    it('fails on blank body', () => {
      const r = checkBodyHasContent({ textChars: 0, interactiveCount: 0 });
      expect(r.ok).toBe(false);
      expect(r.detail).toContain('0 chars');
    });
    it('fails just below thresholds', () => {
      expect(checkBodyHasContent({ textChars: 29, interactiveCount: 4 }).ok).toBe(false);
    });
  });
});
