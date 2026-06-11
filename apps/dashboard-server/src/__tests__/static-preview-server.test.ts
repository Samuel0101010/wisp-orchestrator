import './setup.js';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { AddressInfo } from 'node:net';
import type { Server } from 'node:http';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createStaticPreviewServer } from '../orchestrator/static-preview-server.js';

/**
 * The zero-dep static file server backing the preview fallback for
 * "no build tool" projects (bare index.html at the repo root).
 */
describe('createStaticPreviewServer', () => {
  let root: string;
  let server: Server;
  let base: string;

  beforeAll(async () => {
    root = mkdtempSync(join(tmpdir(), 'static-preview-'));
    writeFileSync(join(root, 'index.html'), '<h1>Hallo Welt</h1>', 'utf8');
    writeFileSync(join(root, 'style.css'), 'body{margin:0}', 'utf8');
    mkdirSync(join(root, 'sub'));
    writeFileSync(join(root, 'sub', 'index.html'), '<p>sub</p>', 'utf8');
    server = createStaticPreviewServer(root);
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  });

  afterAll(async () => {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });

  it('serves / as index.html with the html content type', async () => {
    const res = await fetch(`${base}/`);
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toContain('text/html');
    expect(await res.text()).toContain('Hallo Welt');
  });

  it('serves assets with their mime type', async () => {
    const res = await fetch(`${base}/style.css`);
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toContain('text/css');
  });

  it('serves a directory via its index.html', async () => {
    const res = await fetch(`${base}/sub/`);
    expect(res.status).toBe(200);
    expect(await res.text()).toContain('sub');
  });

  it('404s on missing files', async () => {
    const res = await fetch(`${base}/nope.html`);
    expect(res.status).toBe(404);
  });

  it('refuses path traversal out of the root', async () => {
    const res = await fetch(`${base}/..%2F..%2Fetc%2Fpasswd`);
    expect([403, 404]).toContain(res.status);
    const res2 = await fetch(`${base}/%2e%2e/%2e%2e/secret.txt`);
    expect([403, 404]).toContain(res2.status);
  });

  it('strips the --base prefix like vite does (reverse-proxy contract)', async () => {
    const based = createStaticPreviewServer(root, '/preview/proj-1/');
    await new Promise<void>((resolve) => based.listen(0, '127.0.0.1', resolve));
    const basedUrl = `http://127.0.0.1:${(based.address() as AddressInfo).port}`;
    try {
      const res = await fetch(`${basedUrl}/preview/proj-1/`);
      expect(res.status).toBe(200);
      expect(await res.text()).toContain('Hallo Welt');
      const asset = await fetch(`${basedUrl}/preview/proj-1/style.css`);
      expect(asset.status).toBe(200);
    } finally {
      await new Promise<void>((resolve) => based.close(() => resolve()));
    }
  });
});
