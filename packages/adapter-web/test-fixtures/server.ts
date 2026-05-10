import { existsSync, readFileSync, statSync } from 'node:fs';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { dirname, extname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const SITES_ROOT = join(dirname(fileURLToPath(import.meta.url)), 'sites');

const MIME: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'application/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.png': 'image/png',
  '.svg': 'image/svg+xml',
};

export interface FixtureServerHandle {
  url: string;
  close: () => Promise<void>;
}

export async function startFixtureServer(siteName: string): Promise<FixtureServerHandle> {
  const siteRoot = resolve(SITES_ROOT, siteName);
  if (!existsSync(siteRoot) || !statSync(siteRoot).isDirectory()) {
    throw new Error(`site not found: ${siteName} (looked in ${siteRoot})`);
  }

  const server = createServer((req, res) => {
    const urlPath = (req.url ?? '/').split('?')[0] ?? '/';
    const safePath = urlPath === '/' ? '/index.html' : urlPath;
    const filePath = resolve(siteRoot, `.${safePath}`);
    if (!filePath.startsWith(siteRoot) || !existsSync(filePath) || !statSync(filePath).isFile()) {
      res.statusCode = 404;
      res.end('not found');
      return;
    }
    const ext = extname(filePath).toLowerCase();
    res.statusCode = 200;
    res.setHeader('content-type', MIME[ext] ?? 'application/octet-stream');
    res.end(readFileSync(filePath));
  });

  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  const port = (server.address() as AddressInfo).port;

  return {
    url: `http://127.0.0.1:${port}`,
    close: () =>
      new Promise<void>((resolveClose) => {
        server.close(() => resolveClose());
      }),
  };
}
