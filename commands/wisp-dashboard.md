---
name: harness-dashboard
description: Open the WISP dashboard in your browser
---

Launch the WISP dashboard server (if not already running) and open it in your default browser. The launcher picks a free port in the 4400-4500 range, writes connection state to `${CLAUDE_PLUGIN_DATA}/state.json`, and prints the URL.

**First-launch:** the launcher auto-runs `pnpm install && pnpm build` (~1-2 minutes one-time). pnpm must be on PATH.

Pick the script for the user's OS — only one of these runs:

**Windows (PowerShell):**

```bash
powershell -ExecutionPolicy Bypass -File "${CLAUDE_PLUGIN_ROOT}/scripts/launch-dashboard.ps1"
```

**macOS/Linux (bash):**

```bash
bash "${CLAUDE_PLUGIN_ROOT}/scripts/launch-dashboard.sh"
```
