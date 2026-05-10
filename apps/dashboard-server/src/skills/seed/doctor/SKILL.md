---
name: doctor
description: Self-diagnostics for the harness — checks DB integrity, MCP wiring, claude binary availability, and recent run failures.
model: haiku
allowed-tools: ["Bash", "Read"]
argument-hint: "(no args)"
timeout-ms: 90000
---
Run diagnostics in this order, output a Pass/Fail line per check:
1. `which claude` — claude CLI on PATH?
2. `claude --version` — version reported?
3. `node -e "require('better-sqlite3')"` — sqlite native binding loads?
4. Read `apps/dashboard-server/data/harness.db` exists (note: just check stat, do not open).
5. Last 5 runs from data/harness.db: how many failed?

Output: structured Pass/Fail report. Suggest one remediation per Fail.
