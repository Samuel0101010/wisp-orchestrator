---
name: wisp-new-run
description: Use when the user wants to create and start a new WISP run from a goal — handles project creation, optional template selection, plan generation, lock + run, and prints the run URL. Trigger on phrases like "start a harness run", "new agent run", "kick off a harness project".
---

# WISP — New Run

Take the user from a freeform goal to a running harness execution.

> **Platform note**: snippets below show both bash and PowerShell forms. Pick the one matching the user's shell. The bash form also runs from Git Bash / WSL on Windows.

## Inputs needed (ask the user if missing, do not guess)

- **Goal**: what should the agents accomplish? (1-2 sentences)
- **Repo path**: absolute path to the git repo to operate in (must exist + be a git repo)
- **Template**: one of `ts-library | python-backend | refactor-squad | data-pipeline | none`
- **Project name**: short identifier (kebab-case if possible)

## Preflight

1. Confirm the harness server is up.
   - bash: `curl -s http://127.0.0.1:${WISP_PORT:-4400}/api/health`
   - PowerShell: `Invoke-RestMethod -Uri "http://127.0.0.1:$($env:WISP_PORT ?? 4400)/api/health"`

   If it returns non-200 or refuses connection, tell the user to run `/wisp-dashboard` first to start the server, then re-run this skill.
2. Confirm the repo path exists and is a git repo: `git -C <repoPath> rev-parse --git-dir`. If not, ask the user to fix the path or run `git init` in it.

## Steps

1. **Create project**:
   ```bash
   # bash / Git Bash
   curl -s -X POST http://127.0.0.1:${WISP_PORT:-4400}/api/projects \
     -H 'content-type: application/json' \
     -d '{"name":"<name>","goal":"<goal>","repoPath":"<repoPath>"}'
   ```
   ```powershell
   # PowerShell
   $port = if ($env:WISP_PORT) { $env:WISP_PORT } else { 4400 }
   $body = @{ name = "<name>"; goal = "<goal>"; repoPath = "<repoPath>" } | ConvertTo-Json
   Invoke-RestMethod -Method Post -Uri "http://127.0.0.1:$port/api/projects" `
     -ContentType "application/json" -Body $body
   ```
   Capture `id` from the response — this is the projectId.

2. **Seed team from template** (only if template != none):
   ```bash
   # bash + jq
   TEAM=$(curl -s http://127.0.0.1:${WISP_PORT:-4400}/api/team-templates \
     | jq -c --arg id <template-id> '.templates[] | select(.id==$id) | .team')
   curl -s -X PUT http://127.0.0.1:${WISP_PORT:-4400}/api/projects/<projectId>/team \
     -H 'content-type: application/json' \
     -d "$TEAM"
   ```
   ```powershell
   # PowerShell (no jq needed — ConvertFrom-Json gives objects)
   $port = if ($env:WISP_PORT) { $env:WISP_PORT } else { 4400 }
   $tpl = Invoke-RestMethod -Uri "http://127.0.0.1:$port/api/team-templates"
   $team = ($tpl.templates | Where-Object { $_.id -eq "<template-id>" }).team
   Invoke-RestMethod -Method Put -Uri "http://127.0.0.1:$port/api/projects/<projectId>/team" `
     -ContentType "application/json" -Body ($team | ConvertTo-Json -Depth 20)
   ```
   If neither `jq` nor PowerShell is available, fetch the templates response into a Python or Node one-liner that prints just `.team` for the chosen id, then pipe that into the PUT body. Do NOT use `--data-binary @<file>` unless you've actually written the file first.
   If template == none: tell the user to open the dashboard and configure the team manually, then exit this skill (you cannot create a default team via API today — the dashboard handles defaults).

3. **Generate plan**:
   ```bash
   # bash
   curl -s -X POST http://127.0.0.1:${WISP_PORT:-4400}/api/projects/<projectId>/plan -H 'content-type: application/json' -d '{}'
   ```
   ```powershell
   # PowerShell
   Invoke-RestMethod -Method Post -Uri "http://127.0.0.1:$port/api/projects/<projectId>/plan" `
     -ContentType "application/json" -Body '{}'
   ```
   Capture `id` from the response — this is the planId.

4. **Lock plan**:
   ```bash
   # bash
   curl -s -X POST http://127.0.0.1:${WISP_PORT:-4400}/api/plans/<planId>/lock
   ```
   ```powershell
   # PowerShell
   Invoke-RestMethod -Method Post -Uri "http://127.0.0.1:$port/api/plans/<planId>/lock"
   ```

5. **Start run**:
   ```bash
   # bash
   curl -s -X POST http://127.0.0.1:${WISP_PORT:-4400}/api/runs \
     -H 'content-type: application/json' \
     -d '{"planId":"<planId>"}'
   ```
   ```powershell
   # PowerShell
   $body = @{ planId = "<planId>" } | ConvertTo-Json
   Invoke-RestMethod -Method Post -Uri "http://127.0.0.1:$port/api/runs" `
     -ContentType "application/json" -Body $body
   ```
   Capture `runId` from the response.

6. **Print the run URL**:
   ```
   http://127.0.0.1:${WISP_PORT:-4400}/projects/<projectId>/run/<runId>
   ```
   Tell the user the run is live and they can watch it in the dashboard.

## Errors

- `503` from POST /api/runs → auth probe failed; tell the user to run `claude login` and retry.
- `422` from POST /plan → planner couldn't produce a valid DAG; show the message verbatim. Common causes: goal too vague, no team configured, project.goal blank.
- Connection refused → server not running; refer back to preflight step 1.

## Notes

- The default port is 4400; override with `WISP_PORT` env var.
- Long-running tasks (architect+dev+qa) take 1-10 minutes per role, so the run won't finish in the same Claude session — watch progress in the dashboard.
