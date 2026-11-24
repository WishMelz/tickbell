import * as fs from 'node:fs';
import * as path from 'node:path';

const MIME_TYPES: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'application/javascript; charset=utf-8',
  '.mjs': 'application/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.webp': 'image/webp',
  '.ico': 'image/x-icon',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2',
  '.ttf': 'font/ttf',
};

const SPA_CSP =
  "default-src 'self'; script-src 'self' 'sha256-TkG2OaaSS0WR+ChgrNaU3Ck9ux/Koj2LSKn79/zHn/Y='; style-src 'self' 'unsafe-inline'; img-src 'self' data: https:; font-src 'self' data:; connect-src 'self'; frame-ancestors 'none'; base-uri 'self'; form-action 'self'";

export function createStaticSpaHandler(staticDir: string) {
  const root = path.resolve(staticDir);
  const indexHtmlPath = path.join(root, 'index.html');

  return (request: Request): Response => {
    if (request.method !== 'GET' && request.method !== 'HEAD') {
      return new Response('Method Not Allowed', { status: 405 });
    }
    if (!fs.existsSync(indexHtmlPath)) {
      return new Response('TickBell frontend assets not found. Run `pnpm run build:web`.', { status: 404 });
    }

    const url = new URL(request.url);
    let relPath = decodeURIComponent(url.pathname).replace(/^\/+/, '');
    if (!relPath) relPath = 'index.html';

    const candidate = path.resolve(root, relPath);
    if (candidate.startsWith(root + path.sep) && fs.existsSync(candidate) && fs.statSync(candidate).isFile()) {
      const ext = path.extname(candidate).toLowerCase();
      const contentType = MIME_TYPES[ext] ?? 'application/octet-stream';
      const isHashedAsset = relPath.startsWith('assets/');
      const body = request.method === 'HEAD' ? null : fs.readFileSync(candidate);
      return new Response(body, {
        status: 200,
        headers: {
          'Content-Type': contentType,
          'Cache-Control': isHashedAsset ? 'public, max-age=31536000, immutable' : 'no-cache',
          ...(ext === '.html' ? { 'Content-Security-Policy': SPA_CSP } : {}),
        },
      });
    }

    // SPA fallback to index.html
    const body = request.method === 'HEAD' ? null : fs.readFileSync(indexHtmlPath);
    return new Response(body, {
      status: 200,
      headers: {
        'Content-Type': 'text/html; charset=utf-8',
        'Cache-Control': 'no-cache',
        'Content-Security-Policy': SPA_CSP,
      },
    });
  };
}
