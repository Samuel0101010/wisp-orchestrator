import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { FastifyPluginAsync } from 'fastify';
import { healthRoutes } from './health.js';
import { projectRoutes } from './projects.js';
import { planRoutes } from './plans.js';
import { runRoutes, setRuntimeSkillRegistry } from './runs.js';
import { teamTemplatesRoutes } from './team-templates.js';
import { planChainRoutes } from './plan-chain.js';
import { probePromptRoutes } from './probe-prompt.js';
import { agentRoutes } from './agents.js';
import { createChatRouter } from './chat.js';
import { SkillRegistry } from '../skills/registry.js';
import { createSkillsRouter } from './skills.js';
import { WorkerRegistry } from '../workers/registry.js';
import { WorkerDaemon } from '../workers/daemon.js';
import { auditOrphanRuns } from '../workers/handlers/audit-orphan-runs.js';
import { autoDoc } from '../workers/handlers/auto-doc.js';
import { inventoryRefresh } from '../workers/handlers/inventory-refresh.js';
import { consolidateMemory } from '../workers/handlers/consolidate-memory.js';
import { promptBundleEvict } from '../workers/handlers/prompt-bundle-evict.js';
import { createWorkersRouter } from './workers.js';
import { tickAutopilot } from '../autopilot/runner.js';
import { routerRoutes } from './router.js';
import { insightsRoutes } from './insights.js';
import { goapRoutes } from './goap.js';
import { createHooksRouter } from './hooks.js';
import { promptBundlesRoutes } from './prompt-bundles.js';

const __dirname = dirname(fileURLToPath(import.meta.url));

export const workerRegistry = new WorkerRegistry();
workerRegistry.register({
  name: 'audit-orphan-runs',
  cronSpec: '*/30 * * * *',
  enabled: true,
  handler: auditOrphanRuns,
});
workerRegistry.register({
  name: 'auto-doc',
  cronSpec: '0 * * * *',
  enabled: true,
  handler: autoDoc,
});
workerRegistry.register({
  name: 'inventory-refresh',
  cronSpec: '0 6 * * *',
  enabled: true,
  handler: inventoryRefresh,
});
workerRegistry.register({
  name: 'consolidate-memory',
  cronSpec: '0 3 * * *',
  enabled: false,
  handler: consolidateMemory,
});
workerRegistry.register({
  name: 'autopilot-tick',
  cronSpec: '* * * * *',
  enabled: true,
  handler: tickAutopilot,
});
workerRegistry.register({
  name: 'prompt-bundle-evict',
  cronSpec: '0 4 * * *',
  enabled: true,
  handler: promptBundleEvict,
});

export const workerDaemon = new WorkerDaemon(workerRegistry);

export const registerRoutes: FastifyPluginAsync = async (app) => {
  // Initialize skill registry FIRST and wire it into the default runtime
  // before any route that could trigger runtime construction (runRoutes
  // resolves the default runtime when its plugin function runs).
  const skillsRoot = process.env.HARNESS_SKILLS_DIR ?? resolve(__dirname, '../skills/seed');
  const skillRegistry = new SkillRegistry(skillsRoot);
  skillRegistry.init();
  setRuntimeSkillRegistry(skillRegistry);

  await app.register(healthRoutes);
  await app.register(projectRoutes);
  await app.register(planRoutes);
  await app.register(runRoutes);
  await app.register(teamTemplatesRoutes);
  await app.register(planChainRoutes);
  await app.register(probePromptRoutes());
  await app.register(agentRoutes);

  await app.register(createSkillsRouter({ registry: skillRegistry }));
  await app.register(createChatRouter({ skillRegistry }));
  await app.register(createWorkersRouter({ registry: workerRegistry }));
  await app.register(routerRoutes);
  await app.register(insightsRoutes);
  await app.register(goapRoutes);
  await app.register(createHooksRouter);
  await app.register(promptBundlesRoutes);
};
