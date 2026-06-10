/**
 * Hand-off injection helpers (v1.14 Phase 6).
 *
 * The walker writes a structured hand-off entry (`handoff/<role>/<taskId>`)
 * into the per-project memory DB after each task transitions to `done`.
 * Subsequent tasks see those entries injected into their composed prompt as
 * a `## Prior Handoffs` section so a developer task can read what the
 * architect produced earlier in the same run, etc.
 *
 * This module owns the read + render contract; the walker just calls these
 * two helpers. Keeping them server-side (not in the orchestrator package)
 * means the orchestrator's package boundary stays free of memory-mcp
 * details until the wiring is done.
 *
 * Wiring (done): the READ path is live — `runtime.ts` wires a
 * `WalkerDeps.handoffsForNode` closure over `loadHandoffsForNode` +
 * `renderHandoffsSection`; the walker calls it once per task dispatch with
 * the node's transitive dependency closure, so hand-offs are read fresh
 * per-dispatch and scoped to actual upstream tasks. The WRITE path is also
 * live: the walker calls `WalkerDeps.writeHandoff` on task completion, which
 * `runtime.ts` wires to `writeProjectMemoryEntry`
 * (key `handoff/<role>/<taskId>`).
 */
import { readProjectMemoryEntries, type ProjectMemoryEntry } from '@wisp/memory-mcp';

export interface Handoff {
  taskId: string;
  role: string;
  prompt: string;
  completedAt: string;
  status: string;
  filesChanged?: number;
  branch?: string;
}

/** A loaded hand-off paired with the SQLite updated_at timestamp. */
export interface LoadedHandoff extends Handoff {
  updatedAt: number;
}

const HANDOFF_KEY_RE = /^handoff\//;

/** Shared read+parse pipeline: every well-formed `handoff/*` row, oldest-first. */
function readParsedHandoffs(args: { dataDir: string; projectId: string }): LoadedHandoff[] {
  const entries = readProjectMemoryEntries({
    dataDir: args.dataDir,
    projectId: args.projectId,
  });
  return entries
    .filter((e: ProjectMemoryEntry) => HANDOFF_KEY_RE.test(e.key))
    .map(safeParseHandoff)
    .filter((h: LoadedHandoff | null): h is LoadedHandoff => h !== null)
    .sort((a: LoadedHandoff, b: LoadedHandoff) => a.updatedAt - b.updatedAt);
}

function safeParseHandoff(entry: ProjectMemoryEntry): LoadedHandoff | null {
  try {
    const parsed = JSON.parse(entry.value) as Partial<Handoff>;
    if (
      typeof parsed.taskId !== 'string' ||
      typeof parsed.role !== 'string' ||
      typeof parsed.prompt !== 'string'
    ) {
      return null;
    }
    return {
      taskId: parsed.taskId,
      role: parsed.role,
      prompt: parsed.prompt,
      completedAt: typeof parsed.completedAt === 'string' ? parsed.completedAt : '',
      status: typeof parsed.status === 'string' ? parsed.status : 'done',
      filesChanged: typeof parsed.filesChanged === 'number' ? parsed.filesChanged : undefined,
      branch: typeof parsed.branch === 'string' ? parsed.branch : undefined,
      updatedAt: entry.updatedAt,
    };
  } catch {
    return null;
  }
}

/**
 * Load every well-formed `handoff/*` row from the per-project memory DB,
 * oldest-first (sort by SQLite updated_at). Returns at most `limit` entries,
 * which the walker should set to 15 by default to keep prompts compact.
 *
 * Unparseable rows are skipped silently — a broken hand-off shouldn't block
 * downstream tasks.
 */
export function loadHandoffsForProject(args: {
  dataDir: string;
  projectId: string;
  limit?: number;
}): LoadedHandoff[] {
  const handoffs = readParsedHandoffs(args);
  const limit = args.limit ?? 15;
  // Tail-slice when over the cap so the most recent N survive (older entries
  // are likelier to be stale memory from prior runs and less useful).
  return handoffs.length <= limit ? handoffs : handoffs.slice(-limit);
}

/**
 * Per-node variant of {@link loadHandoffsForProject} for the walker's
 * `handoffsForNode` resolver: only hand-offs written by the node's transitive
 * dependency closure (matched by task id OR role) are returned, oldest-first,
 * tail-sliced to `limit` (default 10) so the most recent entries survive.
 * Empty dep lists → empty result (nothing upstream, nothing to inject).
 */
export function loadHandoffsForNode(args: {
  dataDir: string;
  projectId: string;
  depTaskIds: string[];
  depRoles: string[];
  limit?: number;
}): LoadedHandoff[] {
  const depTaskIds = new Set(args.depTaskIds);
  const depRoles = new Set(args.depRoles);
  const handoffs = readParsedHandoffs(args).filter(
    (h) => depTaskIds.has(h.taskId) || depRoles.has(h.role),
  );
  const limit = args.limit ?? 10;
  return handoffs.length <= limit ? handoffs : handoffs.slice(-limit);
}

/**
 * Render a list of hand-offs as a markdown section appended to a task prompt.
 * Empty list → empty string so the caller can drop the section entirely
 * without an awkward "## Prior Handoffs\n(none)".
 */
export function renderHandoffsSection(handoffs: Handoff[]): string {
  if (handoffs.length === 0) return '';
  const lines = handoffs.map((h) => {
    const short = h.prompt.length > 140 ? `${h.prompt.slice(0, 140)}…` : h.prompt;
    const flat = short.replace(/\s+/g, ' ').trim();
    return `- **${h.role}** (${h.taskId}): ${flat}`;
  });
  return `## Prior Handoffs\n${lines.join('\n')}`;
}
