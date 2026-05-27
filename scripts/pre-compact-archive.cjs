#!/usr/bin/env node
// PreCompact hook: archive the active session transcript before Claude Code
// compacts it. Cross-platform (node, not bash) so it runs on a clean Windows
// box without WSL or Git Bash on PATH.

'use strict';

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

function main() {
  const transcriptPath = process.env.CLAUDE_TRANSCRIPT_PATH;
  if (!transcriptPath) {
    process.exit(0);
  }
  if (!fs.existsSync(transcriptPath)) {
    process.stderr.write(
      `[agent-harness] pre-compact: transcript not found at ${transcriptPath}\n`,
    );
    process.exit(0);
  }

  const dataDir =
    process.env.CLAUDE_PLUGIN_DATA ?? path.join(os.homedir(), '.local', 'share', 'agent-harness');
  // Sanitize path-segment inputs — these are passed through path.join which
  // normalizes ".." and lets a crafted env var resolve writes outside the
  // archive directory. The harness only ever sets these to UUID-shaped
  // values, so a strict allowlist is safe.
  const SAFE_SEGMENT = /^[A-Za-z0-9._-]+$/;
  const rawRunId = process.env.HARNESS_CURRENT_RUN_ID ?? 'default';
  const runId = SAFE_SEGMENT.test(rawRunId) ? rawRunId : 'default';
  const rawSessionId =
    process.env.CLAUDE_SESSION_ID ?? path.basename(transcriptPath, path.extname(transcriptPath));
  const sessionId = SAFE_SEGMENT.test(rawSessionId) ? rawSessionId : 'session';
  const ts = new Date()
    .toISOString()
    .replace(/[-:]/g, '')
    .replace(/\.\d{3}Z$/, 'Z');

  const archiveDir = path.join(dataDir, 'archive', runId);
  fs.mkdirSync(archiveDir, { recursive: true });

  const dest = path.join(archiveDir, `${sessionId}-${ts}.jsonl`);
  fs.copyFileSync(transcriptPath, dest);

  process.stderr.write(`[agent-harness] pre-compact: archived transcript to ${dest}\n`);
}

try {
  main();
} catch (err) {
  process.stderr.write(`[agent-harness] pre-compact: ${String(err)}\n`);
  // Never block compaction with a non-zero exit.
  process.exit(0);
}
