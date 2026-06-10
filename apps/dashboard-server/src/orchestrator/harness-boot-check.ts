/**
 * Harness-side boot check (efficiency loops P3) — boots the RESULT-BRANCH
 * code in a managed worktree right before the release gate decides.
 *
 * Why a worktree: the gate's legacy fallback probed the project's WORKING
 * TREE, which is whatever the user (or a prior merge) left checked out — not
 * necessarily the code the run produced. That mis-probe is the documented
 * FocusBoard bug class ("Boot: FAIL" against fresh evidence). This check
 * always boots exactly the result-branch sha, in a persistent
 * `bootcheck-<projectId>` worktree so node_modules survives across runs.
 *
 * Return contract:
 *   - `null`  → skipped. Either the project has no bootable dev surface
 *     (detectProjectType found no devCommand/probeUrl — library, CLI,
 *     unknown) or a HARNESS-side step threw (worktree creation, install,
 *     port probe). Harness failures must never block a release.
 *   - `{ ok: true }` → the result-branch app answered the probe.
 *   - `{ ok: false, reason }` → the app itself failed to boot; the release
 *     gate blocks on this regardless of the in-run verifier's report.
 */
import { execa } from 'execa';
import { runBootSmoke } from './boot-smoke.js';
import { detectProjectType } from './detect-project-type.js';
import { ensurePreviewWorktree, isPortFree } from './preview-server.js';

export interface HarnessBootCheckArgs {
  /** Absolute path to the project repo (where the result branch lives). */
  repoPath: string;
  projectId: string;
  runId: string;
  /** Fully-qualified result branch name, e.g. `wisp/<runId>/result`. */
  resultBranch: string;
}

/** Test seams — production callers pass nothing. */
export interface HarnessBootCheckSeams {
  ensureWorktreeImpl?: typeof ensurePreviewWorktree;
  detectImpl?: typeof detectProjectType;
  bootSmokeImpl?: typeof runBootSmoke;
  isPortFreeImpl?: typeof isPortFree;
  execaImpl?: typeof execa;
}

const PORT_PROBE_RANGE = 10;
const BOOT_READY_TIMEOUT_MS = 90_000;

export async function runHarnessBootCheck(
  args: HarnessBootCheckArgs,
  seams: HarnessBootCheckSeams = {},
): Promise<{ ok: boolean; reason?: string } | null> {
  const run = seams.execaImpl ?? execa;
  const ensureWorktree = seams.ensureWorktreeImpl ?? ensurePreviewWorktree;
  const detect = seams.detectImpl ?? detectProjectType;
  const bootSmoke = seams.bootSmokeImpl ?? runBootSmoke;
  const portFree = seams.isPortFreeImpl ?? isPortFree;

  let worktreePath: string;
  let devCommand: string;
  let probeUrl: string;
  try {
    const { stdout } = await run('git', ['rev-parse', '--verify', args.resultBranch], {
      cwd: args.repoPath,
    });
    const sha = stdout.trim();

    // Cheap bootability pre-probe: a result sha without a package.json can
    // never boot a dev server — skip BEFORE paying the worktree + pnpm
    // install cost (and the scary ERR_PNPM_NO_PKG_MANIFEST log) every run.
    try {
      await run('git', ['show', `${sha}:package.json`], { cwd: args.repoPath });
    } catch {
      return null;
    }

    // dirName keyed on projectId (not runId) so node_modules persists across
    // runs. `alwaysInstall` keeps the persistent worktree's deps in sync with
    // the result branch — a run that added a dependency must not falsely
    // block the gate on a stale node_modules (pnpm install is a fast no-op
    // when already up to date).
    worktreePath = await ensureWorktree(args.repoPath, args.projectId, {
      sha,
      dirName: `bootcheck-${args.projectId}`,
      alwaysInstall: true,
      ...(seams.execaImpl ? { execaImpl: seams.execaImpl } : {}),
    });

    // Detect on the WORKTREE — the result-branch code — never the (possibly
    // stale) repo working tree.
    const detection = detect(worktreePath);
    if (!detection.devCommand || !detection.probeUrl) return null;

    const requested = new URL(detection.probeUrl);
    const requestedPort = requested.port
      ? Number(requested.port)
      : requested.protocol === 'https:'
        ? 443
        : 80;
    let port: number | null = null;
    for (let p = requestedPort; p <= requestedPort + PORT_PROBE_RANGE; p++) {
      if (await portFree(p)) {
        port = p;
        break;
      }
    }
    if (port === null) {
      // Every candidate port is occupied — a harness-environment condition,
      // not the app's fault. Skip rather than block.
      console.error(
        `[harness-boot-check] no free port in [${requestedPort}, ${requestedPort + PORT_PROBE_RANGE}] — skipping boot check`,
      );
      return null;
    }

    devCommand = `${detection.devCommand} --port ${port}`;
    // `localhost` resolves to whichever loopback family the dev server
    // actually bound (Windows vite binds ::1 while detection emits 127.0.0.1
    // — same fix as preview-server's effectiveProbeUrl).
    const u = new URL(detection.probeUrl);
    u.hostname = 'localhost';
    u.port = String(port);
    probeUrl = u.toString();
  } catch (err) {
    console.error('[harness-boot-check] infra error — skipping boot check:', err);
    return null;
  }

  const result = await bootSmoke({
    repoPath: worktreePath,
    devCommand,
    probeUrl,
    readyTimeoutMs: BOOT_READY_TIMEOUT_MS,
  });
  if (result.ok) return { ok: true };
  return { ok: false, reason: result.detail };
}
