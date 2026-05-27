#!/usr/bin/env node
/**
 * Detached-spawn helper for the dashboard launchers.
 *
 * The PowerShell launcher previously used `Start-Process -NoNewWindow`,
 * which kept the dashboard in the parent shell's console group so closing
 * the Claude Code window killed the server (CTRL_CLOSE_EVENT). Swapping to
 * `-WindowStyle Hidden` solved the lifecycle issue but silently disabled
 * `-RedirectStandardOutput` / `-RedirectStandardError` (PS5.1 quirk —
 * documented in the code review of v2.0.17).
 *
 * This helper threads the needle: it spawns the server with
 * `detached: true` (no console-group inheritance on Windows) AND
 * `stdio: ['ignore', logOutFd, logErrFd]` so the log redirects continue to
 * work. We call `child.unref()` so the helper's own exit doesn't keep the
 * server alive via the parent reference, and we print the child PID on
 * stdout for the launcher to capture.
 *
 * Usage:
 *   node wisp-spawn-detached.cjs <serverEntry> <logOut> <logErr>
 *
 * The launcher reads the printed PID from stdout, exits, and the server
 * keeps running.
 */

'use strict';

const fs = require('node:fs');
const { spawn } = require('node:child_process');

function fail(msg) {
  process.stderr.write(`[wisp-spawn-detached] ${msg}\n`);
  process.exit(1);
}

const [, , serverEntry, logOutPath, logErrPath] = process.argv;
if (!serverEntry || !logOutPath || !logErrPath) {
  fail('usage: wisp-spawn-detached.cjs <serverEntry> <logOut> <logErr>');
}

let outFd;
let errFd;
try {
  outFd = fs.openSync(logOutPath, 'a');
  errFd = fs.openSync(logErrPath, 'a');
} catch (err) {
  fail(`failed to open log files: ${String(err)}`);
}

try {
  const child = spawn(process.execPath, [serverEntry], {
    detached: true,
    stdio: ['ignore', outFd, errFd],
    windowsHide: true,
    env: process.env,
  });
  child.unref();
  if (!child.pid) fail('spawn returned no PID');
  // Emit just the PID so the launcher can parse it deterministically.
  process.stdout.write(String(child.pid) + '\n');
  // Brief delay so the child's spawn actually happens before this process
  // (which holds the only reference to the OS handles in some edge cases)
  // exits. unref() should make this unnecessary but the small wait is
  // cheap insurance against a window where the kernel cleans up.
  setTimeout(() => process.exit(0), 50);
} catch (err) {
  fail(`spawn failed: ${String(err)}`);
}
