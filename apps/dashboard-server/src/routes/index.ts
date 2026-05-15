import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { FastifyPluginAsync } from 'fastify';
import { healthRoutes } from './health.js';
import { projectRoutes } from './projects.js';
import { planRoutes } from './plans.js';
import { runRoutes, setRuntimeSkillRegistry, getDefaultRuntime } from './runs.js';
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
import {
  runSummaryFallback,
  setRunSummaryFallbackRegistry,
} from '../workers/handlers/run-summary-fallback.js';
import { retryMaxTurns, setRetryMaxTurnsRuntime } from '../workers/handlers/retry-max-turns.js';
import { workerRunsPrune } from '../workers/handlers/worker-runs-prune.js';
import { createWorkersRouter } from './workers.js';
import { tickAutopilot } from '../autopilot/runner.js';
import { routerRoutes } from './router.js';
import { insightsRoutes } from './insights.js';
import { goapRoutes } from './goap.js';
import { createHooksRouter } from './hooks.js';
import { promptBundlesRoutes } from './prompt-bundles.js';
import { dodRoutes } from './dod.js';
import { interviewRoutes } from './interview.js';

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
workerRegistry.register({
  name: 'run-summary-fallback',
  cronSpec: '*/15 * * * *',
  enabled: true,
  handler: runSummaryFallback,
});
workerRegistry.register({
  name: 'retry-max-turns',
  cronSpec: '*/2 * * * *',
  enabled: true,
  handler: retryMaxTurns,
});
workerRegistry.register({
  name: 'worker-runs-prune',
  cronSpec: '0 5 * * 0',
  enabled: true,
  handler: workerRunsPrune,
});

export const workerDaemon = new WorkerDaemon(workerRegistry);

export const registerRoutes: FastifyPluginAsync = async (app) => {
  // Initialize skill registry FIRST and wire it into the default runtime
  // before any route that could trigger runtime construction (runRoutes
  // resolves the default runtime when its plugin function runs).
  //
  // HARNESS_SKILLS_DIR (legacy single-root override) still works — when set,
  // only that directory is loaded. Otherwise we run multi-source discovery
  // across built-in seed, project-local `.claude/skills`, user-global
  // `~/.claude/skills`, and the plugin cache. First-loaded wins on name
  // collisions (priority: seed > project > user > plugin).
  const legacyRoot = process.env.HARNESS_SKILLS_DIR;
  const skillRegistry = legacyRoot
    ? new SkillRegistry(legacyRoot)
    : new SkillRegistry({
        discoveryOpts: {
          seedRoot: resolve(__dirname, '../skills/seed'),
          projectRoot: process.env.HARNESS_PROJECT_ROOT ?? process.cwd(),
        },
      });
  skillRegistry.init();
  setRuntimeSkillRegistry(skillRegistry);
  setRunSummaryFallbackRegistry(skillRegistry);

  await app.register(healthRoutes);
  await app.register(projectRoutes);
  await app.register(planRoutes);
  await app.register(runRoutes);
  // Wire the default runtime into the retry-max-turns worker. Must come AFTER
  // runRoutes registers (which constructs the default runtime), so that the
  // singleton is fully initialized before the worker references it.
  setRetryMaxTurnsRuntime(getDefaultRuntime());
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
  await app.register(dodRoutes);
  await app.register(interviewRoutes);
};
