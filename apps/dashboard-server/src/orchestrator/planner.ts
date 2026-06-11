import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type { AgentSpec, Team } from '@wisp/schemas';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// agents/planner.md sits at the repo root. From src/orchestrator we walk up:
// src/orchestrator -> src -> dashboard-server -> apps -> repo-root -> agents/planner.md
const REPO_ROOT = path.resolve(__dirname, '..', '..', '..', '..');
const PLANNER_MD_PATH = path.join(REPO_ROOT, 'agents', 'planner.md');

let cachedPlannerBody: string | null = null;

function stripFrontmatter(md: string): string {
  // Frontmatter: leading "---\n...\n---\n" block. If absent, return as-is.
  if (!md.startsWith('---')) return md;
  const endMarker = md.indexOf('\n---', 3);
  if (endMarker < 0) return md;
  // Skip past the closing ---\n (or ---<EOF>).
  const after = md.indexOf('\n', endMarker + 4);
  if (after < 0) return '';
  return md.slice(after + 1);
}

export function loadPlannerSystemPrompt(): string {
  if (cachedPlannerBody !== null) return cachedPlannerBody;
  const raw = fs.readFileSync(PLANNER_MD_PATH, 'utf8');
  cachedPlannerBody = stripFrontmatter(raw).trim();
  return cachedPlannerBody;
}

/**
 * For M1 the planner is a fixed slot: model `opus`, allowedTools to read inputs
 * and write only `plan.json`, with the system prompt sourced from
 * `agents/planner.md`. The `team` argument is currently ignored (kept for the
 * signature so future iterations can let teams override the planner).
 */
export function plannerSpecFor(team: Team): AgentSpec {
  // M1: ignores the team and returns the fixed planner config. The argument is
  // retained so future iterations can let teams override the planner.
  void team;
  return {
    role: 'architect',
    model: 'opus',
    allowedTools: ['Read', 'Write(plan.json)'],
    systemPrompt: loadPlannerSystemPrompt(),
  };
}

const DAG_SCHEMA_BLOCK = `Plan {
  goal: string
  team: { roles: AgentSpec[] }
  nodes: TaskNode[]
  edges: Edge[]
}
TaskNode {
  id: string                         // unique within plan
  title: string                      // OPTIONAL: short imperative human title, max 60 chars (e.g. "Set up the data model")
  role: string                       // MUST be one of team.roles[].role; kebab-case
  prompt: string                     // task instruction for that node
  deps: string[]                     // node ids this node depends on
  successCriteria: { preflight?: string; build?: string; test?: string; lint?: string; custom?: string }
  // preflight runs ONCE before the rest. Use it for one-time setup
  // like "pnpm install" so build/test/lint don't each retrigger
  // install hooks (prebuild/pretest scripts) and race the lockfile.
  // On preflight failure, the rest of the gate is skipped.
  // Each value MUST be a shell command that the harness runs in the task's
  // worktree. The task is verified only when every configured command exits 0.
  // Never write a prose description here.
  // The harness invokes commands through the OS default shell (cmd.exe on
  // Windows, /bin/sh on POSIX), so use cross-platform tools only. Node is
  // guaranteed to be on PATH; bash-only utilities such as test, [, or [[ are
  // NOT available on Windows.
  // For documentation-only tasks (e.g., architect producing architecture.md),
  // use a node-based file-existence check. The recommended form is:
  //   custom: node -e <one-arg JS string that calls require('fs').accessSync(...) for each expected file>
  // The harness invokes the command via the OS shell, so wrap the JS in
  // double quotes inside the JSON value. node exits 1 if accessSync throws.
  // For string-content checks, normalise CRLF first:
  //   node -e "const c=require('fs').readFileSync('result.txt','utf8').replace(/\\r?\\n$/,''); if(c!==EXPECTED){process.exit(1)}"
  // (the harness commits files via git on Windows, which may write CRLF).
  maxTurns: number                   // 5..100 inclusive
}
Edge { from: string; to: string }    // mirrors deps as flat list
AgentSpec {
  role: string                       // kebab-case identifier
  model: "opus" | "sonnet" | "haiku"
  allowedTools: string[]
  systemPrompt: string
  skills?: string[]                  // optional skill names; MIRROR from the team verbatim — never invent or drop
}`;

export function buildPlannerPrompt(goal: string, team: Team): string {
  const teamJson = JSON.stringify(team, null, 2);
  return [
    `# Task`,
    `Generate a Plan DAG for the following goal and team.`,
    ``,
    `## Goal`,
    goal,
    ``,
    `## Team`,
    '```json',
    teamJson,
    '```',
    ``,
    `## Constraints`,
    `- The team has ${team.roles.length} ${team.roles.length === 1 ? 'role' : 'roles'}: ${team.roles.map((r) => `\`${r.role}\``).join(', ')}.`,
    `- Every TaskNode.role MUST exactly equal one of these literal strings.`,
    `- Mirror the team verbatim in the output JSON; do not invent extra roles.`,
    `- Give every TaskNode a short imperative \`title\` (≤60 chars) a non-developer understands, in the language of the goal.`,
    ``,
    `## DAG schema`,
    '```',
    DAG_SCHEMA_BLOCK,
    '```',
    ``,
    `## Output`,
    `Write a single JSON object matching the Plan schema above to \`plan.json\` at the working directory root.`,
    `Mirror the team verbatim. Do not write any other files. The JSON must parse and validate.`,
  ].join('\n');
}
