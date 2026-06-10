import './setup.js';
import { describe, expect, it } from 'vitest';
import type { execa } from 'execa';
import { runHarnessBootCheck } from '../orchestrator/harness-boot-check.js';
import type { ProjectDetection } from '../orchestrator/detect-project-type.js';
import type { runBootSmoke } from '../orchestrator/boot-smoke.js';

const ARGS = {
  repoPath: 'C:/fake/repo',
  projectId: 'proj-1',
  runId: 'run-1',
  resultBranch: 'wisp/run-1/result',
};

/** execa stub that answers the `git rev-parse --verify` + `git show` calls. */
const gitStub = (async () => ({ stdout: 'abc123' })) as unknown as typeof execa;

function webDetection(over: Partial<ProjectDetection> = {}): ProjectDetection {
  return {
    type: 'web-app',
    devCommand: 'pnpm dev',
    probeUrl: 'http://127.0.0.1:5173/',
    reason: 'vite',
    framework: 'vite',
    ...over,
  };
}

describe('runHarnessBootCheck', () => {
  it('returns null (skipped) when detection has no devCommand — boot smoke never runs', async () => {
    let smokeCalls = 0;
    const result = await runHarnessBootCheck(ARGS, {
      execaImpl: gitStub,
      ensureWorktreeImpl: async () => 'C:/fake/worktrees/bootcheck-proj-1',
      detectImpl: () => webDetection({ devCommand: null, probeUrl: null, type: 'library' }),
      bootSmokeImpl: (async () => {
        smokeCalls += 1;
        return {
          ok: true as const,
          readyMs: 1,
          sampledStatus: 200,
          stdoutTail: '',
          stderrTail: '',
        };
      }) as typeof runBootSmoke,
    });
    expect(result).toBeNull();
    expect(smokeCalls).toBe(0);
  });

  it('boots the WORKTREE on a free port with a localhost probe URL and reports ok', async () => {
    const captured: Parameters<typeof runBootSmoke>[0][] = [];
    const result = await runHarnessBootCheck(ARGS, {
      execaImpl: gitStub,
      ensureWorktreeImpl: async (_repo, _proj, opts) => {
        expect(opts?.sha).toBe('abc123');
        expect(opts?.dirName).toBe('bootcheck-proj-1');
        // The persistent worktree must re-run the install step every check so
        // a dependency added by the run is never missing from node_modules.
        expect(opts?.alwaysInstall).toBe(true);
        return 'C:/fake/worktrees/bootcheck-proj-1';
      },
      detectImpl: () => webDetection(),
      // First port occupied → the probe walks to 5174.
      isPortFreeImpl: async (port) => port !== 5173,
      bootSmokeImpl: (async (smokeArgs: Parameters<typeof runBootSmoke>[0]) => {
        captured.push(smokeArgs);
        return {
          ok: true as const,
          readyMs: 1,
          sampledStatus: 200,
          stdoutTail: '',
          stderrTail: '',
        };
      }) as typeof runBootSmoke,
    });
    expect(result).toEqual({ ok: true });
    expect(captured).toHaveLength(1);
    // Result-branch worktree, NOT the repo working tree (FocusBoard bug class).
    expect(captured[0]!.repoPath).toBe('C:/fake/worktrees/bootcheck-proj-1');
    expect(captured[0]!.devCommand).toBe('pnpm dev --port 5174');
    expect(captured[0]!.probeUrl).toBe('http://localhost:5174/');
    expect(captured[0]!.readyTimeoutMs).toBe(90_000);
  });

  it('maps a boot failure to { ok:false, reason: detail }', async () => {
    const result = await runHarnessBootCheck(ARGS, {
      execaImpl: gitStub,
      ensureWorktreeImpl: async () => 'C:/fake/wt',
      detectImpl: () => webDetection(),
      isPortFreeImpl: async () => true,
      bootSmokeImpl: (async () => ({
        ok: false as const,
        reason: 'timeout' as const,
        detail: 'dev server did not answer http://localhost:5173/ within 90000ms',
        stdoutTail: '',
        stderrTail: 'boom',
      })) as typeof runBootSmoke,
    });
    expect(result).toEqual({
      ok: false,
      reason: 'dev server did not answer http://localhost:5173/ within 90000ms',
    });
  });

  it('returns null without worktree or boot smoke when the result sha has no package.json', async () => {
    let worktreeCalls = 0;
    let smokeCalls = 0;
    const execaImpl = (async (_cmd: string, cmdArgs: string[]) => {
      if (cmdArgs[0] === 'rev-parse') return { stdout: 'abc123' };
      if (cmdArgs[0] === 'show') {
        throw new Error("fatal: path 'package.json' does not exist in 'abc123'");
      }
      return { stdout: '' };
    }) as unknown as typeof execa;
    const result = await runHarnessBootCheck(ARGS, {
      execaImpl,
      ensureWorktreeImpl: async () => {
        worktreeCalls += 1;
        return 'C:/fake/wt';
      },
      detectImpl: () => webDetection(),
      bootSmokeImpl: (async () => {
        smokeCalls += 1;
        return {
          ok: true as const,
          readyMs: 1,
          sampledStatus: 200,
          stdoutTail: '',
          stderrTail: '',
        };
      }) as typeof runBootSmoke,
    });
    expect(result).toBeNull();
    // Clean skip: no worktree created, no pnpm install paid, no boot attempt.
    expect(worktreeCalls).toBe(0);
    expect(smokeCalls).toBe(0);
  });

  it('returns null on a harness infra error (worktree creation threw)', async () => {
    const result = await runHarnessBootCheck(ARGS, {
      execaImpl: gitStub,
      ensureWorktreeImpl: async () => {
        throw new Error('pnpm install exploded');
      },
      detectImpl: () => webDetection(),
    });
    expect(result).toBeNull();
  });

  it('returns null when no free port exists in the probe window', async () => {
    let smokeCalls = 0;
    const result = await runHarnessBootCheck(ARGS, {
      execaImpl: gitStub,
      ensureWorktreeImpl: async () => 'C:/fake/wt',
      detectImpl: () => webDetection(),
      isPortFreeImpl: async () => false,
      bootSmokeImpl: (async () => {
        smokeCalls += 1;
        return {
          ok: true as const,
          readyMs: 1,
          sampledStatus: 200,
          stdoutTail: '',
          stderrTail: '',
        };
      }) as typeof runBootSmoke,
    });
    expect(result).toBeNull();
    expect(smokeCalls).toBe(0);
  });
});
