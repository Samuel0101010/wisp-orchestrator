import type { FastifyPluginAsync } from 'fastify';
import { z } from 'zod';
import { wrap } from './wrap.js';
import { db } from '../db/index.js';
import { hookEvents } from '@agent-harness/schemas';
import { desc } from 'drizzle-orm';
import { randomUUID } from 'node:crypto';

const eventSchema = z.object({
  event: z.enum([
    'PreToolUse',
    'PostToolUse',
    'UserPromptSubmit',
    'SessionStart',
    'SessionEnd',
    'Stop',
    'PreCompact',
    'SubagentStop',
  ]),
  toolName: z.string().optional(),
  cwd: z.string().optional(),
  payload: z.unknown().optional(),
});

export const createHooksRouter: FastifyPluginAsync = async (app) => {
  app.post(
    '/api/hooks/event',
    wrap(async (req, reply) => {
      const expected = process.env.HARNESS_HOOK_TOKEN;
      if (!expected) {
        reply.code(503);
        return { error: 'hooks_disabled', message: 'HARNESS_HOOK_TOKEN unset' };
      }
      const got = req.headers['x-harness-token'];
      if (got !== expected) {
        reply.code(401);
        return { error: 'unauthorized' };
      }
      const body = eventSchema.parse(req.body ?? {});
      db.insert(hookEvents)
        .values({
          id: randomUUID(),
          event: body.event,
          toolName: body.toolName ?? null,
          cwd: body.cwd ?? null,
          payloadJson: JSON.stringify(body.payload ?? {}),
          receivedAt: new Date(),
        })
        .run();
      reply.code(204);
      return null;
    }),
  );

  app.get(
    '/api/hooks/events',
    wrap(async () => {
      const rows = db
        .select()
        .from(hookEvents)
        .orderBy(desc(hookEvents.receivedAt))
        .limit(200)
        .all();
      return rows;
    }),
  );
};
