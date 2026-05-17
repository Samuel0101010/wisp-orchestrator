---
name: wisp-inspect
description: Use when the user wants to inspect the result branch of a completed WISP run — shows files in the result branch, the per-task git log graph, and a brief summary. Trigger on phrases like "what did harness produce", "show the run output", "inspect the result branch".
---

# WISP — Inspect Result Branch

Show what a WISP run produced. Works on completed runs (success or failure) by inspecting the per-run git branches in the project's repo.

> **Platform note**: `git` itself is cross-platform; only the `grep` line below has a PowerShell variant. The bash form also runs from Git Bash / WSL on Windows.

## Inputs

- **runId**: the run UUID. Ask the user if not provided.

## Steps

1. **Resolve the runId to its repoPath**:

   - **If the user already supplied a repoPath** (or you know it from context), skip to step 2.
   - **Otherwise** ask the user for the repoPath. The user almost always knows it; the API walk (run → plan → project → repoPath) is a 3-hop fallback to use only when they don't.

2. **List branches matching the runId**:
   ```bash
   # bash
   git -C <repoPath> branch --all | grep <runId-first-8-chars>
   ```
   ```powershell
   # PowerShell
   git -C <repoPath> branch --all | Select-String "<runId-first-8-chars>"
   ```
   Expect to see: `harness/<runId>/<task1>`, `harness/<runId>/<task2>`, ..., `harness/<runId>/result` (if the run succeeded). Replan runs ALSO have `v2/`, `v3/` prefixed branches — list them too.

3. **Show the git log graph** for these branches:
   ```bash
   git -C <repoPath> log --oneline --graph harness/<runId>/result harness/<runId>/<task-leaves...>
   ```
   This visualises which tasks ran in which order and where they merged.

4. **List files in the result branch**:
   ```bash
   git -C <repoPath> ls-tree -r --name-only harness/<runId>/result
   ```
   Filter out node_modules and other large irrelevant trees.

5. **Per-task summary** (optional, takes longer):
   For each task branch, show the diff against its parent:
   ```bash
   git -C <repoPath> log --stat -1 harness/<runId>/<taskId>
   ```

## Errors

- "fatal: not a git repository" → the repoPath is wrong; ask the user.
- No branches found matching the runId → either the runId is wrong, or the run is too old (branches preserved indefinitely; should still exist).

## Notes

- The result branch (`harness/<runId>/result`) is the merge of all leaf task branches. For replanned runs it contains the v2 (or higher) implementation, not the v1 attempt.
- node_modules in the result branch is normal for npm/pnpm projects — task subprocesses run `pnpm install` as part of their verify gate.
