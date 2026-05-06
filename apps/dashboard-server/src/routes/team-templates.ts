import type { FastifyPluginAsync } from 'fastify';
import { wrap } from './wrap.js';
import { builtInTemplates, templateSchema, type TeamTemplate } from '../templates/index.js';
import { loadUserTemplates, saveUserTemplate } from '../templates/disk-store.js';

/**
 * Merge built-ins with on-disk user templates. On-disk wins on id collision so
 * users can override a built-in (e.g. customised systemPrompts) without
 * touching the source.
 */
function mergeTemplates(): TeamTemplate[] {
  const onDisk = loadUserTemplates();
  const onDiskIds = new Set(onDisk.map((t) => t.id));
  const merged: TeamTemplate[] = [...onDisk];
  for (const built of builtInTemplates) {
    if (!onDiskIds.has(built.id)) merged.push(built);
  }
  merged.sort((a, b) => a.id.localeCompare(b.id));
  return merged;
}

export const teamTemplatesRoutes: FastifyPluginAsync = async (app) => {
  app.get(
    '/api/team-templates',
    wrap(async () => ({
      templates: mergeTemplates(),
    })),
  );

  app.post(
    '/api/team-templates',
    wrap(async (req, reply) => {
      const parsed = templateSchema.safeParse(req.body);
      if (!parsed.success) {
        reply.code(400);
        return {
          error: 'invalid_template',
          issues: parsed.error.issues,
        };
      }
      const file = saveUserTemplate(parsed.data);
      reply.code(201);
      return { template: parsed.data, path: file };
    }),
  );
};
