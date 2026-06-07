import './setup.js';
import { describe, expect, it, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { detectProjectType } from '../orchestrator/detect-project-type.js';

function mkRepo(pkgJson: object | null): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'detect-type-'));
  if (pkgJson) {
    fs.writeFileSync(path.join(dir, 'package.json'), JSON.stringify(pkgJson, null, 2));
  }
  return dir;
}

describe('detectProjectType', () => {
  const tmpDirs: string[] = [];
  beforeEach(() => {
    tmpDirs.length = 0;
  });
  afterEach(() => {
    for (const d of tmpDirs) {
      try {
        fs.rmSync(d, { recursive: true, force: true });
      } catch {
        /* best-effort */
      }
    }
  });

  function repo(p: object | null): string {
    const d = mkRepo(p);
    tmpDirs.push(d);
    return d;
  }

  it('classifies a Vite app and recommends pnpm dev + the default vite port', () => {
    const r = repo({
      devDependencies: { vite: '^7.0.0' },
      scripts: { dev: 'vite' },
    });
    const result = detectProjectType(r);
    expect(result.type).toBe('web-app');
    expect(result.devCommand).toBe('pnpm dev');
    expect(result.probeUrl).toBe('http://127.0.0.1:5173/');
    expect(result.framework).toBe('vite');
  });

  it('exposes the SvelteKit framework key for the preview --base whitelist', () => {
    const r = repo({
      devDependencies: { '@sveltejs/kit': '^2' },
      scripts: { dev: 'vite dev' },
    });
    const result = detectProjectType(r);
    expect(result.type).toBe('web-app');
    expect(result.framework).toBe('@sveltejs/kit');
  });

  it('classifies a Next.js app on port 3000', () => {
    const r = repo({ dependencies: { next: '^14' }, scripts: { dev: 'next dev' } });
    const result = detectProjectType(r);
    expect(result.type).toBe('web-app');
    expect(result.probeUrl).toBe('http://127.0.0.1:3000/');
  });

  it('classifies a Fastify backend with pnpm start', () => {
    const r = repo({
      dependencies: { fastify: '^4' },
      scripts: { start: 'node dist/index.js' },
    });
    const result = detectProjectType(r);
    expect(result.type).toBe('backend');
    expect(result.devCommand).toBe('pnpm start');
  });

  it('classifies a package with `bin` as a CLI', () => {
    const r = repo({ bin: { tool: './bin/tool.mjs' } });
    expect(detectProjectType(r).type).toBe('cli');
  });

  it('classifies a plain main-only package as library', () => {
    const r = repo({ main: 'dist/index.js' });
    expect(detectProjectType(r).type).toBe('library');
  });

  it('returns unknown when package.json is missing', () => {
    const r = repo(null);
    expect(detectProjectType(r).type).toBe('unknown');
  });

  it('returns unknown when package.json has no runnable signals', () => {
    const r = repo({ name: 'mystery' });
    expect(detectProjectType(r).type).toBe('unknown');
  });

  it('prefers `dev` over `start` when both exist for a web app', () => {
    const r = repo({
      devDependencies: { vite: '^7' },
      scripts: { dev: 'vite', start: 'serve dist' },
    });
    expect(detectProjectType(r).devCommand).toBe('pnpm dev');
  });

  it('classifies an Expo app as a web-previewable surface via `pnpm web`', () => {
    const r = repo({
      dependencies: { expo: '^51', 'react-native': '0.74' },
      scripts: { start: 'expo start', web: 'expo start --web' },
    });
    const result = detectProjectType(r);
    expect(result.type).toBe('web-app');
    expect(result.framework).toBe('expo');
    expect(result.devCommand).toBe('pnpm web');
    expect(result.probeUrl).toBe('http://127.0.0.1:8081/');
  });

  it('falls back to `pnpm exec expo start --web` when there is no web script', () => {
    const r = repo({ dependencies: { expo: '^51' }, scripts: { start: 'expo start' } });
    expect(detectProjectType(r).devCommand).toBe('pnpm exec expo start --web');
  });

  it('previews a Tauri desktop app via its web dev server, never `tauri dev`', () => {
    // `dev` launches the native window — must NOT be picked for the preview.
    const r = repo({
      devDependencies: { vite: '^7', '@tauri-apps/cli': '^2' },
      dependencies: { '@tauri-apps/api': '^2' },
      scripts: { dev: 'tauri dev', 'dev:web': 'vite' },
    });
    const result = detectProjectType(r);
    expect(result.type).toBe('web-app');
    // framework stays 'vite' so the preview router still applies --base.
    expect(result.framework).toBe('vite');
    expect(result.devCommand).toBe('pnpm dev:web');
    expect(result.reason).toMatch(/Tauri/i);
  });

  it('runs vite directly for a Tauri app whose only `dev` script is `tauri dev`', () => {
    const r = repo({
      devDependencies: { vite: '^7', '@tauri-apps/cli': '^2' },
      scripts: { dev: 'tauri dev' },
    });
    expect(detectProjectType(r).devCommand).toBe('pnpm exec vite');
  });

  it('uses the plain `dev` script for a Tauri app when it does not launch tauri', () => {
    const r = repo({
      devDependencies: { vite: '^7', '@tauri-apps/cli': '^2' },
      scripts: { dev: 'vite' },
    });
    expect(detectProjectType(r).devCommand).toBe('pnpm dev');
  });
});
