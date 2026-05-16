/**
 * Catalog of tools that claude -p subprocesses can be granted via the
 * `allowedTools` array. Used by ToolMultiSelect to give users a discoverable
 * picker instead of a free-text comma-separated field where typos silently
 * fail at runtime.
 *
 * Names are passed through to claude -p verbatim. Adding a tool here does NOT
 * make it available to claude — it only makes it pickable in the UI. The
 * canonical set lives in the Claude Code documentation; we mirror the most
 * common ones.
 */

export interface ToolEntry {
  /** Exact string passed to claude -p. */
  name: string;
  /** One-line description shown in the picker. */
  description: string;
}

export interface ToolCategory {
  id: string;
  title: string;
  description: string;
  tools: ToolEntry[];
}

export const TOOL_CATALOG: ToolCategory[] = [
  {
    id: 'fs-read',
    title: 'Filesystem — read',
    description: 'Read access to project files. Safe to grant by default.',
    tools: [
      { name: 'Read', description: 'Read a single file by absolute path.' },
      { name: 'Glob', description: 'Find files by pattern (e.g. **/*.ts).' },
      { name: 'Grep', description: 'Search file contents with regex.' },
    ],
  },
  {
    id: 'fs-write',
    title: 'Filesystem — write',
    description: 'Modify files. Grant only to roles that need to ship code.',
    tools: [
      { name: 'Edit', description: 'Apply exact string replacements to a file.' },
      { name: 'Write', description: 'Create or overwrite a file (full content).' },
      { name: 'MultiEdit', description: 'Multiple edits to one file in one call.' },
      { name: 'NotebookEdit', description: 'Edit Jupyter notebook cells.' },
    ],
  },
  {
    id: 'memory',
    title: 'Memory MCP (per-run shared store)',
    description: 'Cross-task context via the wisp-memory MCP server.',
    tools: [
      {
        name: 'mcp__wisp-memory__memory_set',
        description: 'Persist a string under a key (e.g. arch.spec).',
      },
      {
        name: 'mcp__wisp-memory__memory_get',
        description: 'Read a previously-set value.',
      },
      {
        name: 'mcp__wisp-memory__memory_list',
        description: 'List all keys with their value sizes.',
      },
      {
        name: 'mcp__wisp-memory__memory_delete',
        description: 'Remove a key from memory.',
      },
    ],
  },
  {
    id: 'bash-common',
    title: 'Bash — common patterns',
    description: 'Limit shell access to what the role actually needs.',
    tools: [
      { name: 'Bash(git:*)', description: 'Any git subcommand (status, log, branch).' },
      { name: 'Bash(npm:*, pnpm:*)', description: 'Node package manager commands.' },
      { name: 'Bash(npm test:*, pnpm test:*)', description: 'Test runners only.' },
      { name: 'Bash(npm build:*, pnpm build:*)', description: 'Build commands only.' },
      { name: 'Bash(npm lint:*, pnpm lint:*)', description: 'Lint commands only.' },
      { name: 'Bash(python:*, pip:*, pytest:*)', description: 'Python toolchain.' },
    ],
  },
  {
    id: 'misc',
    title: 'Other',
    description: 'Specialized tools that most teams will never need.',
    tools: [
      { name: 'Task', description: 'Spawn a sub-agent to handle a discrete subtask.' },
      { name: 'WebFetch', description: 'Fetch a URL and parse its content.' },
      { name: 'WebSearch', description: 'Search the web (gated by Anthropic policy).' },
    ],
  },
];

export const ALL_CATALOG_TOOL_NAMES: Set<string> = new Set(
  TOOL_CATALOG.flatMap((c) => c.tools.map((t) => t.name)),
);
