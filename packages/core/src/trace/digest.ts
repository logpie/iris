import { createHash } from 'node:crypto';

const ISO_TS = /\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?Z/g;
const NONCE_ATTR = /\b(data-nonce|nonce|csrf-token|data-cy-id)\s*=\s*"[^"]*"/g;
const RUNTIME_IDS = /\bid\s*=\s*"[a-z]+-[0-9a-f]{6,}"/g;

export function domDigest(html: string): string {
  const normalized = html
    .replace(ISO_TS, '__TS__')
    .replace(NONCE_ATTR, '$1=""')
    .replace(RUNTIME_IDS, 'id=""')
    .replace(/>\s+</g, '><')
    .replace(/\s+/g, ' ')
    .trim()
    .toLowerCase();
  const hash = createHash('sha256').update(normalized).digest('hex');
  return `sha256:${hash}`;
}
