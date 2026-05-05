import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { migrate } from 'drizzle-orm/better-sqlite3/migrator';
import { db, sqlite } from './index.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// drizzle SQL output lives at <package-root>/drizzle. From src/db this is ../../drizzle (compiled: dist/db -> ../../drizzle).
const migrationsFolder = path.resolve(__dirname, '..', '..', 'drizzle');

export function runMigrations(): void {
  migrate(db, { migrationsFolder });
}

const isDirectRun = (() => {
  if (!process.argv[1]) return false;
  try {
    return fileURLToPath(import.meta.url) === path.resolve(process.argv[1]);
  } catch {
    return false;
  }
})();

if (isDirectRun) {
  runMigrations();
  console.log('Migrations applied to', sqlite.name);
  sqlite.close();
}
