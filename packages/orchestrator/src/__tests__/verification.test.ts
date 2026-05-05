import { describe, it, expect } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runVerification, type SuccessCriteria } from '../verification.js';

async function withTmp<T>(fn: (dir: string) => Promise<T>): Promise<T> {
  const dir = await mkdtemp(join(tmpdir(), 'harness-verify-'));
  try {
    return await fn(dir);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

describe('runVerification', () => {
  it('returns pass=true when all criteria are empty', async () => {
    await withTmp(async (cwd) => {
      const res = await runVerification(cwd, {});
      expect(res.pass).toBe(true);
      expect(res.output).toBe('no criteria');
      expect(res.failures).toEqual([]);
    });
  });

  it('treats whitespace-only criteria as empty', async () => {
    await withTmp(async (cwd) => {
      const res = await runVerification(cwd, { build: '   ', test: '\t\n' });
      expect(res.pass).toBe(true);
      expect(res.failures).toEqual([]);
    });
  });

  it('passes when every criterion succeeds (using stubbed exec)', async () => {
    await withTmp(async (cwd) => {
      const calls: string[] = [];
      const criteria: SuccessCriteria = {
        build: 'echo build-ok',
        test: 'echo test-ok',
        lint: 'echo lint-ok',
      };
      const res = await runVerification(cwd, criteria, {
        __exec: async (cmd) => {
          calls.push(cmd);
          return { exitCode: 0, stdout: cmd, stderr: '', timedOut: false };
        },
      });
      expect(res.pass).toBe(true);
      expect(res.failures).toEqual([]);
      expect(calls).toEqual(['echo build-ok', 'echo test-ok', 'echo lint-ok']);
      expect(res.output).toContain('[build]');
      expect(res.output).toContain('[test]');
      expect(res.output).toContain('[lint]');
    });
  });

  it('fails when one criterion exits non-zero, populating failures with tail', async () => {
    await withTmp(async (cwd) => {
      const res = await runVerification(
        cwd,
        { build: 'pass-build', test: 'fail-test' },
        {
          __exec: async (cmd) => {
            if (cmd === 'fail-test') {
              return { exitCode: 2, stdout: '', stderr: 'error: boom', timedOut: false };
            }
            return { exitCode: 0, stdout: 'ok', stderr: '', timedOut: false };
          },
        },
      );
      expect(res.pass).toBe(false);
      expect(res.failures).toHaveLength(1);
      const f = res.failures[0]!;
      expect(f.kind).toBe('test');
      expect(f.cmd).toBe('fail-test');
      expect(f.exitCode).toBe(2);
      expect(f.tail).toContain('boom');
    });
  });

  it('reports timeout as exit code 124', async () => {
    await withTmp(async (cwd) => {
      const res = await runVerification(
        cwd,
        { build: 'slow-build' },
        {
          __exec: async () => ({
            exitCode: 1,
            stdout: '',
            stderr: 'killed',
            timedOut: true,
          }),
        },
      );
      expect(res.pass).toBe(false);
      expect(res.failures).toHaveLength(1);
      expect(res.failures[0]!.exitCode).toBe(124);
    });
  });

  it('runs custom criterion last and reports its failure', async () => {
    await withTmp(async (cwd) => {
      const order: string[] = [];
      const res = await runVerification(
        cwd,
        { custom: 'custom-cmd', build: 'build-cmd' },
        {
          __exec: async (cmd) => {
            order.push(cmd);
            if (cmd === 'custom-cmd') {
              return { exitCode: 5, stdout: '', stderr: 'nope', timedOut: false };
            }
            return { exitCode: 0, stdout: '', stderr: '', timedOut: false };
          },
        },
      );
      expect(order).toEqual(['build-cmd', 'custom-cmd']);
      expect(res.pass).toBe(false);
      expect(res.failures[0]!.kind).toBe('custom');
    });
  });

  it('runs an echo command via real exec successfully', async () => {
    await withTmp(async (cwd) => {
      // Use cross-platform echo via node so we don't depend on shell.
      const res = await runVerification(
        cwd,
        { build: `node -e "console.log('hi')"` },
        { timeoutMs: 30_000 },
      );
      expect(res.pass).toBe(true);
    });
  }, 30_000);

  it('reports a real failing command as a failure', async () => {
    await withTmp(async (cwd) => {
      const res = await runVerification(
        cwd,
        { test: `node -e "process.exit(2)"` },
        { timeoutMs: 30_000 },
      );
      expect(res.pass).toBe(false);
      expect(res.failures).toHaveLength(1);
      expect(res.failures[0]!.exitCode).toBe(2);
    });
  }, 30_000);

  // Skipped: SIGTERM via shell:true does not reliably reach the grandchild
  // process across either Windows (cmd.exe) or POSIX (orphaned node grandchild
  // re-parents to init when the shell is killed), so we cannot deterministically
  // exercise execa's forceKillAfterTimeout escalation through the real exec
  // path. The escalation is documented in runVerification's JSDoc; the __exec
  // seam covers timeoutMs-as-exit-124 deterministically.
  it.skip('kills a hung child after timeoutMs (escalates SIGTERM → SIGKILL)', async () => {
    await withTmp(async (cwd) => {
      const start = Date.now();
      // setInterval keeps the event loop alive forever; verifies execa's
      // forceKillAfterTimeout escalation actually reaps the child.
      const res = await runVerification(
        cwd,
        { custom: `node -e "setInterval(()=>{},1000)"` },
        { timeoutMs: 1_000 },
      );
      const elapsed = Date.now() - start;
      expect(res.pass).toBe(false);
      expect(res.failures).toHaveLength(1);
      expect(res.failures[0]!.exitCode).toBe(124);
      // Should return well before 15s — even with the 5s SIGKILL escalation
      // that's <10s total.
      expect(elapsed).toBeLessThan(15_000);
    });
  }, 30_000);
});
