import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { execSync } from 'node:child_process';
import path from 'node:path';

const FORBIDDEN_PATTERNS: Array<{ pattern: RegExp; name: string }> = [
  { pattern: /api\.anthropic\.com/i, name: 'api.anthropic.com hostname' },
  { pattern: /\banthropic-version\b/i, name: 'anthropic-version header' },
  { pattern: /\bx-api-key\b/i, name: 'x-api-key header' },
  { pattern: /['"]\/\.claude\/credentials\b/, name: 'literal /.claude/credentials path' },
  { pattern: /readFileSync\([^)]*credentials/i, name: 'readFileSync(...credentials' },
];

const SOURCE_GLOBS = [
  'apps/dashboard-server/src',
  'apps/dashboard-web/src',
  'packages/orchestrator/src',
  'packages/schemas/src',
];

function repoRoot(): string {
  // tests/compliance/<file>.test.ts → ../../
  return path.resolve(__dirname, '..', '..');
}

function listSourceFiles(): string[] {
  const root = repoRoot();
  // git ls-files honors .gitignore. Restrict to TS/TSX in src dirs.
  const out = execSync(
    `git -C "${root}" ls-files ${SOURCE_GLOBS.join(' ')}`,
    { encoding: 'utf8' },
  );
  return out
    .split('\n')
    .map((l) => l.trim())
    .filter(Boolean)
    .filter((f) => /\.(ts|tsx)$/.test(f))
    .filter((f) => !/__tests__\//.test(f))
    .filter((f) => !/\.test\.(ts|tsx)$/.test(f))
    .map((f) => path.join(root, f));
}

describe('compliance: no direct Anthropic endpoints or credential access', () => {
  const files = listSourceFiles();

  it('source code files were located via git ls-files', () => {
    expect(files.length).toBeGreaterThan(0);
  });

  for (const { pattern, name } of FORBIDDEN_PATTERNS) {
    it(`no source file matches "${name}"`, () => {
      const offenders: string[] = [];
      for (const f of files) {
        const text = readFileSync(f, 'utf8');
        if (pattern.test(text)) {
          offenders.push(f.replace(repoRoot() + path.sep, ''));
        }
      }
      expect(offenders).toEqual([]);
    });
  }
});
