#!/usr/bin/env bash
# PreCompact hook: archive the active session transcript before Claude Code
# compacts it. The transcript path is provided by the harness via
# CLAUDE_TRANSCRIPT_PATH; run-id and session-id are best-effort.
#
# requires-exec: chmod +x scripts/pre-compact-archive.sh

set -euo pipefail

# If no transcript was advertised, exit silently — nothing to archive.
if [ -z "${CLAUDE_TRANSCRIPT_PATH:-}" ]; then
  exit 0
fi

if [ ! -f "$CLAUDE_TRANSCRIPT_PATH" ]; then
  # Path was set but file is missing — log and exit non-error so we don't
  # block compaction.
  echo "[agent-harness] pre-compact: transcript not found at $CLAUDE_TRANSCRIPT_PATH" >&2
  exit 0
fi

DATA_DIR="${CLAUDE_PLUGIN_DATA:-$HOME/.local/share/agent-harness}"
RUN_ID="${HARNESS_CURRENT_RUN_ID:-default}"
SESSION_ID="${CLAUDE_SESSION_ID:-$(basename "$CLAUDE_TRANSCRIPT_PATH" .jsonl)}"
TS="$(date -u +%Y%m%dT%H%M%SZ)"

ARCHIVE_DIR="$DATA_DIR/archive/$RUN_ID"
mkdir -p "$ARCHIVE_DIR"

DEST="$ARCHIVE_DIR/${SESSION_ID}-${TS}.jsonl"
cp -- "$CLAUDE_TRANSCRIPT_PATH" "$DEST"

echo "[agent-harness] pre-compact: archived transcript to $DEST" >&2
exit 0
