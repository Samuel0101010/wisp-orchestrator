/**
 * Per-pid liveness + CPU-time probe used by the walker's inactivity
 * watchdog. The watchdog used to kill a task subprocess after 10 min of
 * silence on the event stream — but the claude CLI can sit on a long
 * model "thinking" pause without emitting any tool/text frame while the
 * underlying process is still burning CPU. The 2026-05-17 FocusBoard
 * `n3-store` run lost ~12 min that way: the watchdog killed a healthy
 * subprocess that was about to answer.
 *
 * This helper lets the watchdog distinguish "really stuck" from "still
 * thinking" before pulling the trigger:
 *
 * - `process.kill(pid, 0)` — a probe-only signal that throws ESRCH if
 *   the process is gone. If it throws → kill+retry path fires now.
 * - CPU-time read — POSIX `ps -o time= -p <pid>`, Windows
 *   `Get-Process -Id <pid> | Select CPU`. If CPU advanced ≥1s within
 *   the idle window the proc is doing work; the watchdog extends the
 *   grace period.
 *
 * The probe is best-effort: any failure returns `cpuSeconds: null` and
 * the caller falls back to "alive + assume stuck" (the safer default,
 * since the alternative is leaking a hung subprocess).
 */

import { spawnSync } from 'node:child_process';
import process from 'node:process';

export interface LivenessProbe {
  /** True if `process.kill(pid, 0)` succeeded; false on ESRCH. */
  alive: boolean;
  /**
   * Total CPU time the process has accumulated, in seconds. `null`
   * means the probe could not be read (ps/wmic missing, parse error,
   * or platform we don't support). Caller MUST treat null as "no
   * advancement signal available" and fall back to time-only logic.
   */
  cpuSeconds: number | null;
}

/**
 * Parse a POSIX `ps -o time=` value. Common formats:
 *   "0:01.23"        — m:ss.cs
 *   "1:23:45"        — h:mm:ss
 *   "01:23"          — mm:ss
 *   "12-03:45:01"    — d-hh:mm:ss (BSD; rare)
 */
export function parsePosixCpuTime(raw: string): number | null {
  const trimmed = raw.trim();
  if (!trimmed) return null;
  // d-hh:mm:ss prefix
  let dayPart = 0;
  let rest = trimmed;
  const dayMatch = /^(\d+)-(.+)$/.exec(trimmed);
  if (dayMatch && dayMatch[1] !== undefined && dayMatch[2] !== undefined) {
    dayPart = Number(dayMatch[1]) * 86400;
    rest = dayMatch[2];
  }
  const parts = rest.split(':');
  if (parts.length < 1 || parts.length > 3) return null;
  let h = 0;
  let m = 0;
  let s = 0;
  if (parts.length === 3) {
    h = Number(parts[0]);
    m = Number(parts[1]);
    s = Number(parts[2]);
  } else if (parts.length === 2) {
    m = Number(parts[0]);
    s = Number(parts[1]);
  } else {
    s = Number(parts[0]);
  }
  if (![h, m, s].every((n) => Number.isFinite(n))) return null;
  return dayPart + h * 3600 + m * 60 + s;
}

/**
 * Parse the integer-seconds field emitted by PowerShell
 * `Get-Process -Id <pid> | Select-Object -ExpandProperty CPU`. Output
 * is a decimal like `12.34375` (seconds). Returns null on parse error.
 */
export function parseWindowsCpuTime(raw: string): number | null {
  const trimmed = raw.trim();
  if (!trimmed) return null;
  const n = Number(trimmed);
  if (!Number.isFinite(n) || n < 0) return null;
  return n;
}

/**
 * Read CPU time on POSIX via `ps -o time= -p <pid>`. Returns null on
 * any error (ps missing, non-zero exit, unparseable output).
 */
function readPosixCpuTime(pid: number): number | null {
  try {
    const res = spawnSync('ps', ['-o', 'time=', '-p', String(pid)], {
      encoding: 'utf8',
      windowsHide: true,
    });
    if (res.status !== 0 || !res.stdout) return null;
    return parsePosixCpuTime(res.stdout);
  } catch {
    return null;
  }
}

/**
 * Read CPU time on Windows via PowerShell's `Get-Process` CPU column
 * (decimal seconds). PowerShell is part of the Windows base install on
 * every supported runner, so this is the most portable path.
 */
function readWindowsCpuTime(pid: number): number | null {
  try {
    const res = spawnSync(
      'powershell.exe',
      [
        '-NoProfile',
        '-NonInteractive',
        '-Command',
        `(Get-Process -Id ${pid} -ErrorAction SilentlyContinue).CPU`,
      ],
      { encoding: 'utf8', windowsHide: true },
    );
    if (res.status !== 0 || !res.stdout) return null;
    return parseWindowsCpuTime(res.stdout);
  } catch {
    return null;
  }
}

/**
 * Liveness check that distinguishes ESRCH (truly gone) from EPERM
 * (exists but we can't signal). Signal 0 is the POSIX/Node convention
 * for "probe-only": it throws ESRCH if the pid is gone but does NOT
 * signal the process.
 */
export function isPidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code === 'ESRCH') return false;
    // EPERM / unknown — assume alive to avoid false-killing a healthy proc.
    return true;
  }
}

/**
 * Default liveness + CPU probe. Used by the walker watchdog when no
 * test-provided probe is wired.
 */
export function probePidLiveness(pid: number): LivenessProbe {
  if (!isPidAlive(pid)) return { alive: false, cpuSeconds: null };
  const cpuSeconds =
    process.platform === 'win32' ? readWindowsCpuTime(pid) : readPosixCpuTime(pid);
  return { alive: true, cpuSeconds };
}
