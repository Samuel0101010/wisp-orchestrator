import { describe, expect, it } from 'vitest';
import { execSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

describe('INVENTORY.json regeneration', () => {
  it('script runs without error and writes valid JSON with required fields', () => {
    const repoRoot = resolve(__dirname, '../../../..');
    execSync('node scripts/inventory.mjs', { cwd: repoRoot, stdio: 'pipe' });
    const inv = JSON.parse(readFileSync(resolve(repoRoot, 'docs/INVENTORY.json'), 'utf8'));
    expect(inv).toHaveProperty('generatedAt');
    expect(Array.isArray(inv.routes)).toBe(true);
    expect(inv.routes.length).toBeGreaterThan(5);
    expect(Array.isArray(inv.directives)).toBe(true);
    expect(inv.directives).toContain('consult');
  });
});
