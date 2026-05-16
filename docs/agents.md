# Agents

WISP uses four agent specs, all defined as plugin-loadable Markdown files in [`agents/`](../agents). Three of them — architect, developer, QA — populate the `Team` object that flows through the plan; the fourth — planner — is invoked once per run by the orchestrator before any team agent dispatches.

This page is a reference. The authoritative system prompts live in the linked agent files; this document only paraphrases their contracts.

## architect

- **File:** [`agents/architect.md`](../agents/architect.md)
- **Role:** `architect`
- **Default model:** `opus`
- **Allowed tools:** `Read`, `Grep`, `Glob`, `Write(architecture.md)`, `Write(tasks.md)`, `Bash(git:*, ls:*, find:*)`

### Role

Owns top-down design. Surveys the existing repo, decides module boundaries and tech-stack choices, and produces the two artifacts that downstream roles read as binding constraints: `architecture.md` and `tasks.md`.

### Inputs

- The user goal (passed in via the planner's first node prompt).
- The existing repository (read-only via `Read` / `Grep` / `Glob`).

### Outputs

- `architecture.md` (≤ 1500 words, hard cap) at the project root.
- `tasks.md` as a role-tagged checklist (e.g. `- [ ] [dev] implement schema package`).

### Hard rules

- No implementation code (no `.ts`, `.js`, `.tsx`, `.py`, etc.).
- No files outside `architecture.md` and `tasks.md`.
- No build/test runs.
- If the goal is ambiguous, write the architecture against the most defensible interpretation and capture open questions in a final section. Do not block.

## developer

- **File:** [`agents/developer.md`](../agents/developer.md)
- **Role:** `developer`
- **Default model:** `sonnet`
- **Allowed tools:** `Read`, `Edit`, `Write`, `MultiEdit`, `Grep`, `Glob`, `Bash(npm:*, pnpm:*, node:*, git add:*, git commit:*)`

### Role

Implements exactly one task from `tasks.md`. The orchestrator places each developer node in its own git worktree so concurrent developers cannot stomp each other.

### Inputs

- `architecture.md` (binding constraint).
- `tasks.md` (assigned item passed in via the prompt).
- The repo, mounted at `${CLAUDE_PROJECT_DIR}` which equals the worktree path.

### Outputs

- One git commit on the worktree branch with a present-tense imperative subject under 72 characters.

### Hard rules

- Never modifies `architecture.md` or `tasks.md`.
- Never adds a dependency without a justification line in the commit body.
- Never picks up a second task — one commit, then return.
- Must run `pnpm build` (and `pnpm typecheck` if present) before claiming success. A failing build is reported plainly, not papered over.
- Surgical changes only: every changed line must trace to the assigned task.

## qa

- **File:** [`agents/qa.md`](../agents/qa.md)
- **Role:** `qa`
- **Default model:** `sonnet`
- **Allowed tools:** `Read`, `Grep`, `Glob`, `Bash(npm test:*, npm run build:*, npm run lint:*, pnpm test:*, pnpm build:*, pnpm lint:*)`

### Role

Read-only quality gate. Runs build, test, and lint in the developer's worktree, then emits a BMAD-style verdict (`PASS` / `CONCERNS` / `FAIL`) the orchestrator routes on.

### Inputs

- The developer's worktree (post-commit).
- `architecture.md`, `tasks.md` for scope-drift judgement.

### Outputs

The **last line** of stdout MUST be a single-line JSON object:

```
{"verdict":"PASS|CONCERNS|FAIL","build":true,"test":true,"lint":true,"notes":"..."}
```

Anything printed before the final line is informational; the orchestrator parses only the last line.

### Verdict rules

- **PASS** — build + test + lint all green, no scope concerns.
- **CONCERNS** — all green BUT change drifts from `tasks.md`/`architecture.md`, or new-code coverage looks thin.
- **FAIL** — any of build/test/lint fails, or change clearly violates `architecture.md`.

### Hard rules

- Never uses `Edit`, `Write`, or `MultiEdit`. Code modification is forbidden.
- Never invents test results. Unrun commands are reported in `notes` with verdict `CONCERNS`.
- Never suppresses a real failure. Flaky tests are `FAIL` with a retry-suggestion note.

## planner

- **File:** [`agents/planner.md`](../agents/planner.md)
- **Role:** `planner` (orchestrator-only; not part of the run's team)
- **Default model:** `opus`
- **Allowed tools:** `Read`, `Grep`, `Glob`, `Write(plan.json)`

### Role

Converts a `(Goal, Team)` pair into a valid `Plan` DAG, written to `plan.json`. Invoked once per run by the dashboard server before any team agent spawns.

### Inputs

- `Goal: string` — the project goal.
- `Team: { architect: AgentSpec, developer: AgentSpec, qa: AgentSpec }` — must be mirrored verbatim in the output.
- Optional pre-existing `architecture.md` / `tasks.md` to inform decomposition.

### Outputs

`plan.json` at the project root, conforming to `planSchema` ([`packages/schemas/src/plan.ts`](../packages/schemas/src/plan.ts)):

```
Plan {
  goal: string
  team: { architect: AgentSpec, developer: AgentSpec, qa: AgentSpec }
  nodes: TaskNode[]
  edges: Edge[]
}

TaskNode {
  id: string                         // unique within plan
  role: "architect" | "developer" | "qa"
  prompt: string                     // task instruction
  deps: string[]                     // node ids this node depends on
  successCriteria: { build?: string; test?: string; lint?: string; custom?: string }
  maxTurns: number                   // 5..100 inclusive
}

Edge { from: string; to: string }    // mirrors deps as flat list
```

### Hard rules

- Writes ONLY `plan.json`.
- All `node.deps` and edges reference existing node ids; the graph is acyclic.
- Minimum viable plan: one architect node, one or more developer nodes depending on the architect, one QA node depending on the developer(s).
- `team` is mirrored verbatim — the planner does not invent agent specs.
- Prefers wider/shallower DAGs (parallel developer nodes) over deep chains.
- Calibrated `maxTurns`: small refactors 10-20, feature work 30-50, multi-file integrations 50-80.

## How the orchestrator binds the agent

When the Walker dispatches a task, it constructs a prompt by concatenating:

1. The TaskNode's `prompt` (per-task instruction).
2. Run context (`architecture.md` path, project goal, prior failure tail on retry).

This prompt is passed to `runClaude(...)` which spawns:

```
claude -p "<built prompt>"
  --output-format stream-json
  --verbose
  --max-turns <node.maxTurns>
  --allowed-tools <node.allowedTools joined with ,>
  --model <node.model>
  --system-prompt <node.systemPrompt>
  [--resume <prevSessionId>]   # only on resume after pause/shutdown
```

`--system-prompt` is set from the corresponding `AgentSpec.systemPrompt` in the team. The agent files in `agents/*.md` provide the canonical text that the dashboard pre-fills into the TeamBuilder; users can override per-project before locking the team.

## Cross-references

- [docs/architecture.md](architecture.md) — full data flow, state machine, resilience matrix.
- [docs/development.md](development.md) — extending agent specs, mock CLI fixtures.
- [packages/schemas/src/plan.ts](../packages/schemas/src/plan.ts) — Zod sources of truth for `Plan`, `Team`, `AgentSpec`.
