/**
 * consolidate-memory — disabled stub. Will become operational once the
 * memory-mcp package exposes a dedupe API; until then the worker does
 * nothing. Kept registered (with `enabled: false`) so the slot is
 * reserved in /api/workers without surprising users when it lights up.
 */
export async function consolidateMemory(): Promise<{ note: string }> {
  return { note: 'consolidate-memory: no-op until memory-mcp dedupe API exists' };
}
