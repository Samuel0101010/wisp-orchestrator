/**
 * Reusable system-prompt fragments. Inserted into a role's systemPrompt
 * textarea via SnippetMenu so users don't have to remember the conventions
 * each time.
 */

export interface Snippet {
  id: string;
  title: string;
  category: 'tone' | 'memory' | 'verification' | 'discipline';
  body: string;
}

export const SNIPPET_CATEGORY_LABELS: Record<Snippet['category'], string> = {
  tone: 'Tone',
  memory: 'Memory MCP',
  verification: 'Verification',
  discipline: 'Discipline',
};

export const PROMPT_SNIPPETS: Snippet[] = [
  {
    id: 'tone-terse',
    title: 'Be terse',
    category: 'tone',
    body: 'Be terse. Report only what is actionable. No preambles, no summaries that the user can read in the diff.',
  },
  {
    id: 'tone-evidence',
    title: 'Evidence-based reporting',
    category: 'tone',
    body: 'Report concerns with concrete evidence: command output, file paths, line numbers. Do not describe a problem in the abstract when you can show it.',
  },
  {
    id: 'memory-write-arch',
    title: 'Write decisions to arch.* keys',
    category: 'memory',
    body: 'Drop key decisions into shared memory under arch.* keys via mcp__wisp-memory__memory_set so downstream developers can read them via mcp__wisp-memory__memory_get.',
  },
  {
    id: 'memory-read-arch',
    title: 'Read arch.* before implementing',
    category: 'memory',
    body: "Call mcp__wisp-memory__memory_get for 'arch.spec' and similar arch.* keys before implementing.",
  },
  {
    id: 'verify-build-test-lint',
    title: 'Run build / test / lint',
    category: 'verification',
    body: 'Run pnpm typecheck, pnpm test, and pnpm lint. Report pass/concerns/fail with concrete evidence.',
  },
  {
    id: 'verify-no-mock',
    title: 'Do not modify code (QA)',
    category: 'verification',
    body: 'Do not modify code. If a test is flaky or environmental, mark concerns and explain. If the implementation diverges from the architecture, flag it as a concern with specifics.',
  },
  {
    id: 'discipline-no-refactor',
    title: 'No adjacent refactor',
    category: 'discipline',
    body: 'Do not refactor adjacent code. Make the smallest change that satisfies the acceptance criteria — match existing style, naming, and formatting.',
  },
  {
    id: 'discipline-ask-on-ambiguity',
    title: 'Surface ambiguity',
    category: 'discipline',
    body: 'If a constraint is unclear, surface the question in your output rather than guessing.',
  },
  {
    id: 'discipline-clean-orphans',
    title: 'Clean orphans your change creates',
    category: 'discipline',
    body: 'Clean orphans your change introduces (unused imports, locals, functions newly unused). Do not delete pre-existing dead code unless asked.',
  },
];
