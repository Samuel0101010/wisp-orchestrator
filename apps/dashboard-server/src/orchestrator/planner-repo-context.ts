import fs from 'node:fs';
import path from 'node:path';
import { and, desc, eq, inArray } from 'drizzle-orm';
import { plans as plansTable, safeParsePlan, type Plan } from '@wisp/schemas';
import { db } from '../db/index.js';
import { generateRepoTree } from './repo-tree.js';

/**
 * Planner-facing repo context (P2 Lane A).
 *
 * The planner runs in an empty mkdtemp dir and cannot read project files, so
 * the prompt is its only channel to the existing codebase. For repos that
 * already contain real code these sections carry a compact file tree, the
 * repo's architecture.md and a one-line-per-node digest of the previous plan
 * into the planner prompt — so iteration plans are deltas, not re-scaffolds.
 *
 * Everything is best-effort and capped: a scaffold-only/missing repo yields
 * no sections at all (fresh projects keep their greenfield prompts).
 */

const REPO_TREE_MAX_CHARS = 3_500;
const ARCHITECTURE_MD_MAX_CHARS = 3_000;
const PREVIOUS_PLAN_MAX_CHARS = 2_000;
const NODE_LABEL_MAX_CHARS = 120;
const TRUNCATION_MARKER = '\n\n… [truncated]';

export interface PreviousPlanRef {
  plan: Plan;
  createdAt: Date;
}

/**
 * Load the most recent plan for a project that actually reached execution
 * (status locked/running/done — drafts and failures don't describe shipped
 * structure). Returns null when no such plan exists or its dagJson no longer
 * parses against the current schema. Recency key mirrors the GET plan route:
 * created_at DESC with id as deterministic tiebreaker.
 */
export async function loadLatestPreviousPlan(projectId: string): Promise<PreviousPlanRef | null> {
  const row = await db
    .select()
    .from(plansTable)
    .where(
      and(
        eq(plansTable.projectId, projectId),
        inArray(plansTable.status, ['locked', 'running', 'done']),
      ),
    )
    .orderBy(desc(plansTable.createdAt), desc(plansTable.id))
    .get();
  if (!row) return null;
  const parsed = safeParsePlan(row.dagJson);
  if (!parsed.success) return null;
  return { plan: parsed.data, createdAt: row.createdAt };
}

/** Read `<repoPath>/architecture.md`, trimmed + capped. Null when absent/empty. */
function readArchitectureMd(repoPath: string): string | null {
  try {
    const raw = fs.readFileSync(path.join(repoPath, 'architecture.md'), 'utf8').trim();
    if (raw.length === 0) return null;
    if (raw.length > ARCHITECTURE_MD_MAX_CHARS) {
      return `${raw.slice(0, ARCHITECTURE_MD_MAX_CHARS)}${TRUNCATION_MARKER}`;
    }
    return raw;
  } catch {
    return null;
  }
}

function renderPreviousPlanSection(prev: PreviousPlanRef): string {
  const header = `### Previous plan (created ${prev.createdAt.toISOString()})`;
  const lines: string[] = [header];
  let used = header.length;
  for (const node of prev.plan.nodes) {
    const rawLabel = (node.title ?? node.prompt.split(/\r?\n/, 1)[0] ?? '').trim();
    const label =
      rawLabel.length > NODE_LABEL_MAX_CHARS ? rawLabel.slice(0, NODE_LABEL_MAX_CHARS) : rawLabel;
    const line = `- ${node.id} [${node.role}] ${label}`;
    // Hard 2000-char block cap — stop adding lines instead of slicing mid-line.
    if (used + 1 + line.length > PREVIOUS_PLAN_MAX_CHARS) break;
    lines.push(line);
    used += 1 + line.length;
  }
  return lines.join('\n');
}

/**
 * Build the `## Existing repository` planner-prompt sections for a project
 * repo. Returns [] when the repo is effectively empty (scaffold-only or
 * missing — see generateRepoTree), so fresh projects keep their greenfield
 * planner prompt untouched.
 */
export function buildPlannerRepoSections(args: {
  repoPath: string;
  previousPlan: PreviousPlanRef | null;
}): string[] {
  const tree = generateRepoTree(args.repoPath, { maxChars: REPO_TREE_MAX_CHARS });
  if (tree === null) return [];
  const sections: string[] = [];
  sections.push(
    `## Existing repository\n\n` +
      `The repo already contains a built app. Plan changes ON TOP of this code — modify and extend. Do NOT plan re-scaffolding of the project skeleton.\n\n` +
      `### File tree (truncated)\n\`\`\`\n${tree}\n\`\`\``,
  );
  const arch = readArchitectureMd(args.repoPath);
  if (arch) {
    sections.push(`### architecture.md\n\n${arch}`);
  }
  if (args.previousPlan) {
    sections.push(renderPreviousPlanSection(args.previousPlan));
  }
  return sections;
}
