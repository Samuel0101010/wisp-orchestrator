import { describe, expect, it } from 'vitest';
import { execSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

describe('INVENTORY.json regeneration', () => {
  it('script runs without error and writes valid JSON with required fields', () => {
    const repoRoot = resolve(__dirname, '../../../..');
    const tmp = mkdtempSync(join(tmpdir(), 'inventory-'));
    const out = join(tmp, 'INVENTORY.json');
    try {
      execSync('node scripts/inventory.mjs', {
        cwd: repoRoot,
        stdio: 'pipe',
        env: { ...process.env, HARNESS_INVENTORY_OUT: out },
      });
      const inv = JSON.parse(readFileSync(out, 'utf8'));
      expect(inv).toHaveProperty('generatedAt');
      expect(Array.isArray(inv.routes)).toBe(true);
      expect(inv.routes.length).toBeGreaterThan(5);
      expect(Array.isArray(inv.directives)).toBe(true);
      expect(inv.directives).toContain('consult');
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });
});
