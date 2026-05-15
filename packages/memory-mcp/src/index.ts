export {
  MemoryStore,
  resolveStore,
  resolveProjectDbPath,
  closeAllStores,
  type MemoryListEntry,
  type ResolveStoreArgs,
} from './store.js';
export { tools, findTool, type ToolEntry, type ToolName, type ScopeResolver } from './tools.js';
export {
  writeProjectMemoryEntry,
  readProjectMemoryEntries,
  type ProjectMemoryEntry,
} from './project-store.js';

export const PACKAGE_NAME = '@agent-harness/memory-mcp';
