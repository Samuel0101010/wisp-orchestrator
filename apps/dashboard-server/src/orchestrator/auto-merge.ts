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
  'user.email=wisp@wisp.local',
  '-c',
  'user.name=WISP',
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

export type WorkingTreeSyncCheck = { syncable: true } | { syncable: false; reason: string };
export type SyncWorkingTreeResult = { synced: true } | { synced: false; reason: string };

/**
 * Pre-merge check: is it safe to fast-forward the user's working tree to main
 * AFTER the auto-merge advances it? Safe iff the tree is on `mainBranch` with
 * no uncommitted changes. MUST be called BEFORE auto-merge advances main —
 * afterwards the (not-yet-applied) merge delta makes the tree look "dirty"
 * relative to the new HEAD, which a naive `git status` can't tell apart from
 * genuine local edits.
 */
export async function checkWorkingTreeSyncable(args: {
  repoPath: string;
  mainBranch?: string;
}): Promise<WorkingTreeSyncCheck> {
  const repoPath = args.repoPath;
  const mainBranch = args.mainBranch ?? 'main';

  let branch: string;
  try {
    branch = (
      await execa('git', ['symbolic-ref', '--quiet', '--short', 'HEAD'], { cwd: repoPath })
    ).stdout.trim();
  } catch {
    return { syncable: false, reason: 'detached HEAD' };
  }
  if (branch !== mainBranch) {
    return { syncable: false, reason: `working tree is on '${branch}', not '${mainBranch}'` };
  }

  const status = await execa('git', ['status', '--porcelain'], { cwd: repoPath, reject: false });
  if (status.stdout.trim().length > 0) {
    return { syncable: false, reason: 'working tree has uncommitted changes' };
  }
  return { syncable: true };
}

/**
 * Bring the user's checked-out working tree up to the (just-advanced) main
 * branch so the finished app actually APPEARS in their project folder — the
 * auto-merge advances `refs/heads/main` via update-ref WITHOUT touching the
 * worktree. Only call this after checkWorkingTreeSyncable() returned syncable
 * (pre-merge) so the hard reset can never clobber genuine local edits.
 */
export async function syncWorkingTreeToMain(args: {
  repoPath: string;
  mainBranch?: string;
}): Promise<SyncWorkingTreeResult> {
  const repoPath = args.repoPath;
  const mainBranch = args.mainBranch ?? 'main';
  try {
    await execa('git', ['reset', '--hard', '--quiet', mainBranch], { cwd: repoPath });
    return { synced: true };
  } catch (err) {
    return { synced: false, reason: err instanceof Error ? err.message : String(err) };
  }
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
        'wisp: auto-merge result (ff)',
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
        [...GIT_IDENT, 'merge', '--no-ff', '-m', `wisp: auto-merge ${resultBranch}`, resultBranch],
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
          `wisp: auto-merge ${resultBranch}`,
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
