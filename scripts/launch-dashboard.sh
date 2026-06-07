#!/usr/bin/env bash
# WISP dashboard launcher (POSIX)
# Idempotent: a re-run reuses a live server if one is recorded in state.json;
# otherwise it picks a free port and writes a fresh state.json.
# requires-exec: chmod +x scripts/launch-dashboard.sh

set -euo pipefail

# ---------------------------------------------------------------------------
# Node version preflight — fail fast with a clear message instead of burning
# 60+ seconds in pnpm install only to crash with a cryptic SyntaxError or ABI
# mismatch on the actual server start.
# ---------------------------------------------------------------------------
if ! command -v node >/dev/null 2>&1; then
  echo "Node.js not found. Install Node 22 LTS or Node 24 LTS from https://nodejs.org and re-run /wisp-dashboard." >&2
  exit 1
fi
node_ver="$(node --version | sed 's/^v//')"
node_major="${node_ver%%.*}"
rest="${node_ver#*.}"
node_minor="${rest%%.*}"
if [ "$node_major" -lt 20 ] || { [ "$node_major" -eq 20 ] && [ "$node_minor" -lt 10 ]; }; then
  echo "Node >= 20.10 required (found v$node_ver). Install Node 22 LTS or Node 24 LTS from https://nodejs.org and re-run /wisp-dashboard." >&2
  exit 1
fi
# Soft upper bound: the pinned better-sqlite3 (12.9.0) ships prebuilt binaries
# through Node 25. A newer Node forces a source compile (needs a C++ toolchain),
# so warn — but do NOT block, since a machine WITH build tools is fine. Bump this
# ceiling whenever the better-sqlite3 pin is upgraded.
if [ "$node_major" -gt 25 ]; then
  echo "Note: Node v$node_ver is newer than the tested range; if install fails on better-sqlite3, install Node 24 LTS (a prebuilt binary exists for it — no compiler needed)." >&2
fi

# Resolve plugin root (set by Claude Code) with local-dev fallback.
plugin_root="${CLAUDE_PLUGIN_ROOT:-$(cd "$(dirname "$0")/.." && pwd)}"

# Resolve persistent data dir.
data_dir="${CLAUDE_PLUGIN_DATA:-${HOME}/.local/share/agent-harness}"
mkdir -p "$data_dir"
log_file="${data_dir}/server.log"
state_file="${data_dir}/state.json"

# Open a URL in the default browser (best-effort, cross-platform).
open_url() {
  if command -v open >/dev/null 2>&1; then
    open "$1" >/dev/null 2>&1 || true
  elif command -v xdg-open >/dev/null 2>&1; then
    xdg-open "$1" >/dev/null 2>&1 || true
  else
    echo "Open this URL in your browser: $1"
  fi
}

# Resolve a pnpm invocation once (cached in $pnpm_cmd). Prefer a directly
# installed pnpm; else corepack (Node-bundled); else a version-pinned global
# pnpm via npm. Used by both the first-launch bootstrap and the better-sqlite3
# ABI self-heal. Returns non-zero if none can be obtained.
pnpm_cmd=""
ensure_pnpm() {
  [ -n "$pnpm_cmd" ] && return 0
  if command -v pnpm >/dev/null 2>&1; then
    pnpm_cmd="pnpm"
  elif command -v corepack >/dev/null 2>&1; then
    echo "  pnpm not found; using corepack (Node-bundled) instead."
    if corepack prepare 'pnpm@10.33.2' --activate; then
      pnpm_cmd="corepack pnpm"
    else
      echo "  corepack could not prepare pnpm@10.33.2 (bundled corepack may be too old to verify its signature)." >&2
      echo "  Falling back to: npm install -g pnpm@10.33.2" >&2
      if npm install -g pnpm@10.33.2 >&2 && command -v pnpm >/dev/null 2>&1; then
        pnpm_cmd="pnpm"
      else
        echo "Could not obtain pnpm@10.33.2 via corepack or npm. Install it manually ('npm install -g pnpm@10.33.2') and re-run /wisp-dashboard." >&2
        return 1
      fi
    fi
  else
    echo "Neither 'pnpm' nor 'corepack' is on PATH. Install Node 22 LTS (corepack ships with it) or run: npm install -g pnpm@10.33.2" >&2
    return 1
  fi
  return 0
}

# ---------------------------------------------------------------------------
# Idempotency: if a previous launch's server is still alive AND its port is
# still bound, reuse it instead of spawning a second server (which would orphan
# the first and put two writers on the same SQLite DB). state.json is written at
# the end of a successful launch below.
# ---------------------------------------------------------------------------
if [ -f "$state_file" ]; then
  prev_pid="$(sed -n 's/.*"pid"[[:space:]]*:[[:space:]]*\([0-9]\{1,\}\).*/\1/p' "$state_file" 2>/dev/null | head -1)"
  prev_port="$(sed -n 's/.*"port"[[:space:]]*:[[:space:]]*\([0-9]\{1,\}\).*/\1/p' "$state_file" 2>/dev/null | head -1)"
  if [ -n "${prev_pid:-}" ] && [ -n "${prev_port:-}" ] && kill -0 "$prev_pid" 2>/dev/null; then
    if (exec 3<>"/dev/tcp/127.0.0.1/${prev_port}") 2>/dev/null; then
      exec 3<&- 3>&-
      reuse_url="http://127.0.0.1:${prev_port}"
      echo "Dashboard already running (pid ${prev_pid}): ${reuse_url}"
      open_url "$reuse_url"
      exit 0
    fi
  fi
fi

# Pick a free port in 4400..4500.
#
# Prefer the bash /dev/tcp builtin — it's available everywhere real bash is and
# has no external-tool dependency. A SUCCESSFUL connect means the port is
# already in use, so we want the inverse: skip ports we can connect to and pick
# the first one that refuses. (This is the canonical way; an earlier version
# delegated to python3 first, which broke on Windows where Git Bash inherits
# the Microsoft Store python3 stub that exists on PATH but errors out.)
pick_port() {
  for p in $(seq 4400 4500); do
    if (exec 3<>"/dev/tcp/127.0.0.1/$p") 2>/dev/null; then
      exec 3<&- 3>&-
    else
      echo "$p"
      return 0
    fi
  done
  # /dev/tcp can be disabled in some hardened bash builds. Try python3 as a
  # last-resort fallback (real python only — Windows Store stub will fail
  # uniformly for every port and the function returns 1 below).
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
  fi
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
  echo "First launch: building WISP (~1-2 minutes)..."
  # Resolve pnpm (cached so the better-sqlite3 ABI self-heal below reuses it).
  if ! ensure_pnpm; then
    exit 1
  fi
  cd "$plugin_root"
  install_log="${data_dir}/install.log"
  echo "  $pnpm_cmd install... (log: $install_log)"
  set +e
  $pnpm_cmd install --frozen-lockfile 2>&1 | tee "$install_log"
  install_rc=${PIPESTATUS[0]}
  set -e
  if [ "$install_rc" -ne 0 ]; then
    echo "" >&2
    echo "pnpm install failed (exit $install_rc). Full log: $install_log" >&2
    if grep -qiE 'node-gyp|prebuild-install|gyp ERR|MSBuild|Visual Studio|xcode' "$install_log" 2>/dev/null; then
      echo "Cause: the native module better-sqlite3 had no prebuilt binary for your Node (v$node_ver) and tried to compile from source." >&2
      echo "Easiest fix: install Node 24 LTS (or Node 22 LTS) from https://nodejs.org — a prebuilt binary exists, no compiler needed — then re-run /wisp-dashboard." >&2
      case "$(uname -s)" in
        Darwin) echo "Or install build tools: xcode-select --install" >&2 ;;
        Linux) echo "Or install build tools: sudo apt-get install -y build-essential python3" >&2 ;;
      esac
    fi
    exit 1
  fi
  build_log="${data_dir}/build.log"
  echo "  $pnpm_cmd build... (log: $build_log)"
  set +e
  $pnpm_cmd build 2>&1 | tee "$build_log"
  build_rc=${PIPESTATUS[0]}
  set -e
  if [ "$build_rc" -ne 0 ]; then
    echo "" >&2
    echo "pnpm build failed (exit $build_rc). Full log: $build_log" >&2
    exit 1
  fi
  if [ ! -f "$server_entry" ]; then
    echo "Bootstrap finished but $server_entry still missing." >&2
    exit 1
  fi
  web_index="${plugin_root}/apps/dashboard-web/dist/index.html"
  if [ ! -f "$web_index" ]; then
    echo "Bootstrap finished but $web_index is missing — the web bundle did not build. Re-run 'pnpm -r build' from $plugin_root to see the underlying error." >&2
    exit 1
  fi
  echo "  Built. Starting dashboard..."
fi

# ---------------------------------------------------------------------------
# better-sqlite3 ABI self-heal. The native module's prebuilt binary is tied to
# the Node ABI it was installed under. If it was installed by a different Node
# (e.g. the Claude Code CLI's bundled Node) than the one launching the server
# here, loading it crashes with NODE_MODULE_VERSION before the server can boot.
# Probe it under THIS node; on mismatch, reconcile the pinned version + rebuild
# the binding against this Node, then re-probe.
# ---------------------------------------------------------------------------
probe_sqlite() {
  (cd "${plugin_root}/apps/dashboard-server" && node -e "require('better-sqlite3')") >/dev/null 2>&1
}
if ! probe_sqlite; then
  echo "better-sqlite3 was built for a different Node — rebuilding for $(node --version)..."
  rebuild_log="${data_dir}/rebuild.log"
  if ensure_pnpm; then
    (cd "$plugin_root" && $pnpm_cmd install --frozen-lockfile && $pnpm_cmd rebuild better-sqlite3) \
      >"$rebuild_log" 2>&1 || true
  fi
  if ! probe_sqlite; then
    echo "" >&2
    echo "better-sqlite3 still won't load under $(node --version)." >&2
    if [ -f "$rebuild_log" ]; then echo "Rebuild log: ${rebuild_log}" >&2; fi
    echo "Fix: from ${plugin_root} run 'pnpm rebuild better-sqlite3', or install Node 24 LTS (a prebuilt binary exists — no compiler needed) and re-run /wisp-dashboard." >&2
    exit 1
  fi
  echo "  better-sqlite3 rebuilt for $(node --version)."
fi

# Spawn node detached.
WISP_PORT="$chosen_port" WISP_DATA_DIR="$data_dir" WISP_SERVE_WEB=1 \
  nohup node "$server_entry" >"$log_file" 2>&1 &
server_pid=$!
disown "$server_pid" 2>/dev/null || true

# Write state.json.
started_at="$(date -u +%Y-%m-%dT%H:%M:%SZ)"
cat >"$state_file" <<EOF
{
  "port": ${chosen_port},
  "pid": ${server_pid},
  "startedAt": "${started_at}"
}
EOF

url="http://127.0.0.1:${chosen_port}"
echo "Dashboard: ${url}"
echo "Logs: ${log_file}"

# Wait until the server has bound the port before opening the browser,
# otherwise the user sees a connection-refused page and has to refresh.
# Probe at 200ms intervals up to 6 seconds (covers cold-start migrations +
# Fastify init on a slow first boot).
ready=0
for _ in $(seq 1 30); do
  sleep 0.2
  if (exec 3<>"/dev/tcp/127.0.0.1/${chosen_port}") 2>/dev/null; then
    exec 3<&- 3>&-
    ready=1
    break
  fi
done
if [ "$ready" -eq 0 ]; then
  echo "Dashboard not responding on ${url} after 6 seconds. Last log lines (${log_file}):" >&2
  tail -n 15 "$log_file" 2>/dev/null >&2 || true
fi

# Open browser.
open_url "$url"
