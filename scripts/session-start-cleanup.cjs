#!/usr/bin/env node
// SessionStart hook: sanity-check the `claude` CLI. Never blocks the session —
// missing CLI is reported as a hint, not an error. Cross-platform Node port
// of the original bash script so Windows boxes without WSL still run it.

'use strict';

const { spawnSync } = require('node:child_process');
const path = require('node:path');

function which(cmd) {
  const isWin = process.platform === 'win32';
  const pathEnv = process.env.PATH ?? '';
  const exts = isWin ? (process.env.PATHEXT ?? '.EXE;.CMD;.BAT').split(';') : [''];
  for (const dir of pathEnv.split(path.delimiter)) {
    if (!dir) continue;
    for (const ext of exts) {
      const candidate = path.join(dir, cmd + ext);
      try {
        const stat = require('node:fs').statSync(candidate);
        if (stat.isFile()) return candidate;
      } catch {
        // miss, keep looking
      }
    }
  }
  return null;
}

try {
  const claudePath = which('claude');
  if (claudePath) {
    const r = spawnSync(claudePath, ['--version'], { stdio: 'ignore' });
    if (r.status !== 0) {
      process.stderr.write(
        '[agent-harness] hint: `claude` is on PATH but `claude --version` failed; try `claude login`.\n',
      );
    }
  } else {
    process.stderr.write(
      '[agent-harness] hint: `claude` CLI not on PATH; install it and run `claude login`.\n',
    );
  }
} catch (err) {
  process.stderr.write(`[agent-harness] session-start: ${String(err)}\n`);
}

process.exit(0);
