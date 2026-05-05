import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import path from 'node:path';

function repoRoot(): string {
  return path.resolve(__dirname, '..', '..');
}

describe('compliance: ANTHROPIC_API_KEY is actively stripped on every spawn', () => {
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
