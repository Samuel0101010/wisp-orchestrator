/**
 * Project-state loader (v1.9 Phase 2).
 *
 * After every successful run the runtime-verifier writes
 * `docs/project-state.md` into the result branch. We git-show it back here,
 * parse the four canonical sections (Implemented features / Open todos /
 * Known issues / Architecture snapshot) into structured JSON, and persist
 * a `project_states` row.
 *
 * The next iteration planner reads the most recent row + any pending
 * change_requests so it can plan a SURGICAL delta instead of re-implementing
 * everything from scratch. Without this loader run N+1 would treat the
 * project as greenfield no matter what run N actually accomplished.
 *
 * Everything is best-effort: a missing file or malformed markdown produces
 * an empty arrays state row (still useful — the row's existence flips
 * plan.kind to 'iteration'). We never throw out of the post-run hook.
 */

import { randomUUID } from 'node:crypto';
import { execa } from 'execa';
import { desc, eq } from 'drizzle-orm';
import type { BetterSQLite3Database } from 'drizzle-orm/better-sqlite3';
import { projectStates as projectStatesTable } from '@wisp/schemas';

export const PROJECT_STATE_MD_PATH = 'docs/project-state.md';

export interface ParsedProjectState {
  completedFeatures: string[];
  openTodos: string[];
  knownIssues: string[];
  architectureSnapshot: unknown | null;
}

/**
 * Parse `docs/project-state.md` into structured arrays. Expected structure
 * (the runtime-verifier prompt enforces it verbatim):
 *
 *   # Project State
 *
 *   ## Implemented features
 *   - foo
 *   - bar
 *
 *   ## Open todos
 *   - baz
 *
 *   ## Known issues
 *   - quux
 *
 *   ## Architecture snapshot
 *   ```json
 *   { "topLevel": ["src/", "tests/"] }
 *   ```
 *
 * Tolerant of:
 *   - missing sections (returns empty arrays for those)
 *   - extra prose between sections (ignored)
 *   - non-JSON fenced architecture block (architectureSnapshot stays null)
 *   - heading casing differences (case-insensitive match on the section name)
 */
export function parseProjectStateMarkdown(md: string): ParsedProjectState {
  const result: ParsedProjectState = {
    completedFeatures: [],
    openTodos: [],
    knownIssues: [],
    architectureSnapshot: null,
  };

  type Section = 'completedFeatures' | 'openTodos' | 'knownIssues' | 'architectureSnapshot' | null;

  const sectionFor = (heading: string): Section => {
    const h = heading.toLowerCase().trim();
    if (/implemented(\s+features)?|completed(\s+features)?/.test(h)) return 'completedFeatures';
    if (/open\s+todos|todos?|outstanding/.test(h)) return 'openTodos';
    if (/known\s+issues|issues|bugs/.test(h)) return 'knownIssues';
    if (/architecture(\s+snapshot)?|file\s+map|layout/.test(h)) return 'architectureSnapshot';
    return null;
  };

  const lines = md.split(/\r?\n/);
  let current: Section = null;
  let archBuffer: string[] = [];
  let inArchFence = false;

  for (const raw of lines) {
    const line = raw;
    const headingMatch = /^##\s+(.+?)\s*$/.exec(line);
    if (headingMatch) {
      // Close any open arch fence — moving sections ends it.
      if (current === 'architectureSnapshot' && archBuffer.length > 0) {
        result.architectureSnapshot = tryParseArchitectureJson(archBuffer.join('\n'));
      }
      archBuffer = [];
      inArchFence = false;
      current = sectionFor(headingMatch[1]!);
      continue;
    }
    if (current === null) continue;

    if (current === 'architectureSnapshot') {
      const fence = /^```/.test(line);
      if (fence) {
        // Toggle fence — only collect content INSIDE the first fenced block.
        if (!inArchFence) {
          inArchFence = true;
        } else {
          // Closing fence — parse what we have, then stop collecting.
          result.architectureSnapshot = tryParseArchitectureJson(archBuffer.join('\n'));
          archBuffer = [];
          inArchFence = false;
          current = null; // first fenced block wins
        }
        continue;
      }
      if (inArchFence) archBuffer.push(line);
      continue;
    }

    // List-item collection for the bullet sections.
    const bulletMatch = /^\s*[-*]\s+(.+?)\s*$/.exec(line);
    if (bulletMatch) {
      const item = bulletMatch[1]!.trim();
      if (item.length === 0) continue;
      if (current === 'completedFeatures') result.completedFeatures.push(item);
      else if (current === 'openTodos') result.openTodos.push(item);
      else if (current === 'knownIssues') result.knownIssues.push(item);
    }
  }

  // If the file ended mid-architecture fence without a closing ```, parse the
  // buffered content too — be lenient.
  if (current === 'architectureSnapshot' && archBuffer.length > 0) {
    result.architectureSnapshot = tryParseArchitectureJson(archBuffer.join('\n'));
  }

  return result;
}

function tryParseArchitectureJson(raw: string): unknown | null {
  const trimmed = raw.trim();
  if (!trimmed) return null;
  // Strip optional `json` info-string line at the top.
  const cleaned = trimmed.startsWith('json\n') ? trimmed.slice(5) : trimmed;
  try {
    return JSON.parse(cleaned);
  } catch {
    return null;
  }
}

/**
 * git show `<ref>:docs/project-state.md`. Returns null when the file
 * is absent at that ref or git errors out. Never throws.
 */
export async function loadProjectStateMarkdownFromRef(args: {
  repoPath: string;
  ref: string;
}): Promise<string | null> {
  try {
    const { stdout } = await execa('git', ['show', `${args.ref}:${PROJECT_STATE_MD_PATH}`], {
      cwd: args.repoPath,
    });
    return stdout;
  } catch {
    return null;
  }
}

/**
 * Insert a `project_states` row for the given project + run + parsed state.
 * Returns the new row id. Always succeeds (no FK on runId so a deleted run
 * doesn't break this).
 */
export async function persistProjectState(args: {
  db: BetterSQLite3Database;
  projectId: string;
  runId: string | null;
  stateMdPath: string | null;
  parsed: ParsedProjectState;
}): Promise<string> {
  const id = randomUUID();
  await args.db
    .insert(projectStatesTable)
    .values({
      id,
      projectId: args.projectId,
      runId: args.runId,
      stateMd: args.stateMdPath,
      completedFeatures: args.parsed.completedFeatures,
      openTodos: args.parsed.openTodos,
      knownIssues: args.parsed.knownIssues,
      architectureSnapshot: args.parsed.architectureSnapshot,
    })
    .run();
  return id;
}

/**
 * Read the most recent project_states row for a project. Returns null when
 * the project has never been verified (first run will be 'initial').
 */
export async function getLatestProjectState(
  db: BetterSQLite3Database,
  projectId: string,
): Promise<{
  id: string;
  projectId: string;
  runId: string | null;
  stateMd: string | null;
  completedFeatures: string[];
  openTodos: string[];
  knownIssues: string[];
  architectureSnapshot: unknown | null;
  createdAt: Date;
} | null> {
  const row = await db
    .select()
    .from(projectStatesTable)
    .where(eq(projectStatesTable.projectId, projectId))
    .orderBy(desc(projectStatesTable.createdAt))
    .get();
  if (!row) return null;
  return {
    id: row.id,
    projectId: row.projectId,
    runId: row.runId,
    stateMd: row.stateMd,
    completedFeatures: row.completedFeatures,
    openTodos: row.openTodos,
    knownIssues: row.knownIssues,
    architectureSnapshot: row.architectureSnapshot,
    createdAt: row.createdAt,
  };
}
