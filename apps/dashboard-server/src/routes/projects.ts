import { execFileSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import type { FastifyPluginAsync } from 'fastify';
import { desc, eq } from 'drizzle-orm';
import { z } from 'zod';
import { packageTargetValues, plans, projects, runs } from '@wisp/schemas';
import { db } from '../db/index.js';
import { wrap } from './wrap.js';
import { actionableFindings, scanRefForFindings } from '../orchestrator/findings.js';
import { buildHardeningPlan, insertHardeningPlan } from '../orchestrator/self-healing.js';
import { getLatestProjectState } from '../orchestrator/project-state-loader.js';
import { ensureBriefRow } from './interview.js';

const createProjectSchema = z.object({
  name: z.string().min(1),
  goal: z.string().min(1),
  repoPath: z.string().min(1),
});

// Patch is partial — every field optional. At least one must be present so the
// route can detect no-op requests and return 400 instead of pretending success.
const patchProjectSchema = z
  .object({
    name: z.string().min(1).max(120).optional(),
    goal: z.string().min(1).max(4000).optional(),
    repoPath: z.string().min(1).optional(),
    // Production-loop toggles (see schemas/db.ts → projects). Sent from the
    // dashboard's "Production-Modus"-Karte. Validated independently so the
    // .refine "at least one" guard accepts them as edits.
    autoMergeOnSuccess: z.boolean().optional(),
    selfHealingEnabled: z.boolean().optional(),
    maxChainIterations: z.number().int().min(1).max(10).optional(),
    // Project-level autopilot defaults — applied to NEW runs only.
    defaultAutopilotMode: z.boolean().optional(),
    defaultAutopilotBudgetMinutes: z.number().int().positive().nullable().optional(),
    defaultAutopilotBudgetTokens: z.number().int().positive().nullable().optional(),
    // Runtime-verification toggles (v1.8). When enabled, new plans get the
    // runtime-verifier role auto-injected and the post-success hook gates
    // auto-merge on the release-gate's verdict.
    runtimeVerifyEnabled: z.boolean().optional(),
    runtimeVerifyDevCmd: z.string().min(1).nullable().optional(),
    runtimeVerifyProbeUrl: z.string().min(1).nullable().optional(),
    // v1.15 (Phase 7) — native-packaging target. 'web' disables packaging.
    packageTarget: z.enum(packageTargetValues).optional(),
    // v2.0.0 (Phase 8) — enable the lead agent (Theo) for this project.
    leadEnabled: z.boolean().optional(),
  })
  .refine(
    (v) =>
      v.name !== undefined ||
      v.goal !== undefined ||
      v.repoPath !== undefined ||
      v.autoMergeOnSuccess !== undefined ||
      v.selfHealingEnabled !== undefined ||
      v.maxChainIterations !== undefined ||
      v.defaultAutopilotMode !== undefined ||
      v.defaultAutopilotBudgetMinutes !== undefined ||
      v.defaultAutopilotBudgetTokens !== undefined ||
      v.runtimeVerifyEnabled !== undefined ||
      v.runtimeVerifyDevCmd !== undefined ||
      v.runtimeVerifyProbeUrl !== undefined ||
      v.packageTarget !== undefined ||
      v.leadEnabled !== undefined,
    {
      message: 'at least one editable field must be provided',
    },
  );

export const projectRoutes: FastifyPluginAsync = async (app) => {
  app.get(
    '/api/projects',
    wrap(async () => {
      const rows = await db.select().from(projects).all();
      return rows;
    }),
  );

  app.post(
    '/api/projects',
    wrap(async (req, reply) => {
      const body = createProjectSchema.parse(req.body);
      const row = {
        id: randomUUID(),
        name: body.name,
        goal: body.goal,
        repoPath: body.repoPath,
        createdAt: new Date(),
      };
      await db.insert(projects).values(row).run();
      // v1.9 — auto-seed an empty brief row so the interview UI can pick up
      // the project right after creation. Idempotent.
      ensureBriefRow(row.id);
      reply.code(201);
      return row;
    }),
  );

  app.get(
    '/api/projects/:id',
    wrap(async (req, reply) => {
      const params = z.object({ id: z.string() }).parse(req.params);
      const row = await db.select().from(projects).where(eq(projects.id, params.id)).get();
      if (!row) {
        reply.code(404);
        return { error: 'project not found' };
      }
      return row;
    }),
  );

  // v1.10 — return the most recent project_states row, or null when the
  // project has never produced one (first run hasn't completed yet, or
  // the runtime-verifier didn't emit docs/project-state.md). The
  // ProjectStateCard renders nothing in the null case.
  app.get(
    '/api/projects/:id/state',
    wrap(async (req, reply) => {
      const params = z.object({ id: z.string() }).parse(req.params);
      const project = await db.select().from(projects).where(eq(projects.id, params.id)).get();
      if (!project) {
        reply.code(404);
        return { error: 'project not found' };
      }
      const state = await getLatestProjectState(db, params.id);
      return { state };
    }),
  );

  app.delete(
    '/api/projects/:id',
    wrap(async (req, reply) => {
      const params = z.object({ id: z.string() }).parse(req.params);
      const existing = await db.select().from(projects).where(eq(projects.id, params.id)).get();
      if (!existing) {
        reply.code(404);
        return { error: 'project not found' };
      }
      // Before letting Drizzle's FK cascade wipe the plans/runs rows, cancel
      // any live walkers that belong to this project. Without this, deleting
      // an active project leaves zombie walkers spending API budget against
      // a run row that no longer exists. Defer-import avoids the circular
      // dependency with routes/runs.ts.
      try {
        const { getDefaultRuntime } = await import('./runs.js');
        const cancelled = await getDefaultRuntime().cancelRunsForProject(params.id);
        if (cancelled.length > 0) {
          req.log.info(
            { projectId: params.id, cancelled },
            'DELETE /api/projects: cancelled live walkers before delete',
          );
        }
      } catch (err) {
        req.log.warn(
          { projectId: params.id, err: String(err) },
          'DELETE /api/projects: cancelRunsForProject threw — continuing with delete',
        );
      }
      // Stop any live preview process and remove its managed worktree. The
      // worktree is kept alive across stop/start cycles, so project-delete is
      // the point where it must be reaped. Best-effort — same pattern as the
      // walker cancel above. Defer-import avoids a circular dependency.
      try {
        const { previewProcesses, cleanupPreviewWorktree } =
          await import('../orchestrator/preview-server.js');
        previewProcesses.stopPreview(params.id);
        await cleanupPreviewWorktree(existing.repoPath, params.id);
      } catch (err) {
        req.log.warn(
          { projectId: params.id, err: String(err) },
          'DELETE /api/projects: preview cleanup threw — continuing with delete',
        );
      }
      // Cascade is owned by the DB schema (drizzle FKs); deleting the project
      // row removes its plans, runs, and chats automatically.
      await db.delete(projects).where(eq(projects.id, params.id)).run();
      reply.code(204);
      return null;
    }),
  );

  app.patch(
    '/api/projects/:id',
    wrap(async (req, reply) => {
      const params = z.object({ id: z.string() }).parse(req.params);
      const patch = patchProjectSchema.parse(req.body);
      const existing = await db.select().from(projects).where(eq(projects.id, params.id)).get();
      if (!existing) {
        reply.code(404);
        return { error: 'project not found' };
      }
      const updates: Partial<typeof existing> = {};
      if (patch.name !== undefined) updates.name = patch.name;
      if (patch.goal !== undefined) updates.goal = patch.goal;
      if (patch.repoPath !== undefined) updates.repoPath = patch.repoPath;
      if (patch.autoMergeOnSuccess !== undefined)
        updates.autoMergeOnSuccess = patch.autoMergeOnSuccess;
      if (patch.selfHealingEnabled !== undefined)
        updates.selfHealingEnabled = patch.selfHealingEnabled;
      if (patch.maxChainIterations !== undefined)
        updates.maxChainIterations = patch.maxChainIterations;
      if (patch.defaultAutopilotMode !== undefined)
        updates.defaultAutopilotMode = patch.defaultAutopilotMode;
      if (patch.defaultAutopilotBudgetMinutes !== undefined)
        updates.defaultAutopilotBudgetMinutes = patch.defaultAutopilotBudgetMinutes;
      if (patch.defaultAutopilotBudgetTokens !== undefined)
        updates.defaultAutopilotBudgetTokens = patch.defaultAutopilotBudgetTokens;
      if (patch.runtimeVerifyEnabled !== undefined)
        updates.runtimeVerifyEnabled = patch.runtimeVerifyEnabled;
      if (patch.runtimeVerifyDevCmd !== undefined)
        updates.runtimeVerifyDevCmd = patch.runtimeVerifyDevCmd;
      if (patch.runtimeVerifyProbeUrl !== undefined)
        updates.runtimeVerifyProbeUrl = patch.runtimeVerifyProbeUrl;
      if (patch.packageTarget !== undefined) updates.packageTarget = patch.packageTarget;
      if (patch.leadEnabled !== undefined) updates.leadEnabled = patch.leadEnabled;
      await db.update(projects).set(updates).where(eq(projects.id, params.id)).run();
      const updated = await db.select().from(projects).where(eq(projects.id, params.id)).get();
      return updated ?? existing;
    }),
  );

  // Manually trigger a self-healing hardening run on a project, using a prior
  // successful run as the source of findings. Same machinery as the auto-chain
  // hook in runtime.ts — exposed as an endpoint so the user can retroactively
  // start the first iteration for runs that completed BEFORE the project had
  // selfHealingEnabled (or before v1.7.14 existed at all).
  //
  // Body: { parentRunId: string }
  //
  // The parent run MUST be on the same project AND have outcome=success.
  // Its result branch (`harness/<parentRunId>/result`) is scanned for HIGH/
  // CRITICAL/MEDIUM findings; if any remain, a hardening plan is inserted
  // and a fresh run is started with chain_iteration = parent.chain_iteration + 1.
  app.post(
    '/api/projects/:id/harden-run',
    wrap(async (req, reply) => {
      const params = z.object({ id: z.string() }).parse(req.params);
      const body = z.object({ parentRunId: z.string().min(1) }).parse(req.body ?? {});

      const project = await db.select().from(projects).where(eq(projects.id, params.id)).get();
      if (!project) {
        reply.code(404);
        return { error: 'project not found' };
      }
      const parentRun = await db.select().from(runs).where(eq(runs.id, body.parentRunId)).get();
      if (!parentRun) {
        reply.code(404);
        return { error: 'parent run not found' };
      }
      const parentPlan = await db.select().from(plans).where(eq(plans.id, parentRun.planId)).get();
      if (!parentPlan || parentPlan.projectId !== project.id) {
        reply.code(400);
        return { error: 'parent run does not belong to this project' };
      }
      if (parentRun.outcome !== 'success') {
        reply.code(400);
        return {
          error: 'parent run did not succeed — hardening only runs on top of success outcomes',
          actual: parentRun.outcome,
        };
      }

      const resultBranch = `harness/${parentRun.id}/result`;
      let actionable;
      try {
        const all = await scanRefForFindings({ repoPath: project.repoPath, ref: resultBranch });
        actionable = actionableFindings(all);
      } catch (err) {
        reply.code(500);
        return {
          error: 'findings scan failed',
          details: err instanceof Error ? err.message : String(err),
        };
      }
      if (actionable.length === 0) {
        reply.code(200);
        return {
          ok: true,
          spawned: false,
          reason: 'no remaining HIGH/CRITICAL/MEDIUM findings — chain naturally complete',
        };
      }

      const nextIteration = parentRun.chainIteration + 1;
      if (nextIteration > project.maxChainIterations) {
        reply.code(409);
        return {
          error: 'chain cap reached',
          chainIteration: parentRun.chainIteration,
          maxChainIterations: project.maxChainIterations,
        };
      }

      const plan = buildHardeningPlan({
        parentGoal: project.goal,
        iteration: nextIteration,
        findings: actionable,
      });
      const newPlanId = await insertHardeningPlan({
        db,
        projectId: project.id,
        parentPlanId: parentRun.planId,
        plan,
      });

      // Defer-import the runtime to avoid a circular import (routes/runs.ts
      // imports this very file via the routes index).
      const { getDefaultRuntime } = await import('./runs.js');
      const runtime = getDefaultRuntime();
      const res = await runtime.startRun({
        planId: newPlanId,
        parentRunId: parentRun.id,
        chainIteration: nextIteration,
      });
      if (!res.ok) {
        reply.code(res.status);
        return { error: res.error, details: res.details };
      }
      return {
        ok: true,
        spawned: true,
        runId: res.runId,
        planId: newPlanId,
        chainIteration: nextIteration,
        findingsCount: actionable.length,
      };
    }),
  );

  // Idempotent: `git init -b main` + initial commit so the orchestrator's
  // `git worktree add` can succeed. Returns 200/`alreadyInitialized: true`
  // when the repo is already initialized; 201/`alreadyInitialized: false`
  // when this call did the work. If the directory itself is missing it refuses
  // with `repo_path_missing` — UNLESS the caller passes `{ createDir: true }`
  // (an explicit user confirmation), in which case it mkdir -p's the path first.
  app.post(
    '/api/projects/:id/init-repo',
    wrap(async (req, reply) => {
      const params = z.object({ id: z.string() }).parse(req.params);
      const body = z.object({ createDir: z.boolean().optional() }).parse(req.body ?? {});
      const project = await db.select().from(projects).where(eq(projects.id, params.id)).get();
      if (!project) {
        reply.code(404);
        return { error: 'project not found' };
      }
      const repoPath = project.repoPath;
      if (!fs.existsSync(repoPath)) {
        if (!body.createDir) {
          reply.code(400);
          return {
            error: 'repo_path_missing',
            repoPath,
            hint: 'Retry with createDir to let WISP create the folder, or update the project repoPath.',
          };
        }
        try {
          fs.mkdirSync(repoPath, { recursive: true });
        } catch (err) {
          reply.code(500);
          return {
            error: 'mkdir_failed',
            repoPath,
            message: err instanceof Error ? err.message : String(err),
          };
        }
      }
      if (fs.existsSync(path.join(repoPath, '.git'))) {
        return { ok: true, alreadyInitialized: true, repoPath };
      }

      const env = { ...process.env, GIT_TERMINAL_PROMPT: '0' };
      const git = (...args: string[]): string =>
        execFileSync('git', args, { cwd: repoPath, env, stdio: 'pipe' }).toString();
      try {
        git('init', '-b', 'main');
        // Set local user.email/name only if not already configured globally —
        // git commit refuses without them. Use a neutral identity so commits
        // are obviously harness-authored rather than impersonating the user.
        try {
          execFileSync('git', ['config', '--get', 'user.email'], {
            cwd: repoPath,
            env,
            stdio: 'pipe',
          });
        } catch {
          git('config', 'user.email', 'harness@local');
          git('config', 'user.name', 'WISP');
        }
        // Disable signing for the bootstrap commit so it works regardless of
        // user's global signing config.
        git('config', 'commit.gpgsign', 'false');
        const readme = path.join(repoPath, 'README.md');
        if (!fs.existsSync(readme)) {
          fs.writeFileSync(readme, `# ${project.name}\n\n${project.goal}\n`, 'utf8');
        }
        git('add', '-A');
        git('commit', '-m', 'initial commit');
        const head = git('rev-parse', 'HEAD').trim();
        reply.code(201);
        return { ok: true, alreadyInitialized: false, repoPath, head };
      } catch (err) {
        reply.code(500);
        return {
          error: 'git_init_failed',
          repoPath,
          message: err instanceof Error ? err.message : String(err),
        };
      }
    }),
  );

  // Read-only pre-flight for the New Project dialog: does this path already
  // exist, and is it already a git repo? Lets the dialog tell the user up front
  // whether WISP will need to create / initialize the folder, instead of
  // failing only at run start. Local-only server; reveals only existence + .git.
  app.post(
    '/api/projects/repo-status',
    wrap(async (req) => {
      const { path: repoPath } = z.object({ path: z.string().min(1) }).parse(req.body ?? {});
      const exists = fs.existsSync(repoPath);
      const isGitRepo = exists && fs.existsSync(path.join(repoPath, '.git'));
      return { exists, isGitRepo };
    }),
  );

  app.get(
    '/api/projects/:projectId/runs',
    wrap(async (req, reply) => {
      const params = z.object({ projectId: z.string().min(1) }).parse(req.params);
      const project = await db
        .select()
        .from(projects)
        .where(eq(projects.id, params.projectId))
        .get();
      if (!project) {
        reply.code(404);
        return { error: 'project not found' };
      }
      // Find all plans of this project, then runs of those plans, ordered by startedAt desc.
      const planRows = await db
        .select({ id: plans.id })
        .from(plans)
        .where(eq(plans.projectId, params.projectId))
        .all();
      if (planRows.length === 0) return [];
      const planIds = new Set(planRows.map((p) => p.id));
      const runRows = await db
        .select({
          id: runs.id,
          planId: runs.planId,
          status: runs.status,
          outcome: runs.outcome,
          startedAt: runs.startedAt,
          endedAt: runs.endedAt,
          pausedReason: runs.pausedReason,
          resumeAt: runs.resumeAt,
          tokensInTotal: runs.tokensInTotal,
          tokensOutTotal: runs.tokensOutTotal,
          turnsTotal: runs.turnsTotal,
          // Chain pointers so the project Run-Historie can surface
          // "Iteration N / parent run" relationships in the list view.
          parentRunId: runs.parentRunId,
          chainIteration: runs.chainIteration,
        })
        .from(runs)
        .orderBy(desc(runs.startedAt))
        .all();
      return runRows.filter((r) => planIds.has(r.planId));
    }),
  );
};
