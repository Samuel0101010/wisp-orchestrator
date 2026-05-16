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
 * Wiring TODO(phase-6-followup): the walker doesn't yet call
 * `loadHandoffsForProject` + `renderHandoffsSection` when composing a task's
 * prompt, and it doesn't yet call `writeProjectMemoryEntry` on task
 * completion. The helpers are exported + tested; the integration point lives
 * in `packages/orchestrator/src/walker.ts` and will be wired in v1.14.x when
 * the walker's WalkerDeps gain a `projectId` + `dataDir` field.
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
  const entries = readProjectMemoryEntries({
    dataDir: args.dataDir,
    projectId: args.projectId,
  });
  const handoffs = entries
    .filter((e: ProjectMemoryEntry) => HANDOFF_KEY_RE.test(e.key))
    .map(safeParseHandoff)
    .filter((h: LoadedHandoff | null): h is LoadedHandoff => h !== null)
    .sort((a: LoadedHandoff, b: LoadedHandoff) => a.updatedAt - b.updatedAt);
  const limit = args.limit ?? 15;
  // Tail-slice when over the cap so the most recent N survive (older entries
  // are likelier to be stale memory from prior runs and less useful).
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
