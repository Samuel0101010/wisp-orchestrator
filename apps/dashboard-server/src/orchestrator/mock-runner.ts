/**
 * Mock-CLI mode for the dashboard-server (F1 — end-to-end smoke test).
 *
 * When `WISP_MOCK_CLI=1`, the server swaps the real `claude` subprocess for
 * the existing fixture at `packages/orchestrator/tests/fixtures/mock-claude.mjs`.
 * The fixture supports per-call modes ("plan" for planner calls, "task" for
 * role-task calls); we pick one based on the `taskId` prefix.
 *
 * Convention: planner calls use `taskId = 'planner-<uuid>'` (set by the planner
 * route). Walker-dispatched task calls use the task node id (e.g. "architect"),
 * which never starts with "planner-".
 */

import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { runClaude, type RunClaudeOpts, type SubprocessRunner } from '@wisp/orchestrator';

const PLANNER_TASK_PREFIX = 'planner-';

/**
 * Resolve the absolute path to the mock-claude.mjs fixture.
 *
 * Layout:
 *   <repo>/apps/dashboard-server/{src,dist}/orchestrator/mock-runner.{ts,js}
 *   <repo>/packages/orchestrator/tests/fixtures/mock-claude.mjs
 *
 * The relative offset is the same in src and dist.
 */
export function resolveMockBinPath(): string {
  const here = path.dirname(fileURLToPath(import.meta.url));
  return path.resolve(
    here,
    '..',
    '..',
    '..',
    '..',
    'packages',
    'orchestrator',
    'tests',
    'fixtures',
    'mock-claude.mjs',
  );
}

/** Build a runner that injects __mockBin/__mockEnv on every call. */
export function makeMockRunner(): SubprocessRunner {
  const bin = resolveMockBinPath();
  return (opts: RunClaudeOpts) =>
    runClaude({
      ...opts,
      __mockBin: bin,
      __mockEnv: {
        MOCK_MODE: opts.taskId.startsWith(PLANNER_TASK_PREFIX) ? 'plan' : 'task',
      },
    });
}

export const PLANNER_TASK_ID_PREFIX = PLANNER_TASK_PREFIX;
