/**
 * Frontend mirror of the orchestrator's composeTaskPrompt logic. Keeping a
 * separate browser-safe copy here lets the Composed Prompt Preview dialog
 * show users what an agent will actually receive, without pulling node-only
 * orchestrator deps into the web bundle.
 *
 * If the canonical composeTaskPrompt in packages/orchestrator/src/walker.ts
 * changes shape, update this file to match. The preview is a guide, not a
 * source of truth.
 */

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
): string {
  const parts: string[] = [];
  parts.push(`# Goal\n${goal}`);
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
