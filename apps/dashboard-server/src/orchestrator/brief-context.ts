import fs from 'node:fs';
import path from 'node:path';
import type { ProjectBrief } from '@wisp/schemas';

// Cap the PRD content fed into the planner prompt. The planner runs in an empty
// mkdtemp dir, so the prompt is the ONLY channel to the planner LLM — a very
// long PRD would otherwise blow the prompt budget.
const MAX_PRD_PROMPT_CHARS = 12_000;

// Cap the per-agent brief summary. Unlike the planner PRD (one prompt), this
// block is injected into EVERY node's prompt × every retry, so it must stay
// tight — the six structured fields only, never the full PRD. This is a HARD
// cap: the final returned block (including any truncation marker) is always
// ≤ this many chars.
export const MAX_AGENT_BRIEF_CHARS = 1_500;

// Appended when the block overflows MAX_AGENT_BRIEF_CHARS. Its length is
// reserved out of the slice budget so the final string never exceeds the cap.
const AGENT_BRIEF_TRUNCATION_MARKER = '\n\n… [truncated]';

/**
 * Read the rendered requirements document (docs/PRD.md) for a project so its
 * full detail reaches the planner LLM. Returns null — never throws — when the
 * brief has no prdPath or the file is missing/unreadable, so unbriefed and
 * iteration plan paths keep working off the concise 6-field fallback. Caps the
 * content to MAX_PRD_PROMPT_CHARS with a clear truncation marker.
 */
export function readPrdForPlanner(repoPath: string, prdPath: string | null): string | null {
  if (!prdPath) return null;
  // Defense in depth: prdPath is expected to be repo-relative. A DB-injected
  // absolute path would let path.join escape repoPath and leak an arbitrary
  // file into the planner prompt — reject it outright.
  if (path.isAbsolute(prdPath)) return null;
  try {
    const abs = path.join(repoPath, prdPath);
    const raw = fs.readFileSync(abs, 'utf8').trim();
    if (raw.length === 0) return null;
    if (raw.length > MAX_PRD_PROMPT_CHARS) {
      return `${raw.slice(0, MAX_PRD_PROMPT_CHARS)}\n\n… [truncated]`;
    }
    return raw;
  } catch {
    return null;
  }
}

/**
 * Assemble the planner-context sections for a project brief: the concise
 * 6-field summary plus, when available, the full rendered PRD. Shared by the
 * plan route and the QA-replan path so an automated replan keeps the brief
 * instead of dropping it. Returns [] when there is no brief content to add.
 */
export function buildBriefContextSections(
  repoPath: string,
  brief: ProjectBrief | null | undefined,
): string[] {
  if (!brief) return [];
  const sections: string[] = [];
  const briefLines: string[] = [];
  if (brief.targetAudience) briefLines.push(`Target audience: ${brief.targetAudience}`);
  if (brief.successCriteria) briefLines.push(`Success criteria: ${brief.successCriteria}`);
  if (brief.designPrefs) briefLines.push(`Design preferences: ${brief.designPrefs}`);
  if (brief.platform) briefLines.push(`Platform: ${brief.platform}`);
  if (brief.constraints) briefLines.push(`Constraints: ${brief.constraints}`);
  if (brief.deadline)
    briefLines.push(`Deadline: ${new Date(brief.deadline).toISOString().slice(0, 10)}`);
  if (briefLines.length > 0) {
    sections.push(`## Project brief (from requirements interview)\n\n` + briefLines.join('\n'));
  }
  // In ADDITION to the concise 6-field summary above, feed the full rendered
  // requirements document into the planner prompt. The planner runs in an empty
  // mkdtemp dir and can't read project files, so this is the only way the
  // detailed PRD reaches it. Skipped silently when absent — see readPrdForPlanner.
  const prdContent = readPrdForPlanner(repoPath, brief.prdPath);
  if (prdContent) {
    sections.push(`## Full brief (requirements document)\n\n${prdContent}`);
  }
  return sections;
}

/**
 * Build a COMPACT brief summary for the executing agents — the six structured
 * fields only, capped to MAX_AGENT_BRIEF_CHARS. Unlike buildBriefContextSections
 * (planner-facing, includes the full PRD), this is injected into every node's
 * prompt, so it deliberately omits the PRD to stay token-cheap. Returns a
 * "## Project context" block, or null when the brief is absent or all six
 * fields are empty (so the walker emits no empty section).
 */
export function buildBriefSummaryForAgents(brief: ProjectBrief | null | undefined): string | null {
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
    // Reserve room for the marker so the final block stays ≤ MAX_AGENT_BRIEF_CHARS.
    const sliceLen = MAX_AGENT_BRIEF_CHARS - AGENT_BRIEF_TRUNCATION_MARKER.length;
    block = `${block.slice(0, sliceLen)}${AGENT_BRIEF_TRUNCATION_MARKER}`;
  }
  return block;
}
