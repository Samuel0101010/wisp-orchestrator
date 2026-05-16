import type { FastifyPluginAsync } from 'fastify';
import { z } from 'zod';
import { eq, desc } from 'drizzle-orm';
import { existsSync, rmSync } from 'node:fs';
import { wrap } from './wrap.js';
import { db } from '../db/index.js';
import { promptBundles } from '@wisp/schemas';

export const promptBundlesRoutes: FastifyPluginAsync = async (app) => {
  app.get(
    '/api/prompt-bundles',
    wrap(async () => {
      const rows = db
        .select()
        .from(promptBundles)
        .orderBy(desc(promptBundles.lastUsedAt))
        .limit(200)
        .all();
      return rows.map((r) => ({
        bundleKey: r.bundleKey,
        cwd: r.cwd,
        claudeSessionId: r.claudeSessionId,
        model: r.model,
        hitCount: r.hitCount,
        lastUsedAt: r.lastUsedAt,
        createdAt: r.createdAt,
      }));
    }),
  );

  app.delete(
    '/api/prompt-bundles/:key',
    wrap(async (req, reply) => {
      const { key } = z.object({ key: z.string().min(1) }).parse(req.params);
      const row = db.select().from(promptBundles).where(eq(promptBundles.bundleKey, key)).get();
      if (!row) {
        reply.code(404);
        return { error: 'not_found' };
      }
      try {
        if (existsSync(row.cwd)) rmSync(row.cwd, { recursive: true, force: true });
      } catch (err) {
        console.warn(
          `[prompt-bundles] failed to remove cwd ${row.cwd}:`,
          err instanceof Error ? err.message : err,
        );
      }
      db.delete(promptBundles).where(eq(promptBundles.bundleKey, key)).run();
      reply.code(204);
      return null;
    }),
  );
};
