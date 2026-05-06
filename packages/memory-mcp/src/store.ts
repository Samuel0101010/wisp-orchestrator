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
    return this.db
      .prepare(`SELECT key, length(value) AS size FROM kv ORDER BY key ASC`)
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
