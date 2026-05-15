import { MemoryStore, resolveProjectDbPath } from './store.js';

/**
 * Thin convenience wrappers around the project-scoped MemoryStore for callers
 * outside the MCP server process (e.g. the dashboard-server walker that wants
 * to write hand-off entries directly, without round-tripping through the MCP
 * stdio transport). These open + close the SQLite handle per call — fine for
 * the walker's low write rate (one hand-off per task completion). For higher-
 * frequency access, prefer the cached `resolveStore({ scope: 'project' })`.
 */
export interface ProjectMemoryEntry {
  key: string;
  value: string;
  updatedAt: number;
}

export function writeProjectMemoryEntry(args: {
  dataDir: string;
  projectId: string;
  key: string;
  value: string;
}): void {
  const dbPath = resolveProjectDbPath({ dataDir: args.dataDir, projectId: args.projectId });
  const store = new MemoryStore(dbPath);
  try {
    store.set(args.key, args.value);
  } finally {
    store.close();
  }
}

export function readProjectMemoryEntries(args: {
  dataDir: string;
  projectId: string;
}): ProjectMemoryEntry[] {
  const dbPath = resolveProjectDbPath({ dataDir: args.dataDir, projectId: args.projectId });
  const store = new MemoryStore(dbPath);
  try {
    return store.entries();
  } finally {
    store.close();
  }
}
