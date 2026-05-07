#!/usr/bin/env bash
# Agent Harness dashboard launcher (POSIX)
# Idempotent: re-running picks a free port and writes a fresh state.json.
# requires-exec: chmod +x scripts/launch-dashboard.sh

set -euo pipefail

# Resolve plugin root (set by Claude Code) with local-dev fallback.
plugin_root="${CLAUDE_PLUGIN_ROOT:-$(cd "$(dirname "$0")/.." && pwd)}"

# Resolve persistent data dir.
data_dir="${CLAUDE_PLUGIN_DATA:-${HOME}/.local/share/agent-harness}"
mkdir -p "$data_dir"

# Pick a free port in 4400..4500.
pick_port() {
  if command -v python3 >/dev/null 2>&1; then
    for p in $(seq 4400 4500); do
      if python3 -c "
import socket, sys
s = socket.socket()
try:
    s.bind(('127.0.0.1', int(sys.argv[1])))
except OSError:
    sys.exit(1)
finally:
    s.close()
" "$p" >/dev/null 2>&1; then
        echo "$p"
        return 0
      fi
    done
    return 1
  fi
  # Fallback: try /dev/tcp probe (bash builtin) - if connect fails, port is free.
  for p in $(seq 4400 4500); do
    if ! (exec 3<>"/dev/tcp/127.0.0.1/$p") 2>/dev/null; then
      echo "$p"
      return 0
    else
      exec 3<&- 3>&-
    fi
  done
  return 1
}

chosen_port="$(pick_port || true)"
if [ -z "${chosen_port:-}" ]; then
  echo "No free TCP port found in 4400-4500." >&2
  exit 1
fi

# Locate dashboard server entry. Auto-bootstrap on first launch.
server_entry="${plugin_root}/apps/dashboard-server/dist/server.js"
if [ ! -f "$server_entry" ]; then
  echo "First launch: building Agent Harness (~1-2 minutes)..."
  if ! command -v pnpm >/dev/null 2>&1; then
    echo "pnpm not found on PATH. Install it first: npm install -g pnpm" >&2
    exit 1
  fi
  cd "$plugin_root"
  echo "  pnpm install..."
  if ! pnpm install --frozen-lockfile; then
    echo "pnpm install failed." >&2
    exit 1
  fi
  echo "  pnpm build..."
  if ! pnpm build; then
    echo "pnpm build failed." >&2
    exit 1
  fi
  if [ ! -f "$server_entry" ]; then
    echo "Bootstrap finished but $server_entry still missing." >&2
    exit 1
  fi
  echo "  Built. Starting dashboard..."
fi

# Spawn node detached.
log_file="${data_dir}/server.log"
HARNESS_PORT="$chosen_port" HARNESS_DATA_DIR="$data_dir" HARNESS_SERVE_WEB=1 \
  nohup node "$server_entry" >"$log_file" 2>&1 &
server_pid=$!
disown "$server_pid" 2>/dev/null || true

# Write state.json.
started_at="$(date -u +%Y-%m-%dT%H:%M:%SZ)"
cat >"${data_dir}/state.json" <<EOF
{
  "port": ${chosen_port},
  "pid": ${server_pid},
  "startedAt": "${started_at}"
}
EOF

url="http://127.0.0.1:${chosen_port}"
echo "Dashboard: ${url}"

# Open browser.
if command -v open >/dev/null 2>&1; then
  open "$url" >/dev/null 2>&1 || true
elif command -v xdg-open >/dev/null 2>&1; then
  xdg-open "$url" >/dev/null 2>&1 || true
else
  echo "Open this URL in your browser: ${url}"
fi
