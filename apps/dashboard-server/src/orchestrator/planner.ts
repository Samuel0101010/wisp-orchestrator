import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type { AgentSpec, Team } from '@agent-harness/schemas';

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
  team: { architect: AgentSpec, developer: AgentSpec, qa: AgentSpec }
  nodes: TaskNode[]
  edges: Edge[]
}
TaskNode {
  id: string                         // unique within plan
  role: "architect" | "developer" | "qa"
  prompt: string                     // task instruction for that node
  deps: string[]                     // node ids this node depends on
  successCriteria: { build?: string; test?: string; lint?: string; custom?: string }
  // Each value MUST be a shell command. The harness runs it in the task's
  // worktree and considers the task verified only when every configured
  // command exits 0. Never write a prose description here.
  // For documentation-only tasks (e.g., architect producing architecture.md),
  // use a file-existence check, for example:
  //   "custom": "test -f architecture.md && test -f tasks.md"
  // On Windows the test binary ships with Git for Windows and is on PATH.
  // Stick to simple && / || chains; avoid more advanced bash-only syntax.
  maxTurns: number                   // 5..100 inclusive
}
Edge { from: string; to: string }    // mirrors deps as flat list
AgentSpec {
  role: "architect" | "developer" | "qa"
  model: string
  allowedTools: string[]
  systemPrompt: string
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
