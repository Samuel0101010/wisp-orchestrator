import { describe, it, expect } from 'vitest';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execa } from 'execa';
import { commitWorktreeChanges } from '../auto-commit.js';

async function withTmpRepo(fn: (repo: string) => Promise<void>): Promise<void> {
  const repo = await mkdtemp(join(tmpdir(), 'harness-ac-'));
  try {
    await execa('git', ['init', '-b', 'main'], { cwd: repo });
    await execa(
      'git',
      [
        '-c',
        'user.email=t@t.t',
        '-c',
        'user.name=t',
        '-c',
        'commit.gpgsign=false',
        'commit',
        '--allow-empty',
        '-m',
        'init',
      ],
      { cwd: repo },
    );
    await fn(repo);
  } finally {
    await rm(repo, { recursive: true, force: true });
  }
}

describe('commitWorktreeChanges', () => {
  it('commits new files under a generic harness identity, no signing', async () => {
    await withTmpRepo(async (repo) => {
      const wt = join(repo, '..', 'wt-' + Date.now());
      await execa('git', ['worktree', 'add', '-b', 'feat/x', wt, 'HEAD'], { cwd: repo });
      await writeFile(join(wt, 'architecture.md'), '# arch\n');
      const sha = await commitWorktreeChanges(wt, 'task-1');
      expect(sha).toMatch(/^[0-9a-f]{40}$/);
      const { stdout } = await execa('git', ['log', '--format=%ae|%an|%s', '-1'], { cwd: wt });
      expect(stdout).toBe('wisp@wisp.local|WISP|wisp: task-1');
      await rm(wt, { recursive: true, force: true });
    });
  });

  it('excludes node_modules from the commit even when not gitignored', async () => {
    await withTmpRepo(async (repo) => {
      const wt = join(repo, '..', 'wt3-' + Date.now());
      await execa('git', ['worktree', 'add', '-b', 'feat/z', wt, 'HEAD'], { cwd: repo });
      // Real project files at root and in a workspace package.
      await writeFile(join(wt, 'index.ts'), 'export const x = 1;\n');
      await mkdir(join(wt, 'packages', 'a'), { recursive: true });
      await writeFile(join(wt, 'packages', 'a', 'src.ts'), 'export const y = 2;\n');
      // A top-level and a nested node_modules that a `pnpm install` would create.
      await mkdir(join(wt, 'node_modules', 'left-pad'), { recursive: true });
      await writeFile(join(wt, 'node_modules', 'left-pad', 'index.js'), 'module.exports = 1;\n');
      await mkdir(join(wt, 'packages', 'a', 'node_modules'), { recursive: true });
      await writeFile(join(wt, 'packages', 'a', 'node_modules', 'dep.js'), '1;\n');

      const sha = await commitWorktreeChanges(wt, 'task-nm');
      expect(sha).toMatch(/^[0-9a-f]{40}$/);

      const { stdout } = await execa('git', ['show', '--name-only', '--format=', 'HEAD'], {
        cwd: wt,
      });
      const files = stdout
        .split('\n')
        .map((s) => s.trim())
        .filter(Boolean);
      expect(files).toContain('index.ts');
      expect(files).toContain('packages/a/src.ts');
      expect(files.some((f) => f.includes('node_modules'))).toBe(false);
      await rm(wt, { recursive: true, force: true });
    });
  });

  it('produces an empty commit when there are no changes', async () => {
    await withTmpRepo(async (repo) => {
      const wt = join(repo, '..', 'wt2-' + Date.now());
      await execa('git', ['worktree', 'add', '-b', 'feat/y', wt, 'HEAD'], { cwd: repo });
      const sha = await commitWorktreeChanges(wt, 'noop-task');
      expect(sha).toMatch(/^[0-9a-f]{40}$/);
      const { stdout } = await execa('git', ['log', '--format=%s', '-1'], { cwd: wt });
      expect(stdout).toBe('wisp: noop-task');
      await rm(wt, { recursive: true, force: true });
    });
  });
});
