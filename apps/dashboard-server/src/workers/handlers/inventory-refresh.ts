import { execSync } from 'node:child_process';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

export async function inventoryRefresh(): Promise<{ stdout: string }> {
  // Compiled location is dist/workers/handlers — 5 levels up to the monorepo root
  const root = resolve(__dirname, '../../../../..');
  const stdout = execSync('node scripts/inventory.mjs', { cwd: root, encoding: 'utf8' });
  return { stdout };
}
