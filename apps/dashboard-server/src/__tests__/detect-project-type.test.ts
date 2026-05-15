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
});
