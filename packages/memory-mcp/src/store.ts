import Database from 'better-sqlite3';
import { mkdirSync } from 'node:fs';
import path from 'node:path';

export interface MemoryListEntry {
  key: string;
  size: number;
}

/**
 * SQLite-backed key/value store for the memory-mcp server. Two scopes coexist:
 *
 *   - run-scoped (default) — one DB file per run at <dataDir>/memory/<runId>.db.
 *     Set by the runtime via the HARNESS_MEMORY_DB env var.
 *   - project-scoped (v1.14) — one DB file per project at
 *     <dataDir>/memory/project-<projectId>.db. Resolved on demand when a tool
 *     call carries `scope: 'project'`. The runtime exports HARNESS_PROJECT_ID
 *     so the per-task subprocess can address the right project DB.
 *
 * WAL mode tolerates the parallel-task case where multiple subprocesses might
 * read at once; the harness writes through a single per-task subprocess so
 * contention is low.
 */
export class MemoryStore {
  private readonly db: Database.Database;

  constructor(filePath: string) {
    this.db = new Database(filePath);
    this.db.pragma('journal_mode = WAL');
    // Per-run / per-project memory.db is opened by N parallel task subprocesses
    // (each one spawns its own memory-mcp server pointing at the same file)
    // under the pool's maxParallel concurrency. WAL serializes writes, but
    // better-sqlite3's default busy_timeout is 0 — the second writer's
    // `INSERT ON CONFLICT` would throw `SQLITE_BUSY` immediately on lock
    // contention, surfacing as a tool error to the agent. Five seconds of
    // retry covers any reasonable serialized-write window without making
    // genuinely deadlocked operations hang forever.
    this.db.pragma('busy_timeout = 5000');
    this.db.exec(
      `CREATE TABLE IF NOT EXISTS kv (
         key TEXT PRIMARY KEY,
         value TEXT NOT NULL,
         updated_at INTEGER NOT NULL
       )`,
    );
  }

  set(key: string, value: string): void {
    this.db
      .prepare(
        `INSERT INTO kv (key, value, updated_at) VALUES (?, ?, ?)
         ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`,
      )
      .run(key, value, Date.now());
  }

  get(key: string): string | null {
    const row = this.db.prepare(`SELECT value FROM kv WHERE key = ?`).get(key) as
      | { value: string }
      | undefined;
    return row?.value ?? null;
  }

  list(): MemoryListEntry[] {
    // Use octet_length (UTF-8 byte length), not length() (character count).
    // The set tool's per-value cap is enforced in BYTES via Buffer.byteLength,
    // so the size we report here must also be in bytes — otherwise a CJK
    // value that occupies 64 KiB on disk would list as ~21K characters and
    // mislead any consumer estimating storage budget.
    return this.db
      .prepare(`SELECT key, octet_length(value) AS size FROM kv ORDER BY key ASC`)
      .all() as MemoryListEntry[];
  }

  /**
   * Return every (key, value, updated_at) row. Used by the handoff loader to
   * render prior task hand-offs into a subsequent task's prompt. Not exposed
   * as a tool — too high-fanout for an agent to want.
   */
  entries(): Array<{ key: string; value: string; updatedAt: number }> {
    return this.db
      .prepare(`SELECT key, value, updated_at AS updatedAt FROM kv ORDER BY updated_at ASC`)
      .all() as Array<{ key: string; value: string; updatedAt: number }>;
  }

  delete(key: string): boolean {
    const result = this.db.prepare(`DELETE FROM kv WHERE key = ?`).run(key);
    return result.changes > 0;
  }

  close(): void {
    this.db.close();
  }
}

/**
 * Resolve the DB file path for a given scope.
 *
 * - run scope: caller provides the path directly (the server boots with one
 *   path from HARNESS_MEMORY_DB). The path is opaque to this helper.
 * - project scope: derived from `<dataDir>/memory/project-<projectId>.db`.
 *   The runtime guarantees `dataDir` and `projectId` are both set when the
 *   project-scoped tools are reachable; absence is a hard error so we never
 *   silently write to a default location.
 */
const PROJECT_ID_RE = /^[a-zA-Z0-9_-]+$/;

export function resolveProjectDbPath(args: { dataDir: string; projectId: string }): string {
  if (!args.dataDir) throw new Error('resolveProjectDbPath: dataDir is required');
  if (!args.projectId) throw new Error('resolveProjectDbPath: projectId is required');
  if (!PROJECT_ID_RE.test(args.projectId)) {
    throw new Error(
      `resolveProjectDbPath: invalid projectId ${JSON.stringify(args.projectId)} — must match ${PROJECT_ID_RE}`,
    );
  }
  const dataDirAbs = path.resolve(args.dataDir);
  const memDir = path.join(dataDirAbs, 'memory');
  mkdirSync(memDir, { recursive: true });
  return path.join(memDir, `project-${args.projectId}.db`);
}

/**
 * Small LRU keyed by db path so the server doesn't reopen the same SQLite
 * file on every tool call. The CLI subprocess is short-lived (one per task)
 * so the cache stays tiny — capacity 8 is plenty.
 */
const STORE_CACHE_MAX = 8;
const storeCache = new Map<string, MemoryStore>();

function cachedStore(dbPath: string): MemoryStore {
  const hit = storeCache.get(dbPath);
  if (hit) {
    // refresh recency
    storeCache.delete(dbPath);
    storeCache.set(dbPath, hit);
    return hit;
  }
  const store = new MemoryStore(dbPath);
  storeCache.set(dbPath, store);
  while (storeCache.size > STORE_CACHE_MAX) {
    const oldestKey = storeCache.keys().next().value as string | undefined;
    if (!oldestKey) break;
    const old = storeCache.get(oldestKey);
    storeCache.delete(oldestKey);
    try {
      old?.close();
    } catch {
      // best-effort
    }
  }
  return store;
}

/** Close + drop every cached store. Used by tests and by graceful shutdown. */
export function closeAllStores(): void {
  for (const s of storeCache.values()) {
    try {
      s.close();
    } catch {
      // best-effort
    }
  }
  storeCache.clear();
}

export interface ResolveStoreArgs {
  scope: 'run' | 'project';
  /** Run-scoped DB path. Required when scope === 'run'. */
  runDbPath?: string;
  /** Data dir for derived project DBs. Required when scope === 'project'. */
  dataDir?: string;
  /** Project id. Required when scope === 'project'. */
  projectId?: string;
}

/**
 * Resolve (and cache) the right MemoryStore for the requested scope. Throws
 * if the inputs for the chosen scope are missing — better to fail loudly than
 * silently write to the wrong DB.
 */
export function resolveStore(args: ResolveStoreArgs): MemoryStore {
  if (args.scope === 'project') {
    if (!args.dataDir || !args.projectId) {
      throw new Error(
        'resolveStore: project scope requires WISP_DATA_DIR and HARNESS_PROJECT_ID to be set in the subprocess environment',
      );
    }
    const p = resolveProjectDbPath({ dataDir: args.dataDir, projectId: args.projectId });
    return cachedStore(p);
  }
  if (!args.runDbPath) {
    throw new Error('resolveStore: run scope requires runDbPath');
  }
  return cachedStore(args.runDbPath);
}
