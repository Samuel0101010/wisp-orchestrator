import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

/**
 * Side-effect module: configures test env vars (data dir, log level) BEFORE
 * any other module loads `src/env.ts` or `src/db/index.ts`.
 *
 * Test files MUST `import './setup.js';` (or relative equivalent) at the very
 * top — before importing anything from `../app.js`, `../db/...`, etc.
 *
 * Rationale: ES module side effects run in import order; this module touches
 * only node built-ins and contains no further imports of project code, so its
 * effects land before sibling imports.
 */

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-harness-test-'));
process.env.HARNESS_DATA_DIR = dir;
process.env.HARNESS_LOG_LEVEL = 'silent';
process.env.NODE_ENV = 'test';

export const TEST_DATA_DIR = dir;
