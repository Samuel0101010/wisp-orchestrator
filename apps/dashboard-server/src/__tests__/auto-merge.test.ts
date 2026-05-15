import { describe, expect, it, beforeEach, afterEach } from 'vitest';
import { execa } from 'execa';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { autoMergeResultIntoMain } from '../orchestrator/auto-merge.js';

let repoPath: string;

async function git(...args: string[]): Promise<string> {
  const { stdout } = await execa('git', args, { cwd: repoPath });
  return stdout.trim();
}

async function commit(file: string, content: string, message: string): Promise<string> {
  await writeFile(join(repoPath, file), content);
  await execa('git', ['add', file], { cwd: repoPath });
  await execa(
    'git',
    [
      '-c',
      'user.email=t@t',
      '-c',
      'user.name=t',
      '-c',
      'commit.gpgsign=false',
      'commit',
      '-m',
      message,
    ],
    { cwd: repoPath },
  );
  return git('rev-parse', 'HEAD');
}

beforeEach(async () => {
  repoPath = await mkdtemp(join(tmpdir(), 'harness-automerge-test-'));
  await execa('git', ['init', '-b', 'main'], { cwd: repoPath });
});

afterEach(async () => {
  await rm(repoPath, { recursive: true, force: true });
});

describe('autoMergeResultIntoMain', () => {
  it('fast-forwards main when result is a descendant', async () => {
    const initial = await commit('a.txt', 'hello', 'initial');
    await execa('git', ['branch', 'result'], { cwd: repoPath });
    await execa('git', ['checkout', 'result'], { cwd: repoPath });
    const tip = await commit('b.txt', 'world', 'on-result');
    await execa('git', ['checkout', 'main'], { cwd: repoPath });

    const res = await autoMergeResultIntoMain({ repoPath, resultBranch: 'result' });
    expect(res.ok).toBe(true);
    if (res.ok) {
      expect(res.mode).toBe('fast-forward');
      expect(res.mainSha).toBe(tip);
    }
    expect(await git('rev-parse', 'main')).toBe(tip);
    expect(initial).not.toBe(tip);
  });

  it('reports noop when main and result already point at the same commit', async () => {
    const initial = await commit('a.txt', 'hello', 'initial');
    await execa('git', ['branch', 'result'], { cwd: repoPath });

    const res = await autoMergeResultIntoMain({ repoPath, resultBranch: 'result' });
    expect(res.ok).toBe(true);
    if (res.ok) expect(res.mode).toBe('noop');
    expect(await git('rev-parse', 'main')).toBe(initial);
  });

  it('produces a merge commit when main has diverged from result', async () => {
    await commit('a.txt', 'hello', 'initial');
    await execa('git', ['branch', 'result'], { cwd: repoPath });
    // result tip
    await execa('git', ['checkout', 'result'], { cwd: repoPath });
    await commit('b.txt', 'r', 'on-result');
    // diverge main
    await execa('git', ['checkout', 'main'], { cwd: repoPath });
    await commit('c.txt', 'm', 'on-main');

    const res = await autoMergeResultIntoMain({ repoPath, resultBranch: 'result' });
    expect(res.ok).toBe(true);
    if (res.ok) expect(res.mode).toBe('merge-commit');

    // both branch commits are reachable from new main
    const log = await git('log', '--oneline', 'main');
    expect(log).toMatch(/on-result/);
    expect(log).toMatch(/on-main/);
  });

  it('reports merge conflict and leaves main untouched when branches modify the same line', async () => {
    await commit('a.txt', 'line1\nline2\n', 'initial');
    await execa('git', ['branch', 'result'], { cwd: repoPath });
    await execa('git', ['checkout', 'result'], { cwd: repoPath });
    await commit('a.txt', 'line1\nRESULT\n', 'on-result');
    await execa('git', ['checkout', 'main'], { cwd: repoPath });
    const mainBefore = await commit('a.txt', 'line1\nMAIN\n', 'on-main');

    const res = await autoMergeResultIntoMain({ repoPath, resultBranch: 'result' });
    expect(res.ok).toBe(false);
    if (!res.ok) {
      expect(res.reason).toMatch(/conflict/i);
    }
    expect(await git('rev-parse', 'main')).toBe(mainBefore);
  });

  it('returns failure when result branch does not exist', async () => {
    await commit('a.txt', 'x', 'initial');
    const res = await autoMergeResultIntoMain({ repoPath, resultBranch: 'no-such-branch' });
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.reason).toMatch(/not found/);
  });
});
