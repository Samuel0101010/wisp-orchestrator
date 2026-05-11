import fs from 'node:fs';
import path from 'node:path';
import { env } from '../env.js';
import { templateSchema, type TeamTemplate } from './index.js';

/**
 * Resolve the on-disk templates directory under HARNESS_DATA_DIR. The Zod
 * schema in env.ts applies the os.tmpdir() default; reading process.env
 * directly would lose it and produce a relative path.
 */
function userTemplatesDir(): string {
  return path.join(env.HARNESS_DATA_DIR, 'templates');
}

/**
 * Read every *.json under the user templates dir and validate. Invalid files
 * are silently skipped (logged via console.warn) so one corrupted file doesn't
 * break the whole list.
 */
export function loadUserTemplates(): TeamTemplate[] {
  const dir = userTemplatesDir();
  if (!fs.existsSync(dir)) return [];
  const out: TeamTemplate[] = [];
  for (const entry of fs.readdirSync(dir)) {
    if (!entry.toLowerCase().endsWith('.json')) continue;
    const full = path.join(dir, entry);
    let raw: unknown;
    try {
      raw = JSON.parse(fs.readFileSync(full, 'utf8'));
    } catch (err) {
      console.warn(
        JSON.stringify({
          event: 'user-template-skip',
          reason: 'json-parse',
          file: entry,
          message: err instanceof Error ? err.message : String(err),
        }),
      );
      continue;
    }
    const result = templateSchema.safeParse(raw);
    if (!result.success) {
      console.warn(
        JSON.stringify({
          event: 'user-template-skip',
          reason: 'schema-fail',
          file: entry,
          issues: result.error.issues.length,
        }),
      );
      continue;
    }
    out.push(result.data);
  }
  return out;
}

/**
 * Write a user template to <dir>/<id>.json. Creates the dir if absent.
 * Returns the absolute path so the route can mention it in the response.
 */
export function saveUserTemplate(template: TeamTemplate): string {
  const dir = userTemplatesDir();
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, `${template.id}.json`);
  fs.writeFileSync(file, JSON.stringify(template, null, 2), 'utf8');
  return file;
}
