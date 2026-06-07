import fs from 'node:fs';
import path from 'node:path';
import Database, { type Database as DatabaseType } from 'better-sqlite3';
import { drizzle, type BetterSQLite3Database } from 'drizzle-orm/better-sqlite3';
import { env } from '../env.js';

// NOTE: the better-sqlite3 native binding is loaded + ABI-validated by
// ./preflight.js (imported first in server.ts), so a mismatch surfaces as a
// clear message before this module's static import is reached at server boot.

function ensureDir(dir: string): void {
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }
}

ensureDir(env.WISP_DATA_DIR);
const dbPath = path.join(env.WISP_DATA_DIR, 'harness.db');

export const sqlite: DatabaseType = new Database(dbPath);
sqlite.pragma('journal_mode = WAL');
sqlite.pragma('foreign_keys = ON');
sqlite.pragma('synchronous = NORMAL');
sqlite.pragma('busy_timeout = 5000');

export const db: BetterSQLite3Database = drizzle(sqlite);
