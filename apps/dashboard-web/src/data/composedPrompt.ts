/**
 * Frontend mirror of the orchestrator's composeTaskPrompt logic. Keeping a
 * separate browser-safe copy here lets the Composed Prompt Preview dialog
 * show users what an agent will actually receive, without pulling node-only
 * orchestrator deps into the web bundle.
 *
 * If the canonical composeTaskPrompt in packages/orchestrator/src/walker.ts
 * changes shape, update this file to match (it currently mirrors the goal,
 * briefContext, codebaseContext, task, success-criteria and retry sections).
 * The server-side "## Prior Handoffs" section is intentionally NOT mirrored
 * here: it is resolved per node at dispatch time (scoped to the node's
 * transitive dependency closure, 10 most recent entries, read live from the
 * project memory DB), so the browser cannot reproduce it.
 * The server-side "## Shared memory" protocol section (mcp-config.ts
 * MEMORY_PROTOCOL_SECTION, appended to briefContext at run start) is likewise
 * intentionally NOT mirrored in this browser preview.
 * The per-role "## Skills" section (AgentSpec.skills, rendered from the skill
 * registry at dispatch) is appended to the agent's SYSTEM prompt — not the
 * task prompt — so it is also not part of this preview.
 * The preview is a guide, not a source of truth.
 */

/**
 * Subset of the brief row needed to build the agent "## Project context"
 * summary. Mirrors the six structured fields of ProjectBriefRow (api/queries.ts)
 * that buildBriefSummaryForAgents consumes server-side.
 */
export interface PreviewBrief {
  targetAudience: string | null;
  successCriteria: string | null;
  designPrefs: string | null;
  platform: string | null;
  constraints: string | null;
  deadline: number | null;
}

// Mirror of brief-context.ts:MAX_AGENT_BRIEF_CHARS — keep in sync. The server
// hard-caps the per-agent brief block to this many chars.
const MAX_AGENT_BRIEF_CHARS = 1_500;
const AGENT_BRIEF_TRUNCATION_MARKER = '\n\n… [truncated]';

/**
 * Browser-safe mirror of orchestrator brief-context.ts:buildBriefSummaryForAgents.
 * Builds the SAME compact "## Project context" block (same six field labels and
 * order, same hard cap) the server injects into every agent prompt, so the
 * preview shows exactly what the agent receives. Returns null when the brief is
 * absent or all six fields are empty. Keep field labels/order/cap in sync with
 * the server function.
 */
export function buildBriefSummaryForAgentsPreview(
  brief: PreviewBrief | null | undefined,
): string | null {
  if (!brief) return null;
  const lines: string[] = [];
  if (brief.targetAudience) lines.push(`Target audience: ${brief.targetAudience}`);
  if (brief.successCriteria) lines.push(`Success criteria: ${brief.successCriteria}`);
  if (brief.designPrefs) lines.push(`Design preferences: ${brief.designPrefs}`);
  if (brief.platform) lines.push(`Platform: ${brief.platform}`);
  if (brief.constraints) lines.push(`Constraints: ${brief.constraints}`);
  if (brief.deadline)
    lines.push(`Deadline: ${new Date(brief.deadline).toISOString().slice(0, 10)}`);
  if (lines.length === 0) return null;
  let block = `## Project context\n\n${lines.join('\n')}`;
  if (block.length > MAX_AGENT_BRIEF_CHARS) {
    const sliceLen = MAX_AGENT_BRIEF_CHARS - AGENT_BRIEF_TRUNCATION_MARKER.length;
    block = `${block.slice(0, sliceLen)}${AGENT_BRIEF_TRUNCATION_MARKER}`;
  }
  return block;
}

export interface PreviewSuccessCriteria {
  preflight?: string;
  build?: string;
  test?: string;
  lint?: string;
  custom?: string;
}

export interface PreviewTaskNode {
  id: string;
  role: string;
  prompt: string;
  successCriteria: PreviewSuccessCriteria;
}

// Mirror of packages/orchestrator/src/walker.ts:truncateRetryError. Keep the
// same head/tail line counts so the preview displays exactly what the agent
// receives in retry context (otherwise users debugging a long retry would
// see more text in the preview than the agent ever sees).
const RETRY_ERROR_HEAD_LINES = 30;
const RETRY_ERROR_TAIL_LINES = 60;

function truncateRetryError(s: string): string {
  const lines = s.split(/\r?\n/);
  if (lines.length <= RETRY_ERROR_HEAD_LINES + RETRY_ERROR_TAIL_LINES + 2) return s;
  const head = lines.slice(0, RETRY_ERROR_HEAD_LINES).join('\n');
  const tail = lines.slice(-RETRY_ERROR_TAIL_LINES).join('\n');
  const omitted = lines.length - RETRY_ERROR_HEAD_LINES - RETRY_ERROR_TAIL_LINES;
  return `${head}\n[… ${omitted} lines omitted …]\n${tail}`;
}

export function composeTaskPromptPreview(
  goal: string,
  node: PreviewTaskNode,
  retryError: string | null,
  briefContext?: string,
  codebaseContext?: string,
): string {
  const parts: string[] = [];
  parts.push(`# Goal\n${goal}`);
  // Mirror of walker.ts:composeTaskPrompt — the brief "## Project context"
  // block goes right after the goal and before the task. briefContext already
  // carries its own header (see buildBriefSummaryForAgentsPreview); emit it raw,
  // guarded so empty/whitespace contributes nothing.
  if (briefContext && briefContext.trim().length > 0) {
    parts.push(briefContext);
  }
  // Mirror of walker.ts:composeTaskPrompt — the "## Existing codebase" section
  // (file tree + modify-don't-scaffold instruction) goes between the brief and
  // the task. codebaseContext already carries its own header; emit it raw,
  // omitted when empty/undefined (fresh repos).
  if (codebaseContext && codebaseContext.trim().length > 0) {
    parts.push(codebaseContext);
  }
  parts.push(`# Task: ${node.id} (${node.role})\n${node.prompt}`);
  const sc = node.successCriteria;
  const scLines: string[] = [];
  if (sc.preflight) scLines.push(`- preflight: \`${sc.preflight}\` (runs once before the rest)`);
  if (sc.build) scLines.push(`- build: \`${sc.build}\``);
  if (sc.test) scLines.push(`- test: \`${sc.test}\``);
  if (sc.lint) scLines.push(`- lint: \`${sc.lint}\``);
  if (sc.custom) scLines.push(`- custom: \`${sc.custom}\``);
  if (scLines.length > 0) {
    parts.push(`# Success criteria (must all pass)\n${scLines.join('\n')}`);
  }
  if (retryError) {
    parts.push(
      `# Retry context\nPrevious attempt failed: ${truncateRetryError(retryError)}\nPlease address and re-implement.`,
    );
  }
  return parts.join('\n\n');
}
