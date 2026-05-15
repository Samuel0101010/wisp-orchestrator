/**
 * Auto-merge result-branch → main after a successful run.
 *
 * Decoupled from the walker because the walker doesn't know about projects
 * — it deals with runIds and plans. The merge needs the project's repo
 * path (already known to the walker) and a per-project toggle that lives
 * on the project row, so this runs from `runtime.ts` in the post-run
 * hook.
 *
 * Strategy:
 *   1. Best path — `git merge-base --is-ancestor main result`. If true,
 *      main can be fast-forwarded to result without touching any working
 *      tree (we don't want to disturb the user's checkout):
 *        git update-ref refs/heads/main <result-sha>
 *   2. Fall-back path — merge isn't a fast-forward (the user committed
 *      to main while the run was in flight). Open a detached worktree at
 *      main, merge the result branch with --no-ff (so the merge is
 *      preserved as a single named commit), and rely on the auto-resolver
 *      to settle text conflicts. If that still fails, we surface the
 *      error and leave main alone — the user can merge manually.
 *   3. No-op — main and result already point at the same commit (e.g.
 *      a re-run finished before any user activity), nothing to do.
 *
 * Always returns the outcome so the caller can log / surface a banner.
 */

import { execa } from 'execa';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

export type AutoMergeOutcome =
  | { ok: true; mode: 'fast-forward' | 'merge-commit' | 'noop'; mainSha: string }
  | { ok: false; reason: string; conflict?: string };

const GIT_IDENT = [
  '-c',
  'user.email=harness@agent-harness.local',
  '-c',
  'user.name=Agent Harness',
  '-c',
  'commit.gpgsign=false',
];

async function revParse(repoPath: string, ref: string): Promise<string | null> {
  try {
    const { stdout } = await execa('git', ['rev-parse', '--verify', '--quiet', ref], {
      cwd: repoPath,
      reject: false,
    });
    const trimmed = stdout.trim();
    return trimmed.length > 0 ? trimmed : null;
  } catch {
    return null;
  }
}

async function isAncestor(
  repoPath: string,
  ancestor: string,
  descendant: string,
): Promise<boolean> {
  const res = await execa('git', ['merge-base', '--is-ancestor', ancestor, descendant], {
    cwd: repoPath,
    reject: false,
  });
  return res.exitCode === 0;
}

export interface AutoMergeArgs {
  repoPath: string;
  resultBranch: string;
  /** Main branch to merge into. Defaults to 'main'. */
  mainBranch?: string;
}

export async function autoMergeResultIntoMain(args: AutoMergeArgs): Promise<AutoMergeOutcome> {
  const repoPath = args.repoPath;
  const mainBranch = args.mainBranch ?? 'main';
  const resultBranch = args.resultBranch;

  const resultSha = await revParse(repoPath, resultBranch);
  if (!resultSha) {
    return { ok: false, reason: `result branch '${resultBranch}' not found` };
  }
  const mainSha = await revParse(repoPath, mainBranch);
  if (!mainSha) {
    // No main yet — create it pointing at result. First run of a fresh repo.
    await execa('git', ['update-ref', `refs/heads/${mainBranch}`, resultSha], { cwd: repoPath });
    return { ok: true, mode: 'fast-forward', mainSha: resultSha };
  }
  if (mainSha === resultSha) {
    return { ok: true, mode: 'noop', mainSha };
  }

  // Fast-forward path: main is an ancestor of result, so we can advance main
  // in-place with no merge commit needed and without disturbing any worktree.
  if (await isAncestor(repoPath, mainSha, resultSha)) {
    await execa(
      'git',
      [
        'update-ref',
        '-m',
        'harness: auto-merge result (ff)',
        `refs/heads/${mainBranch}`,
        resultSha,
        mainSha,
      ],
      { cwd: repoPath },
    );
    return { ok: true, mode: 'fast-forward', mainSha: resultSha };
  }

  // Non-FF fall-back: open a private worktree at the current main commit in
  // detached state and merge result there. `--detach` is critical — the user's
  // primary checkout almost always has `main` checked out, and a non-detached
  // worktree add for the same branch would fail with
  // "main is already used by worktree at <path>".
  const wtParent = await mkdtemp(join(tmpdir(), 'harness-automerge-'));
  const wtPath = join(wtParent, 'merge');
  let merged: AutoMergeOutcome = { ok: false, reason: 'unreachable' };
  try {
    await execa('git', ['worktree', 'add', '--detach', wtPath, mainSha], { cwd: repoPath });
    try {
      await execa(
        'git',
        [
          ...GIT_IDENT,
          'merge',
          '--no-ff',
          '-m',
          `harness: auto-merge ${resultBranch}`,
          resultBranch,
        ],
        { cwd: wtPath },
      );
      const newSha = (await execa('git', ['rev-parse', 'HEAD'], { cwd: wtPath })).stdout.trim();
      // Atomically advance main to the new merge commit. The compare-and-swap
      // form (with the old SHA) catches concurrent updates by the user.
      await execa(
        'git',
        [
          'update-ref',
          '-m',
          `harness: auto-merge ${resultBranch}`,
          `refs/heads/${mainBranch}`,
          newSha,
          mainSha,
        ],
        { cwd: repoPath },
      );
      merged = { ok: true, mode: 'merge-commit', mainSha: newSha };
    } catch (err) {
      const e = err as { stderr?: string; stdout?: string };
      const conflict = (e.stderr || e.stdout || String(err)).slice(0, 800);
      await execa('git', ['merge', '--abort'], { cwd: wtPath, reject: false });
      merged = { ok: false, reason: 'merge conflict', conflict };
    }
  } finally {
    try {
      await execa('git', ['worktree', 'remove', '--force', wtPath], { cwd: repoPath });
    } catch {
      /* ignore */
    }
    try {
      await rm(wtParent, { recursive: true, force: true });
    } catch {
      /* ignore */
    }
  }
  return merged;
}
