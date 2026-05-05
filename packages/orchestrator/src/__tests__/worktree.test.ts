import { describe, it, expect, beforeAll } from 'vitest';
import { execa } from 'execa';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { addWorktree, computeWorktreePath, listWorktrees, removeWorktree, mergeBranchesInWorktree } from '../worktree.js';

let gitAvailable = false;

beforeAll(async () => {
  try {
    await execa('git', ['--version']);
    gitAvailable = true;
  } catch {
    gitAvailable = false;
  }
});

describe('worktree manager', () => {
  it('computes a worktree path next to the repo (not inside it)', () => {
    const wt = computeWorktreePath('/some/repo', 'feature/foo bar');
    expect(wt).toContain('.harness-worktrees');
    expect(wt).not.toContain('/some/repo/.harness-worktrees');
    expect(wt.endsWith('feature-foo-bar')).toBe(true);
  });

  it('add → list → remove lifecycle on a tmp repo', async () => {
    if (!gitAvailable) {
      // Skip cleanly when git is missing.
      return;
    }
    const root = await mkdtemp(join(tmpdir(), 'harness-wt-'));
    const repo = join(root, 'repo');
    try {
      await execa('git', ['init', '-b', 'main', repo]);
      // Configure user so commits work in CI-like environments.
      await execa('git', ['-C', repo, 'config', 'user.email', 'test@example.com']);
      await execa('git', ['-C', repo, 'config', 'user.name', 'Test']);
      await writeFile(join(repo, 'README.md'), '# test\n');
      await execa('git', ['-C', repo, 'add', '.']);
      await execa('git', ['-C', repo, 'commit', '-m', 'init']);

      const wtPath = await addWorktree({
        repoPath: repo,
        branchName: 'feature/x',
      });
      expect(existsSync(wtPath)).toBe(true);

      const list = await listWorktrees({ repoPath: repo });
      expect(list.length).toBeGreaterThanOrEqual(2); // main repo + new worktree
      const found = list.find((e) => e.path.replace(/\\/g, '/') === wtPath.replace(/\\/g, '/'));
      expect(found).toBeDefined();
      expect(found?.branch).toBe('feature/x');

      await removeWorktree({ repoPath: repo, worktreePath: wtPath, force: true });
      expect(existsSync(wtPath)).toBe(false);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  }, 30_000);
});

describe('mergeBranchesInWorktree', () => {
  it('merges multiple branches with --no-ff (no conflict case)', async () => {
    if (!gitAvailable) return;
    const root = await mkdtemp(join(tmpdir(), 'harness-mb-'));
    const repo = join(root, 'repo');
    try {
      await execa('git', ['init', '-b', 'main', repo]);
      await execa('git', ['-C', repo, 'config', 'user.email', 'test@example.com']);
      await execa('git', ['-C', repo, 'config', 'user.name', 'Test']);
      await writeFile(join(repo, 'base.txt'), 'base\n');
      await execa('git', ['-C', repo, 'add', '.']);
      await execa('git', ['-C', repo, 'commit', '-m', 'init']);
      // create branch a with file a.txt
      await execa('git', ['-C', repo, 'checkout', '-b', 'feat/a']);
      await writeFile(join(repo, 'a.txt'), 'A\n');
      await execa('git', ['-C', repo, 'add', '.']);
      await execa('git', ['-C', repo, 'commit', '-m', 'a']);
      // create branch b from main with file b.txt
      await execa('git', ['-C', repo, 'checkout', 'main']);
      await execa('git', ['-C', repo, 'checkout', '-b', 'feat/b']);
      await writeFile(join(repo, 'b.txt'), 'B\n');
      await execa('git', ['-C', repo, 'add', '.']);
      await execa('git', ['-C', repo, 'commit', '-m', 'b']);
      // worktree from feat/a; merge feat/b
      await execa('git', ['-C', repo, 'checkout', 'main']);
      const wtPath = await addWorktree({
        repoPath: repo,
        branchName: 'merge/x',
        baseBranch: 'feat/a',
      });
      const result = await mergeBranchesInWorktree(wtPath, ['feat/b']);
      expect(result).toEqual({ ok: true });
      // both a.txt and b.txt present
      expect(existsSync(join(wtPath, 'a.txt'))).toBe(true);
      expect(existsSync(join(wtPath, 'b.txt'))).toBe(true);
      await removeWorktree({ repoPath: repo, worktreePath: wtPath, force: true });
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  }, 30_000);

  it('returns conflict + aborts merge on overlapping changes', async () => {
    if (!gitAvailable) return;
    const root = await mkdtemp(join(tmpdir(), 'harness-mbc-'));
    const repo = join(root, 'repo');
    try {
      await execa('git', ['init', '-b', 'main', repo]);
      await execa('git', ['-C', repo, 'config', 'user.email', 'test@example.com']);
      await execa('git', ['-C', repo, 'config', 'user.name', 'Test']);
      await writeFile(join(repo, 'shared.txt'), 'base\n');
      await execa('git', ['-C', repo, 'add', '.']);
      await execa('git', ['-C', repo, 'commit', '-m', 'init']);
      await execa('git', ['-C', repo, 'checkout', '-b', 'feat/a']);
      await writeFile(join(repo, 'shared.txt'), 'A\n');
      await execa('git', ['-C', repo, 'add', '.']);
      await execa('git', ['-C', repo, 'commit', '-m', 'a']);
      await execa('git', ['-C', repo, 'checkout', 'main']);
      await execa('git', ['-C', repo, 'checkout', '-b', 'feat/b']);
      await writeFile(join(repo, 'shared.txt'), 'B\n');
      await execa('git', ['-C', repo, 'add', '.']);
      await execa('git', ['-C', repo, 'commit', '-m', 'b']);
      await execa('git', ['-C', repo, 'checkout', 'main']);
      const wtPath = await addWorktree({
        repoPath: repo,
        branchName: 'merge/y',
        baseBranch: 'feat/a',
      });
      const result = await mergeBranchesInWorktree(wtPath, ['feat/b']);
      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.conflict.length).toBeGreaterThan(0);
      // Worktree should be clean post-abort: no .git/MERGE_HEAD
      expect(existsSync(join(wtPath, '.git'))).toBe(true);
      await removeWorktree({ repoPath: repo, worktreePath: wtPath, force: true });
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  }, 30_000);
});
