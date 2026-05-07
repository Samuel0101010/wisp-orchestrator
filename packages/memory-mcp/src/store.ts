import Database from 'better-sqlite3';

export interface MemoryListEntry {
  key: string;
  size: number;
}

/**
 * SQLite-backed key/value store for the memory-mcp server. One DB file per run
 * (path is set by the runtime via the HARNESS_MEMORY_DB env var). WAL mode
 * tolerates the parallel-task case where multiple subprocesses might read at
 * once; the harness writes through a single per-task subprocess so contention
 * is low.
 */
export class MemoryStore {
  private readonly db: Database.Database;

  constructor(path: string) {
    this.db = new Database(path);
    this.db.pragma('journal_mode = WAL');
    // Per-run memory.db is opened by N parallel task subprocesses (each one
    // spawns its own memory-mcp server pointing at the same file) under the
    // pool's maxParallel concurrency. WAL serializes writes, but better-
    // sqlite3's default busy_timeout is 0 — the second writer's `INSERT ON
    // CONFLICT` would throw `SQLITE_BUSY` immediately on lock contention,
    // surfacing as a tool error to the agent. Five seconds of retry covers
    // any reasonable serialized-write window without making genuinely
    // deadlocked operations hang forever.
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

  delete(key: string): boolean {
    const result = this.db.prepare(`DELETE FROM kv WHERE key = ?`).run(key);
    return result.changes > 0;
  }

  close(): void {
    this.db.close();
  }
}
