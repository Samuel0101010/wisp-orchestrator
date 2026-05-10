import { db } from '../../db/index.js';
import { runs } from '@agent-harness/schemas';
import { eq } from 'drizzle-orm';
import { existsSync, readdirSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

export async function autoDoc(): Promise<{ candidates: string[] }> {
  const since = Date.now() - 24 * 60 * 60 * 1000;
  const recent = db
    .select({ id: runs.id, endedAt: runs.endedAt })
    .from(runs)
    .where(eq(runs.outcome, 'success'))
    .all()
    .filter((r) => {
      if (!r.endedAt) return false;
      const ts =
        r.endedAt instanceof Date
          ? r.endedAt.getTime()
          : new Date(r.endedAt as unknown as string).getTime();
      return ts > since;
    });
  const docsDir = resolve(__dirname, '../../../../../docs/solutions');
  const existing = existsSync(docsDir) ? readdirSync(docsDir) : [];
  const candidates = recent
    .filter((r) => !existing.some((f) => f.includes(r.id.slice(0, 8))))
    .map((r) => r.id);
  return { candidates };
}
