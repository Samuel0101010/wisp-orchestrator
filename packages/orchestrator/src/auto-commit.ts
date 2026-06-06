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

/**
 * Shared `-c key=value` pairs for every git invocation in here.
 *
 * `core.longpaths=true` is the Windows-only escape hatch: pnpm produces
 * `node_modules/.pnpm/...` paths well past MAX_PATH (260 chars), and without
 * this flag `git add -A` aborts with `could not open directory ...` when it
 * tries to walk into them. Setting it on every call (not in the global config)
 * keeps the fix opt-in to WISP's own runs.
 */
const GIT_OVERRIDES = [
  '-c',
  'user.email=wisp@wisp.local',
  '-c',
  'user.name=WISP',
  '-c',
  'commit.gpgsign=false',
  '-c',
  'tag.gpgsign=false',
  '-c',
  'core.longpaths=true',
];

// Pathspecs that stage everything except installed dependencies. A task that
// runs `pnpm install` inside its worktree would otherwise have its entire
// `node_modules` tree swept up by `git add -A` and committed into the result
// branch the user inspects — a freshly scaffolded project has no .gitignore to
// stop it. Excluding via pathspec touches no files; core.longpaths (above)
// still lets the walk succeed on Windows when node_modules is present.
// `:(exclude,glob)**/node_modules/**` is what actually reaches nested workspace
// node_modules — a plain `:(exclude)**/node_modules` only matches the top level.
const ADD_PATHSPEC = ['.', ':(exclude)node_modules', ':(exclude,glob)**/node_modules/**'];

export async function commitWorktreeChanges(worktreePath: string, taskId: string): Promise<string> {
  await execa('git', [...GIT_OVERRIDES, 'add', '-A', '--', ...ADD_PATHSPEC], { cwd: worktreePath });
  await execa('git', [...GIT_OVERRIDES, 'commit', '--allow-empty', '-m', `wisp: ${taskId}`], {
    cwd: worktreePath,
  });
  const { stdout } = await execa('git', [...GIT_OVERRIDES, 'rev-parse', 'HEAD'], {
    cwd: worktreePath,
  });
  return stdout.trim();
}
