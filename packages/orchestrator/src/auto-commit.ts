/**
 * Headless commit helper for task worktrees.
 *
 * WHY --allow-empty: downstream tasks chain off the branch tip produced by
 * each walker step. Even when a task leaves no file changes we still need a
 * stable, addressable commit so the next task has a consistent base.
 *
 * WHY forced identity + disabled signing: the process runs headless and the
 * user's git config may enforce GPG/SSH commit signing, which would require
 * an interactive key agent. We override both commit.gpgsign and tag.gpgsign
 * and pin the author to a well-known harness identity so every automated
 * commit is clearly distinguishable from human work.
 */

import { execa } from 'execa';

const GIT_OVERRIDES = [
  '-c',
  'user.email=harness@agent-harness.local',
  '-c',
  'user.name=Agent Harness',
  '-c',
  'commit.gpgsign=false',
  '-c',
  'tag.gpgsign=false',
];

export async function commitWorktreeChanges(worktreePath: string, taskId: string): Promise<string> {
  await execa('git', ['add', '-A'], { cwd: worktreePath });
  await execa('git', [...GIT_OVERRIDES, 'commit', '--allow-empty', '-m', `harness: ${taskId}`], {
    cwd: worktreePath,
  });
  const { stdout } = await execa('git', ['rev-parse', 'HEAD'], { cwd: worktreePath });
  return stdout.trim();
}
