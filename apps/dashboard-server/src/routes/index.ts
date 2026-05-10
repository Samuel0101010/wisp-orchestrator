import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { FastifyPluginAsync } from 'fastify';
import { healthRoutes } from './health.js';
import { projectRoutes } from './projects.js';
import { planRoutes } from './plans.js';
import { runRoutes } from './runs.js';
import { teamTemplatesRoutes } from './team-templates.js';
import { planChainRoutes } from './plan-chain.js';
import { probePromptRoutes } from './probe-prompt.js';
import { agentRoutes } from './agents.js';
import { createChatRouter } from './chat.js';
import { SkillRegistry } from '../skills/registry.js';
import { createSkillsRouter } from './skills.js';

const __dirname = dirname(fileURLToPath(import.meta.url));

export const registerRoutes: FastifyPluginAsync = async (app) => {
  await app.register(healthRoutes);
  await app.register(projectRoutes);
  await app.register(planRoutes);
  await app.register(runRoutes);
  await app.register(teamTemplatesRoutes);
  await app.register(planChainRoutes);
  await app.register(probePromptRoutes());
  await app.register(agentRoutes);

  const skillsRoot = process.env.HARNESS_SKILLS_DIR
    ?? resolve(__dirname, '../skills/seed');
  const skillRegistry = new SkillRegistry(skillsRoot);
  skillRegistry.init();

  await app.register(createSkillsRouter({ registry: skillRegistry }));
  await app.register(createChatRouter({ skillRegistry }));
};
