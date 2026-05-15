import { z } from 'zod';
import type { MemoryStore } from './store.js';

/**
 * Each tool entry carries its description, its Zod input schema (used both for
 * server-side validation and for emitting JSON Schema to MCP clients via
 * zod-to-json-schema), and a handler. The handler receives a `resolver` that
 * yields the right MemoryStore for the requested scope (run vs. project) —
 * the server decides how to map scope → DB path; the tool layer just asks for
 * a store.
 */
export type ScopeResolver = (scope: 'run' | 'project') => MemoryStore;

export interface ToolEntry<TInput, TOutput> {
  description: string;
  inputSchema: z.ZodType<TInput>;
  handle: (resolve: ScopeResolver, args: TInput) => TOutput;
}

// Per-value cap. memory_set is for short specs / handoff notes between roles,
// not for shipping multi-MB blobs. Without a cap a runaway agent could exhaust
// the MCP response-frame buffer and inflate the per-run SQLite file unboundedly.
// Enforced as UTF-8 byte length (not character count) because that is what
// determines on-disk size — a 64K-character CJK string would otherwise consume
// ~192KB on disk despite passing a character-count check.
const VALUE_MAX_BYTES = 64 * 1024;

const scopeField = z.enum(['run', 'project']).default('run').optional();

const setSchema = z.object({
  key: z.string().min(1, 'key must not be empty'),
  value: z
    .string()
    .refine(
      (v) => Buffer.byteLength(v, 'utf8') <= VALUE_MAX_BYTES,
      `value exceeds ${VALUE_MAX_BYTES}-byte limit`,
    ),
  scope: scopeField,
});
type SetInput = z.infer<typeof setSchema>;

const getSchema = z.object({
  key: z.string().min(1, 'key must not be empty'),
  scope: scopeField,
});
type GetInput = z.infer<typeof getSchema>;

const listSchema = z.object({
  scope: scopeField,
});
type ListInput = z.infer<typeof listSchema>;

const deleteSchema = z.object({
  key: z.string().min(1, 'key must not be empty'),
  scope: scopeField,
});
type DeleteInput = z.infer<typeof deleteSchema>;

function effectiveScope(s: 'run' | 'project' | undefined): 'run' | 'project' {
  return s ?? 'run';
}

export const tools = {
  'memory.set': {
    description:
      'Persist a string value under a dotted key (e.g. arch.spec). Overwrites any prior value at the same key. Pass scope="project" to write into the per-project memory (shared across all runs of that project); default scope="run" keeps the value scoped to the current run.',
    inputSchema: setSchema,
    handle: (resolve: ScopeResolver, args: SetInput) => {
      resolve(effectiveScope(args.scope)).set(args.key, args.value);
      return { ok: true } as const;
    },
  } as ToolEntry<SetInput, { ok: true }>,
  'memory.get': {
    description:
      'Read the value previously set under key. Returns { value: null } when the key is absent. Pass scope="project" to read from per-project memory.',
    inputSchema: getSchema,
    handle: (resolve: ScopeResolver, args: GetInput) => ({
      value: resolve(effectiveScope(args.scope)).get(args.key),
    }),
  } as ToolEntry<GetInput, { value: string | null }>,
  'memory.list': {
    description:
      'List all keys with their UTF-8 byte sizes, sorted by key ascending. Pass scope="project" to list per-project memory.',
    inputSchema: listSchema,
    handle: (resolve: ScopeResolver, args: ListInput) => ({
      entries: resolve(effectiveScope(args.scope)).list(),
    }),
  } as ToolEntry<ListInput, { entries: Array<{ key: string; size: number }> }>,
  'memory.delete': {
    description:
      'Remove a key. Returns { deleted: true } if a row was removed, { deleted: false } if the key was already absent. Pass scope="project" to delete from per-project memory.',
    inputSchema: deleteSchema,
    handle: (resolve: ScopeResolver, args: DeleteInput) => ({
      deleted: resolve(effectiveScope(args.scope)).delete(args.key),
    }),
  } as ToolEntry<DeleteInput, { deleted: boolean }>,
} as const;

export type ToolName = keyof typeof tools;

/**
 * Look up a tool by name with no `any` cast at the call site. Returns null
 * when the name is unknown so the MCP server can produce a clean MethodNotFound
 * style error rather than throwing.
 */
export function findTool(name: string): ToolEntry<unknown, unknown> | null {
  if (Object.prototype.hasOwnProperty.call(tools, name)) {
    // The registry is `as const`, so TypeScript narrows when name is a known
    // key. We've already guarded with hasOwnProperty.
    return tools[name as ToolName] as unknown as ToolEntry<unknown, unknown>;
  }
  return null;
}
