/**
 * Shared, idempotent project-repo bootstrap.
 *
 * Extracted from the `POST /api/projects/:id/init-repo` route so that the
 * brief-finalize handler (which writes docs/PRD.md) and the run-start preflight
 * can both guarantee the repo exists before they touch the filesystem. Without
 * this, finalizing a brief on a not-yet-created repoPath silently dropped the
 * PRD with a `repo_path_missing` warning — the folder was only ever created at
 * run-start.
 *
 * Behaviour mirrors the original route exactly:
 *   - dir missing + !createDir            → { ok:false, error:'repo_path_missing' }
 *   - dir missing + createDir, mkdir fails→ { ok:false, error:'mkdir_failed' }
 *   - already a git repo                  → { ok:true, alreadyInitialized:true }
 *   - fresh init (git init + first commit)→ { ok:true, alreadyInitialized:false, head }
 *   - git init/commit throws              → { ok:false, error:'git_init_failed' }
 */
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

export type EnsureRepoResult =
  | { ok: true; alreadyInitialized: boolean; repoPath: string; head?: string }
  | {
      ok: false;
      error: 'repo_path_missing' | 'mkdir_failed' | 'git_init_failed';
      repoPath: string;
      message?: string;
    };

function errMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

export function ensureProjectRepoInitialized(opts: {
  repoPath: string;
  name: string;
  goal: string;
  createDir?: boolean;
}): EnsureRepoResult {
  const { repoPath, name, goal, createDir } = opts;

  if (!fs.existsSync(repoPath)) {
    if (!createDir) {
      return { ok: false, error: 'repo_path_missing', repoPath };
    }
    try {
      fs.mkdirSync(repoPath, { recursive: true });
    } catch (err) {
      return { ok: false, error: 'mkdir_failed', repoPath, message: errMessage(err) };
    }
  }

  if (fs.existsSync(path.join(repoPath, '.git'))) {
    return { ok: true, alreadyInitialized: true, repoPath };
  }

  const env = { ...process.env, GIT_TERMINAL_PROMPT: '0' };
  const git = (...args: string[]): string =>
    execFileSync('git', args, { cwd: repoPath, env, stdio: 'pipe' }).toString();
  try {
    git('init', '-b', 'main');
    // Set a neutral local identity only if none is configured — git commit
    // refuses without user.email/name, and we don't want to impersonate the user.
    try {
      execFileSync('git', ['config', '--get', 'user.email'], { cwd: repoPath, env, stdio: 'pipe' });
    } catch {
      git('config', 'user.email', 'harness@local');
      git('config', 'user.name', 'WISP');
    }
    // Disable signing for the bootstrap commit so it works regardless of the
    // user's global signing config.
    git('config', 'commit.gpgsign', 'false');
    const readme = path.join(repoPath, 'README.md');
    if (!fs.existsSync(readme)) {
      fs.writeFileSync(readme, `# ${name}\n\n${goal}\n`, 'utf8');
    }
    git('add', '-A');
    git('commit', '-m', 'initial commit');
    const head = git('rev-parse', 'HEAD').trim();
    return { ok: true, alreadyInitialized: false, repoPath, head };
  } catch (err) {
    return { ok: false, error: 'git_init_failed', repoPath, message: errMessage(err) };
  }
}
