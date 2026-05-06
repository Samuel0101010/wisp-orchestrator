import type { FastifyPluginAsync } from 'fastify';
import { healthRoutes } from './health.js';
import { projectRoutes } from './projects.js';
import { planRoutes } from './plans.js';
import { runRoutes } from './runs.js';
import { teamTemplatesRoutes } from './team-templates.js';
import { planChainRoutes } from './plan-chain.js';
import { probePromptRoutes } from './probe-prompt.js';

export const registerRoutes: FastifyPluginAsync = async (app) => {
  await app.register(healthRoutes);
  await app.register(projectRoutes);
  await app.register(planRoutes);
  await app.register(runRoutes);
  await app.register(teamTemplatesRoutes);
  await app.register(planChainRoutes);
  await app.register(probePromptRoutes());
};
