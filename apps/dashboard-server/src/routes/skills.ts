import type { FastifyPluginAsync } from 'fastify';
import { z } from 'zod';
import { wrap } from './wrap.js';
import type { SkillRegistry } from '../skills/registry.js';
import { invokeSkill } from '../skills/invoker.js';
import type { SubprocessRunner } from '@agent-harness/orchestrator';

export interface SkillsRouterDeps {
  registry: SkillRegistry;
  runner?: SubprocessRunner;
}

export const createSkillsRouter = (deps: SkillsRouterDeps): FastifyPluginAsync => async (app) => {
  app.get('/api/skills', wrap(async () => {
    return deps.registry.list().map((s) => ({
      name: s.name,
      description: s.description,
      model: s.model,
      allowedTools: s.allowedTools,
      argumentHint: s.argumentHint,
    }));
  }));

  app.post('/api/skills/reload', wrap(async () => {
    deps.registry.reload();
    return { reloaded: true, count: deps.registry.list().length };
  }));

  app.post('/api/skills/:name/invoke', wrap(async (req, reply) => {
    const { name } = z.object({ name: z.string().min(1) }).parse(req.params);
    const { args } = z.object({ args: z.string().default('') }).parse(req.body ?? {});
    const result = await invokeSkill({ registry: deps.registry, name, args, runner: deps.runner });
    if (result.failed === 'skill_not_found') {
      reply.code(404);
      return { error: 'skill_not_found' };
    }
    return result;
  }));
};
