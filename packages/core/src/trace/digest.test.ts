import { describe, expect, it } from 'vitest';
import { domDigest } from './digest.js';

describe('domDigest', () => {
  it('returns a stable sha256-prefixed string', () => {
    const html = '<html><body><h1>Hello</h1></body></html>';
    const d = domDigest(html);
    expect(d).toMatch(/^sha256:[0-9a-f]{64}$/);
    expect(domDigest(html)).toBe(d);
  });

  it('ignores whitespace differences', () => {
    const a = '<div><span>x</span></div>';
    const b = '<div>  <span>x</span>  </div>';
    expect(domDigest(a)).toBe(domDigest(b));
  });

  it('strips ISO timestamps so digests match across minutes', () => {
    const a = '<p>last updated 2026-05-09T22:13:44Z</p>';
    const b = '<p>last updated 2026-05-09T22:14:01Z</p>';
    expect(domDigest(a)).toBe(domDigest(b));
  });

  it('strips data-nonce-like attributes', () => {
    const a = '<form data-nonce="abc123"><input/></form>';
    const b = '<form data-nonce="xyz999"><input/></form>';
    expect(domDigest(a)).toBe(domDigest(b));
  });

  it('different content produces different digests', () => {
    expect(domDigest('<p>a</p>')).not.toBe(domDigest('<p>b</p>'));
  });
});
