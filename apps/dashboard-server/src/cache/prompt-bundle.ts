import { createHash } from 'node:crypto';
import { mkdir } from 'node:fs/promises';
import { existsSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { eq, lt } from 'drizzle-orm';
import { db } from '../db/index.js';
import { promptBundles, type PromptBundle } from '@agent-harness/schemas';
import { env } from '../env.js';
import type { BundleKeyInput, UpsertResult } from './types.js';

function sha256(s: string): string {
  return createHash('sha256').update(s, 'utf8').digest('hex');
}

/**
 * Compute the deterministic bundle key from the inputs that determine
 * whether two calls would benefit from sharing an Anthropic session.
 */
export function buildBundleKey(input: BundleKeyInput): string {
  const sortedTools = [...input.allowedTools].sort().join(' ');
  const composite = [
    `model:${input.model}`,
    `system:${sha256(input.systemPrompt)}`,
    `tools:${sha256(sortedTools)}`,
  ].join('|');
  return sha256(composite);
}

export function lookupBundle(bundleKey: string): PromptBundle | undefined {
  const row = db.select().from(promptBundles).where(eq(promptBundles.bundleKey, bundleKey)).get();
  if (!row) return undefined;
  db.update(promptBundles)
    .set({ hitCount: row.hitCount + 1, lastUsedAt: new Date() })
    .where(eq(promptBundles.bundleKey, bundleKey))
    .run();
  return row;
}

/**
 * Insert a new bundle row + create its cwd. If the bundleKey already
 * exists (race), return the existing row's cwd untouched.
 */
export async function upsertBundle(
  bundleKey: string,
  input: BundleKeyInput,
): Promise<UpsertResult> {
  const existing = db
    .select()
    .from(promptBundles)
    .where(eq(promptBundles.bundleKey, bundleKey))
    .get();
  if (existing) {
    return { bundleKey, cwd: existing.cwd, isNew: false };
  }
  const cwd = join(env.HARNESS_DATA_DIR, 'prompt-bundles', bundleKey.slice(0, 16));
  await mkdir(cwd, { recursive: true });
  const now = new Date();
  db.insert(promptBundles)
    .values({
      bundleKey,
      cwd,
      claudeSessionId: null,
      systemPromptHash: sha256(input.systemPrompt),
      allowedToolsHash: sha256([...input.allowedTools].sort().join(' ')),
      model: input.model,
      hitCount: 0,
      lastUsedAt: now,
      createdAt: now,
    })
    .run();
  return { bundleKey, cwd, isNew: true };
}

export function recordSessionId(bundleKey: string, sessionId: string): void {
  db.update(promptBundles)
    .set({ claudeSessionId: sessionId })
    .where(eq(promptBundles.bundleKey, bundleKey))
    .run();
}

/**
 * Delete bundles + their cwds whose lastUsedAt is older than ttlMs.
 * Returns counts. Errors during cwd deletion are swallowed (logged).
 */
export async function evictStaleBundles(
  ttlMs: number,
): Promise<{ deleted: number; errored: number }> {
  const cutoff = new Date(Date.now() - ttlMs);
  const stale = db.select().from(promptBundles).where(lt(promptBundles.lastUsedAt, cutoff)).all();
  let deleted = 0;
  let errored = 0;
  for (const row of stale) {
    try {
      if (existsSync(row.cwd)) rmSync(row.cwd, { recursive: true, force: true });
    } catch (err) {
      console.error('[prompt-bundle-evict] failed to remove', row.cwd, err);
      errored++;
      continue;
    }
    db.delete(promptBundles).where(eq(promptBundles.bundleKey, row.bundleKey)).run();
    deleted++;
  }
  return { deleted, errored };
}
