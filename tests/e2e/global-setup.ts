/**
 * Playwright globalSetup — verifies the dashboard build is present.
 *
 * The actual tmp `WISP_DATA_DIR` and tmp git repo are created in
 * `playwright.config.ts` (synchronous, at config-load time) so they are
 * available before the `webServer` block spawns the dashboard-server. This
 * file only does post-load asserts that don't affect server startup env.
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(here, '..', '..');

export default async function globalSetup(): Promise<void> {
  const serverEntry = path.join(repoRoot, 'apps', 'dashboard-server', 'dist', 'server.js');
  const webIndex = path.join(repoRoot, 'apps', 'dashboard-web', 'dist', 'index.html');
  const missing: string[] = [];
  if (!fs.existsSync(serverEntry)) missing.push(serverEntry);
  if (!fs.existsSync(webIndex)) missing.push(webIndex);
  if (missing.length > 0) {
    throw new Error(
      [
        'E2E prerequisites missing:',
        ...missing.map((m) => `  - ${m}`),
        '',
        'Run `pnpm build` from the repo root before invoking the e2e suite.',
      ].join('\n'),
    );
  }
  console.log(`[e2e] WISP_DATA_DIR=${process.env.WISP_E2E_DATA_DIR ?? '(unset)'}`);
  console.log(`[e2e] repoPath=${process.env.WISP_E2E_REPO_PATH ?? '(unset)'}`);
}
