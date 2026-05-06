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
      `# Retry context\nPrevious attempt failed: ${retryError}\nPlease address and re-implement.`,
    );
  }
  return parts.join('\n\n');
}
