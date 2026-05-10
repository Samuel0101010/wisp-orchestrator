#!/usr/bin/env node
/**
 * Claude Code hook handler — forwards events from local Claude Code sessions
 * (running inside the harness repo) to the harness server's /api/hooks/event
 * endpoint. Silently no-ops when HARNESS_HOOK_TOKEN is not set so it never
 * blocks claude code execution. Exits 0 in all cases.
 */
const subcommand = process.argv[2] || 'unknown';
const eventMap = {
  'pre-tool': 'PreToolUse',
  'post-tool': 'PostToolUse',
  'prompt-submit': 'UserPromptSubmit',
  'stop': 'Stop',
};
const event = eventMap[subcommand] || 'unknown';

let payload = '';
process.stdin.on('data', (chunk) => { payload += chunk; });
process.stdin.on('end', async () => {
  const token = process.env.HARNESS_HOOK_TOKEN;
  if (!token) { process.exit(0); return; }
  const port = process.env.HARNESS_PORT || '4400';
  const body = {
    event,
    toolName: extractTool(payload),
    cwd: process.cwd(),
    payload: safeJson(payload),
  };
  try {
    const res = await fetch(`http://127.0.0.1:${port}/api/hooks/event`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-harness-token': token },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(2000),
    });
    if (!res.ok) {
      console.error(`[harness-hook] ${event}: HTTP ${res.status}`);
    }
  } catch {
    // Never block claude code — eat the error silently
  }
  process.exit(0);
});
process.stdin.on('error', () => process.exit(0));

function safeJson(s) {
  try { return JSON.parse(s); } catch { return { raw: s.slice(0, 500) }; }
}
function extractTool(s) {
  try { return JSON.parse(s).tool_name ?? null; } catch { return null; }
}
