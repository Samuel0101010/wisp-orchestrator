/**
 * Zero-dependency static file server for the preview pane.
 *
 * Chat-created "no build tool" projects produce a bare `index.html` at the
 * repo root — no framework dep, no dev script — so `detectProjectType`
 * (deliberately conservative) returns 'unknown' and the preview pane had
 * nothing to spawn. This script is the fallback: the preview route spawns it
 * via the argv seam (`node <this file> <rootDir> --port <port>`) against the
 * preview worktree.
 *
 * Standalone by design: no imports from the rest of the server, so it can be
 * executed as a bare child process from dist/.
 */
import { createServer, type Server } from 'node:http';
import { createReadStream, existsSync, statSync } from 'node:fs';
import { extname, join, resolve, sep } from 'node:path';
import { pathToFileURL } from 'node:url';

const MIME: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.htm': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
  '.ico': 'image/x-icon',
  '.txt': 'text/plain; charset=utf-8',
  '.map': 'application/json',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2',
};

export function createStaticPreviewServer(rootDir: string, basePath?: string): Server {
  const root = resolve(rootDir);
  // The dashboard's reverse-proxy forwards the FULL request path including
  // its /preview/<projectId>/ prefix (same contract as vite's --base) — strip
  // it here so lookups hit the file tree.
  const base = basePath && basePath !== '/' ? basePath.replace(/\/$/, '') : null;
  return createServer((req, res) => {
    try {
      const url = new URL(req.url ?? '/', 'http://localhost');
      let pathname = decodeURIComponent(url.pathname);
      if (base && pathname.startsWith(base)) {
        pathname = pathname.slice(base.length) || '/';
      }
      if (pathname.endsWith('/')) pathname += 'index.html';
      const filePath = resolve(join(root, pathname));
      // Traversal guard: the resolved path must stay inside the root.
      if (filePath !== root && !filePath.startsWith(root + sep)) {
        res.writeHead(403, { 'content-type': 'text/plain' });
        res.end('forbidden');
        return;
      }
      let target = filePath;
      if (existsSync(target) && statSync(target).isDirectory()) {
        target = join(target, 'index.html');
      }
      if (!existsSync(target) || !statSync(target).isFile()) {
        res.writeHead(404, { 'content-type': 'text/plain' });
        res.end('not found');
        return;
      }
      res.writeHead(200, {
        'content-type': MIME[extname(target).toLowerCase()] ?? 'application/octet-stream',
        'cache-control': 'no-store',
      });
      createReadStream(target).pipe(res);
    } catch {
      res.writeHead(500, { 'content-type': 'text/plain' });
      res.end('internal error');
    }
  });
}

// Executed directly (not imported): parse `<rootDir> --port <port>` and listen.
const isMain = (() => {
  try {
    return process.argv[1] ? pathToFileURL(process.argv[1]).href === import.meta.url : false;
  } catch {
    return false;
  }
})();

if (isMain) {
  const argv = process.argv.slice(2);
  let rootDir = process.cwd();
  let port = 5500;
  let basePath: string | undefined;
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--port') {
      port = Number(argv[i + 1] ?? port);
      i++;
    } else if (argv[i] === '--base') {
      basePath = argv[i + 1];
      i++;
    } else if (argv[i]) {
      rootDir = argv[i]!;
    }
  }
  const server = createStaticPreviewServer(rootDir, basePath);
  server.listen(port, '127.0.0.1', () => {
    console.log(`[static-preview] serving ${resolve(rootDir)} on http://127.0.0.1:${port}/`);
  });
}
