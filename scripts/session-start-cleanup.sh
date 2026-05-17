#!/usr/bin/env bash
# SessionStart hook: sanity-check the `claude` CLI. Never blocks the session —
# missing CLI is reported as a hint, not an error.
#
# requires-exec: chmod +x scripts/session-start-cleanup.sh

set -uo pipefail

if command -v claude >/dev/null 2>&1; then
  if ! claude --version >/dev/null 2>&1; then
    echo "[agent-harness] hint: \`claude\` is on PATH but \`claude --version\` failed; try \`claude login\`." >&2
  fi
else
  echo "[agent-harness] hint: \`claude\` CLI not on PATH; install it and run \`claude login\`." >&2
fi

exit 0
