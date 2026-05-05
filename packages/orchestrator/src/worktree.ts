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
  await execa('git', ['worktree', 'add', '-b', opts.branchName, wtPath, base], {
    cwd: opts.repoPath,
  });
  return wtPath;
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
 * with `git merge --no-ff`. On the first conflict, aborts the failing merge
 * and returns `{ ok: false, conflict }` — does NOT continue with remaining
 * branches. On success of all merges, returns `{ ok: true }`.
 *
 * Uses harness identity overrides so the merge commits look like other
 * automated commits and never trip the user's signing hooks.
 */
export async function mergeBranchesInWorktree(
  worktreePath: string,
  branches: string[],
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
      // Always abort to leave the working tree in a clean state.
      await execa('git', ['merge', '--abort'], { cwd: worktreePath, reject: false });
      return { ok: false, conflict };
    }
  }
  return { ok: true };
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
