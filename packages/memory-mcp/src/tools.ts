import { z } from 'zod';
import type { MemoryStore } from './store.js';

/**
 * Each tool entry carries its description, its Zod input schema (used both for
 * server-side validation and for emitting JSON Schema to MCP clients via
 * zod-to-json-schema), and a handler that runs against the per-run
 * MemoryStore.
 */
export interface ToolEntry<TInput, TOutput> {
  description: string;
  inputSchema: z.ZodType<TInput>;
  handle: (store: MemoryStore, args: TInput) => TOutput;
}

// Per-value cap. memory_set is for short specs / handoff notes between roles,
// not for shipping multi-MB blobs. Without a cap a runaway agent could exhaust
// the MCP response-frame buffer and inflate the per-run SQLite file unboundedly.
const VALUE_MAX_BYTES = 64 * 1024;
const setSchema = z.object({
  key: z.string().min(1, 'key must not be empty'),
  value: z.string().max(VALUE_MAX_BYTES, `value exceeds ${VALUE_MAX_BYTES}-byte limit`),
});
type SetInput = z.infer<typeof setSchema>;

const getSchema = z.object({
  key: z.string().min(1, 'key must not be empty'),
});
type GetInput = z.infer<typeof getSchema>;

const listSchema = z.object({});
type ListInput = z.infer<typeof listSchema>;

const deleteSchema = z.object({
  key: z.string().min(1, 'key must not be empty'),
});
type DeleteInput = z.infer<typeof deleteSchema>;

export const tools = {
  'memory.set': {
    description:
      'Persist a string value under a dotted key (e.g. arch.spec). Overwrites any prior value at the same key.',
    inputSchema: setSchema,
    handle: (store: MemoryStore, args: SetInput) => {
      store.set(args.key, args.value);
      return { ok: true } as const;
    },
  } as ToolEntry<SetInput, { ok: true }>,
  'memory.get': {
    description:
      'Read the value previously set under key. Returns { value: null } when the key is absent.',
    inputSchema: getSchema,
    handle: (store: MemoryStore, args: GetInput) => ({ value: store.get(args.key) }),
  } as ToolEntry<GetInput, { value: string | null }>,
  'memory.list': {
    description: 'List all keys with their UTF-8 character-count sizes, sorted by key ascending.',
    inputSchema: listSchema,
    // eslint-disable-next-line @typescript-eslint/no-unused-vars
    handle: (store: MemoryStore, _args: ListInput) => ({ entries: store.list() }),
  } as ToolEntry<ListInput, { entries: Array<{ key: string; size: number }> }>,
  'memory.delete': {
    description:
      'Remove a key. Returns { deleted: true } if a row was removed, { deleted: false } if the key was already absent.',
    inputSchema: deleteSchema,
    handle: (store: MemoryStore, args: DeleteInput) => ({ deleted: store.delete(args.key) }),
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
