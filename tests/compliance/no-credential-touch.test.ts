import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { buildEnv, buildAuthProbeEnv } from '@wisp/orchestrator';

function repoRoot(): string {
  return path.resolve(__dirname, '..', '..');
}

/**
 * Functional verification — call the actual env-building functions used by
 * the spawn paths and assert the API key is absent from the result. This
 * replaces a previous literal source-text grep that would silently pass
 * even if the strip was refactored away (e.g. into a destructure that
 * achieves the same effect — or accidentally removed entirely).
 */
describe('compliance: ANTHROPIC_API_KEY is actively stripped on every spawn', () => {
  const ORIGINAL_KEY = process.env.ANTHROPIC_API_KEY;

  beforeEach(() => {
    process.env.ANTHROPIC_API_KEY = 'sk-leak-must-not-survive';
  });

  afterEach(() => {
    if (ORIGINAL_KEY === undefined) delete process.env.ANTHROPIC_API_KEY;
    else process.env.ANTHROPIC_API_KEY = ORIGINAL_KEY;
  });

  it('subprocess.buildEnv strips ANTHROPIC_API_KEY from the spawn env', () => {
    const env = buildEnv({
      cwd: '/tmp/test',
      prompt: 'test',
      systemPrompt: 'test',
      allowedTools: [],
      model: 'haiku',
      taskId: 't1',
      runId: 'r1',
    });
    expect(env.ANTHROPIC_API_KEY).toBeUndefined();
    // Sanity: the function should still preserve OTHER env entries — a bug
    // that returned {} would also pass the strip check above.
    expect(env.CLAUDE_PROJECT_DIR).toBe('/tmp/test');
  });

  it('auth.buildAuthProbeEnv strips ANTHROPIC_API_KEY from the probe env', () => {
    const env = buildAuthProbeEnv();
    expect(env.ANTHROPIC_API_KEY).toBeUndefined();
    // CI flag is set by the function — sanity check the result is non-empty.
    expect(env.CI).toBeDefined();
  });

  it('subprocess.buildEnv strip survives an __mockEnv override that does NOT re-set the key', () => {
    const env = buildEnv({
      cwd: '/tmp/test',
      prompt: 'test',
      systemPrompt: 'test',
      allowedTools: [],
      model: 'haiku',
      taskId: 't1',
      runId: 'r1',
      __mockEnv: { FOO: 'bar' },
    });
    expect(env.ANTHROPIC_API_KEY).toBeUndefined();
    expect(env.FOO).toBe('bar');
  });
});

/**
 * Belt-and-braces source-text canary — fast to run, catches an accidental
 * `delete` removal even before the functional tests above can detect it.
 * Keep both so a regression has to bypass two independent guards.
 */
describe('compliance: source-text canary for the strip', () => {
  it('packages/orchestrator/src/subprocess.ts contains delete env.ANTHROPIC_API_KEY', () => {
    const text = readFileSync(
      path.join(repoRoot(), 'packages/orchestrator/src/subprocess.ts'),
      'utf8',
    );
    expect(text).toContain('delete env.ANTHROPIC_API_KEY');
  });

  it('packages/orchestrator/src/auth.ts contains delete env.ANTHROPIC_API_KEY', () => {
    const text = readFileSync(path.join(repoRoot(), 'packages/orchestrator/src/auth.ts'), 'utf8');
    expect(text).toContain('delete env.ANTHROPIC_API_KEY');
  });
});
