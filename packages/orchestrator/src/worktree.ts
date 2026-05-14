/**
 * Git worktree manager.
 *
 * Worktrees live next to the repo (not inside it) so pnpm/git tooling does
 * not get confused by nested checkouts:
 *
 *   <repoPath>/../.harness-worktrees/<sanitizedBranchName>
 */

import { execa } from 'execa';
import { mkdir } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';

export interface AddWorktreeOpts {
  repoPath: string;
  branchName: string;
  baseBranch?: string;
}

export interface RemoveWorktreeOpts {
  repoPath: string;
  worktreePath: string;
  force?: boolean;
}

export interface ListWorktreesOpts {
  repoPath: string;
}

export interface WorktreeEntry {
  path: string;
  branch: string;
}

const SANITIZE_RE = /[^a-zA-Z0-9._-]+/g;

function sanitizeBranchName(name: string): string {
  const cleaned = name.replace(SANITIZE_RE, '-').replace(/^-+|-+$/g, '');
  return cleaned.length > 0 ? cleaned : 'wt';
}

export function computeWorktreePath(repoPath: string, branchName: string): string {
  const absRepo = resolve(repoPath);
  const parent = join(dirname(absRepo), '.harness-worktrees');
  return join(parent, sanitizeBranchName(branchName));
}

export async function addWorktree(opts: AddWorktreeOpts): Promise<string> {
  const wtPath = computeWorktreePath(opts.repoPath, opts.branchName);
  await mkdir(dirname(wtPath), { recursive: true });
  const base = opts.baseBranch ?? 'HEAD';
  try {
    await execa('git', ['worktree', 'add', '-b', opts.branchName, wtPath, base], {
      cwd: opts.repoPath,
    });
    return wtPath;
  } catch (err) {
    // M5/Stage 1 follow-up: the branch + worktree may already exist from a
    // prior aborted attempt (typically: rate-limit interrupted a task before
    // its first auto-commit). Task subprocesses never commit themselves —
    // autoCommit fires from the walker AFTER a successful verify — so the
    // existing branch points at the parent's tip with no work on it. Safe
    // to clobber and retry.
    const message = err instanceof Error ? err.message : String(err);
    const looksLikeBranchConflict =
      /already (exists|used)|missing but already registered|is already checked out/i.test(message);
    if (!looksLikeBranchConflict) throw err;

    // Best-effort cleanup: any of these may legitimately fail (e.g. the
    // worktree dir was already gone, the branch was orphaned). Swallow
    // errors and let the retry surface the real failure if any.
    try {
      await execa('git', ['worktree', 'remove', '--force', wtPath], { cwd: opts.repoPath });
    } catch {
      /* ignore */
    }
    try {
      await execa('git', ['worktree', 'prune'], { cwd: opts.repoPath });
    } catch {
      /* ignore */
    }
    try {
      await execa('git', ['branch', '-D', opts.branchName], { cwd: opts.repoPath });
    } catch {
      /* ignore */
    }

    await execa('git', ['worktree', 'add', '-b', opts.branchName, wtPath, base], {
      cwd: opts.repoPath,
    });
    return wtPath;
  }
}

export async function removeWorktree(opts: RemoveWorktreeOpts): Promise<void> {
  const args = ['worktree', 'remove'];
  if (opts.force) args.push('--force');
  args.push(opts.worktreePath);
  await execa('git', args, { cwd: opts.repoPath });
}

export async function listWorktrees(opts: ListWorktreesOpts): Promise<WorktreeEntry[]> {
  const { stdout } = await execa('git', ['worktree', 'list', '--porcelain'], {
    cwd: opts.repoPath,
  });
  return parseWorktreePorcelain(stdout);
}

const GIT_COMMIT_OVERRIDES = [
  '-c',
  'user.email=harness@agent-harness.local',
  '-c',
  'user.name=Agent Harness',
  '-c',
  'commit.gpgsign=false',
  '-c',
  'tag.gpgsign=false',
];

/**
 * Merge each branch in `branches` into the current branch of `worktreePath`
 * with `git merge --no-ff`. On the first conflict, returns
 * `{ ok: false, conflict }` — does NOT continue with remaining branches. On
 * success of all merges, returns `{ ok: true }`.
 *
 * By default the failing merge is auto-aborted so the worktree is left clean.
 * Callers that want to attempt an in-place conflict resolution can pass
 * `leaveOnConflict: true` to keep the worktree in mid-merge state (with
 * MERGE_HEAD + unmerged paths). Such callers MUST themselves either commit
 * the resolved merge or call {@link abortMergeInWorktree}.
 *
 * Uses harness identity overrides so the merge commits look like other
 * automated commits and never trip the user's signing hooks.
 */
export async function mergeBranchesInWorktree(
  worktreePath: string,
  branches: string[],
  opts: { leaveOnConflict?: boolean } = {},
): Promise<{ ok: true } | { ok: false; conflict: string }> {
  for (const b of branches) {
    try {
      await execa(
        'git',
        [...GIT_COMMIT_OVERRIDES, 'merge', '--no-ff', '-m', `harness: merge ${b}`, b],
        { cwd: worktreePath },
      );
    } catch (err) {
      const e = err as { stderr?: string; stdout?: string };
      const conflict = (e.stderr || e.stdout || String(err)).slice(0, 500);
      if (!opts.leaveOnConflict) {
        await execa('git', ['merge', '--abort'], { cwd: worktreePath, reject: false });
      }
      return { ok: false, conflict };
    }
  }
  return { ok: true };
}

/**
 * Best-effort abort of an in-progress merge in `worktreePath`. Safe to call
 * even if no merge is in progress. Never throws.
 */
export async function abortMergeInWorktree(worktreePath: string): Promise<void> {
  await execa('git', ['merge', '--abort'], { cwd: worktreePath, reject: false });
}

export interface MergeStatus {
  /** True if `MERGE_HEAD` ref exists — i.e. a merge is mid-flight. */
  inMerge: boolean;
  /** Files with diff-filter=U (unresolved conflict markers). */
  unmergedPaths: string[];
  /** Current HEAD commit sha. */
  headCommit: string;
}

/**
 * Read the merge / unmerged state of a worktree. Used by the walker's
 * auto-resolver path to decide whether a resolver subprocess actually
 * finalised the merge or left it dangling.
 */
export async function getMergeStatusInWorktree(worktreePath: string): Promise<MergeStatus> {
  const head = await execa('git', ['rev-parse', 'HEAD'], { cwd: worktreePath });
  const headCommit = head.stdout.trim();

  const mergeHead = await execa('git', ['rev-parse', '--verify', '--quiet', 'MERGE_HEAD'], {
    cwd: worktreePath,
    reject: false,
  });
  const inMerge = mergeHead.exitCode === 0;

  const unmerged = await execa('git', ['diff', '--name-only', '--diff-filter=U'], {
    cwd: worktreePath,
  });
  const unmergedPaths = unmerged.stdout
    .split(/\r?\n/)
    .map((s) => s.trim())
    .filter(Boolean);

  return { inMerge, unmergedPaths, headCommit };
}

function parseWorktreePorcelain(text: string): WorktreeEntry[] {
  const out: WorktreeEntry[] = [];
  const blocks = text.split(/\r?\n\r?\n/);
  for (const block of blocks) {
    const lines = block.split(/\r?\n/);
    let path: string | null = null;
    let branch: string | null = null;
    let detached = false;
    for (const line of lines) {
      if (line.startsWith('worktree ')) {
        path = line.slice('worktree '.length).trim();
      } else if (line.startsWith('branch ')) {
        // value is e.g. "refs/heads/foo"
        const ref = line.slice('branch '.length).trim();
        branch = ref.replace(/^refs\/heads\//, '');
      } else if (line.trim() === 'detached') {
        detached = true;
      }
    }
    if (path) {
      out.push({ path, branch: branch ?? (detached ? '(detached)' : '') });
    }
  }
  return out;
}
