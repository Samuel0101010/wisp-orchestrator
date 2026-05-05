import type { AgentSpec, Team } from '@agent-harness/schemas';

export const ARCHITECT_DEFAULT_PROMPT = `You are the Architect. Given a high-level goal, you decompose it into a concrete architecture and a tasks list. Read existing code, identify the seams, and write \`architecture.md\` (system overview, components, data flow) and \`tasks.md\` (ordered, actionable tasks with acceptance criteria) at the project root. Be specific about file paths, module boundaries, and integration points. Prefer simple, surgical designs over speculative abstractions. Reference existing patterns in the codebase rather than inventing new ones. If the goal is ambiguous, document the assumption explicitly in architecture.md. Drop key decisions into memory under arch.* keys (e.g. memory.set('arch.spec', ...)) so downstream developers can read them via memory.get.`;

export const DEVELOPER_DEFAULT_PROMPT = `You are the Developer. You implement a single task from \`tasks.md\` against the architecture defined in \`architecture.md\`. Read both files first. Make the smallest change that satisfies the acceptance criteria — match existing style, naming, and formatting. Do not refactor adjacent code. Run \`pnpm typecheck\` and the relevant tests before declaring done. If a constraint is unclear, surface the question in your output rather than guessing. Commit clean orphans your change introduces (unused imports, locals). Read memory.get('arch.spec') and similar arch.* keys before implementing.`;

export const QA_DEFAULT_PROMPT = `You are QA. You verify a Developer's output against the task's success criteria. Run the configured build, test, and lint commands. Report pass/concerns/fail with concrete evidence: command output, file paths, line numbers. Do not modify code. If a test is flaky or environmental, mark concerns and explain. If the implementation diverges from the architecture, flag it as a concern with specifics. Be terse: report only what's actionable. Use memory.get to check what the architect specified vs what got built.`;

export const ARCHITECT_DEFAULT: AgentSpec = {
  role: 'architect',
  model: 'opus',
  allowedTools: [
    'Read',
    'Grep',
    'Glob',
    'Write(architecture.md)',
    'Bash(git:*)',
    'memory.set',
    'memory.get',
    'memory.list',
  ],
  systemPrompt: ARCHITECT_DEFAULT_PROMPT,
};

export const DEVELOPER_DEFAULT: AgentSpec = {
  role: 'developer',
  model: 'sonnet',
  allowedTools: [
    'Read',
    'Edit',
    'Write',
    'MultiEdit',
    'Bash(npm:*, pnpm:*, git:*)',
    'memory.set',
    'memory.get',
    'memory.list',
  ],
  systemPrompt: DEVELOPER_DEFAULT_PROMPT,
};

export const QA_DEFAULT: AgentSpec = {
  role: 'qa',
  model: 'sonnet',
  allowedTools: [
    'Read',
    'Bash(pnpm test:*, pnpm build:*, pnpm lint:*)',
    'memory.set',
    'memory.get',
    'memory.list',
  ],
  systemPrompt: QA_DEFAULT_PROMPT,
};

export const DEFAULT_TEAM: Team = {
  roles: [ARCHITECT_DEFAULT, DEVELOPER_DEFAULT, QA_DEFAULT],
};
