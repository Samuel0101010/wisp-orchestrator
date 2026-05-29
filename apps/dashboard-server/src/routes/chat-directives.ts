/**
 * Chat v2 directive handlers.
 *
 * Each handler executes one parsed <<ACTION>>{...}<<END>> directive emitted
 * by the Manager and persists the audit row in `chat_actions`. Returns the
 * row so the route can include it in the SendMessage response.
 *
 * Directives are intentionally side-effect-y but bounded: they touch SQL
 * and may launch a planner subprocess, but they never delete data and
 * never run shell commands of their own.
 */

import { randomUUID } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { desc, eq } from 'drizzle-orm';
import {
  agents,
  agentMessages,
  agentThreads,
  chatActions,
  plans as plansTable,
  projects as projectsTable,
  teams as teamsTable,
  threadParticipants,
  type ChatActionKind,
  type ChatActionStatus,
  type ManagerDirective,
  type Team,
} from '@wisp/schemas';
import { db, sqlite } from '../db/index.js';
import { env } from '../env.js';
import { resolveAgentRef } from '../db/agents-seed.js';
import { runAgentTurn, composePrompt, type HistoryMessage } from './chat-engine.js';
import { publishToThread } from '../ws.js';
import type { SubprocessRunner } from '@wisp/orchestrator';
import type { SkillRegistry } from '../skills/registry.js';
import { invokeSkill } from '../skills/invoker.js';
import { ensureBriefRow } from './interview.js';

export interface DirectiveContext {
  threadId: string;
  managerMessageId: string;
  /** Optional runner override for tests. */
  runner?: SubprocessRunner;
  skillRegistry?: SkillRegistry;
}

export interface ExecutedDirective {
  id: string;
  kind: ChatActionKind;
  status: ChatActionStatus;
  payload: unknown;
  result: unknown | null;
  /**
   * Extra messages produced as a side effect — e.g. a `consult` directive
   * yields a new assistant message from the consulted agent. The route
   * appends these to the response.
   */
  extraMessages: ExtraMessage[];
}

export interface ExtraMessage {
  id: string;
  threadId: string;
  role: 'assistant';
  content: string;
  authorAgentId: string;
  tokensIn: number | null;
  tokensOut: number | null;
  durationMs: number | null;
  errorReason: string | null;
  createdAt: Date;
}

export async function executeDirective(
  d: ManagerDirective,
  ctx: DirectiveContext,
): Promise<ExecutedDirective> {
  const id = randomUUID();
  const createdAt = new Date();
  let status: ChatActionStatus = 'failed';
  let result: unknown = null;
  const extraMessages: ExtraMessage[] = [];

  try {
    switch (d.kind) {
      case 'consult': {
        result = await handleConsult(d, ctx, extraMessages);
        status = 'ok';
        break;
      }
      case 'add_member': {
        result = await handleAddMember(d, ctx);
        status = 'ok';
        break;
      }
      case 'create_project': {
        result = await handleCreateProject(d, ctx);
        status = 'ok';
        break;
      }
      case 'start_run': {
        result = await handleStartRun(d, ctx);
        status = 'ok';
        break;
      }
      case 'invoke_skill': {
        result = await handleInvokeSkill(d, ctx, extraMessages);
        status = 'ok';
        break;
      }
      case 'generate_plan': {
        // The plan is generated asynchronously (60-90s); the handler returns
        // immediately after launching a background job and we persist the row
        // as 'pending'. The bg job patches it to 'ok'/'failed' + emits a WS
        // 'chat.action-update' once the plan is locked (or fails).
        result = await handleGeneratePlan(d, ctx, id);
        status = 'pending';
        break;
      }
    }
  } catch (err) {
    result = { error: err instanceof Error ? err.message : String(err) };
    status = 'failed';
  }

  // Audit-log every attempt (success or failure) so the UI can surface what
  // the manager tried even when the side effect couldn't complete.
  sqlite
    .prepare(
      `INSERT INTO chat_actions
         (id, thread_id, message_id, kind, payload_json, result_json, status, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(
      id,
      ctx.threadId,
      ctx.managerMessageId,
      d.kind,
      JSON.stringify(d),
      JSON.stringify(result),
      status,
      createdAt.getTime(),
    );

  return { id, kind: d.kind, status, payload: d, result, extraMessages };
}

async function handleConsult(
  d: Extract<ManagerDirective, { kind: 'consult' }>,
  ctx: DirectiveContext,
  out: ExtraMessage[],
): Promise<unknown> {
  const target = resolveAgentRef(d.agent);
  if (!target) throw new Error(`unknown_agent: ${d.agent}`);
  const agent = db.select().from(agents).where(eq(agents.id, target.id)).get();
  if (!agent) throw new Error(`agent_not_found: ${target.id}`);

  // Load thread history so the consulted agent has context (same budget/style
  // as a normal turn but written in a way that makes the agent answer the
  // specific question, not the previous user turn).
  const prior = db
    .select()
    .from(agentMessages)
    .where(eq(agentMessages.threadId, ctx.threadId))
    .orderBy(agentMessages.createdAt)
    .all();
  // Attribute each assistant line to its author so the consulted specialist sees
  // who said what (Marcus vs Lena vs Diego) and can reference teammates by name.
  const nameById = new Map(
    db
      .select({ id: agents.id, name: agents.name })
      .from(agents)
      .all()
      .map((a) => [a.id, a.name] as const),
  );
  const history: HistoryMessage[] = prior
    .filter((m) => m.errorReason == null)
    .map((m) => ({
      role: m.role as 'user' | 'assistant',
      content: m.content,
      authorName: m.authorAgentId ? nameById.get(m.authorAgentId) : undefined,
    }));
  const composed = composePrompt(
    agent.systemPrompt,
    history,
    `[Manager asks you privately on the team chat]\n${d.question}`,
    'manager',
  );

  const turn = await runAgentTurn({
    systemPrompt: composed.systemPrompt,
    prompt: composed.prompt,
    allowedTools: agent.allowedTools,
    model: agent.model,
    taskId: `chat-consult-${ctx.threadId.slice(0, 6)}-${target.seedKey ?? 'agent'}`,
    runner: ctx.runner,
  });

  const messageId = randomUUID();
  const createdAt = new Date();
  // Bug 7: never persist a literal "(no response)" sentinel as user-visible
  // content. Tag empty replies with errorReason='empty-response' so the UI
  // renders an error chip instead of showing the sentinel as a real message.
  const consultContent = turn.text || '';
  const consultErrorReason = turn.failed ?? (consultContent.length === 0 ? 'empty-response' : null);
  sqlite
    .prepare(
      `INSERT INTO agent_messages
         (id, thread_id, role, content, tokens_in, tokens_out, duration_ms,
          error_reason, author_agent_id, created_at)
       VALUES (?, ?, 'assistant', ?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(
      messageId,
      ctx.threadId,
      consultContent,
      turn.tokensIn || null,
      turn.tokensOut || null,
      turn.durationMs,
      consultErrorReason,
      target.id,
      createdAt.getTime(),
    );

  out.push({
    id: messageId,
    threadId: ctx.threadId,
    role: 'assistant',
    content: consultContent,
    authorAgentId: target.id,
    tokensIn: turn.tokensIn || null,
    tokensOut: turn.tokensOut || null,
    durationMs: turn.durationMs,
    errorReason: consultErrorReason,
    createdAt,
  });

  return {
    consultedAgentId: target.id,
    consultedName: target.name,
    durationMs: turn.durationMs,
    tokensIn: turn.tokensIn,
    tokensOut: turn.tokensOut,
    failed: turn.failed,
  };
}

async function handleAddMember(
  d: Extract<ManagerDirective, { kind: 'add_member' }>,
  ctx: DirectiveContext,
): Promise<unknown> {
  const target = resolveAgentRef(d.agent);
  if (!target) throw new Error(`unknown_agent: ${d.agent}`);
  const existing = db
    .select()
    .from(threadParticipants)
    .where(eq(threadParticipants.threadId, ctx.threadId))
    .all();
  if (existing.find((p) => p.agentId === target.id)) {
    return { agentId: target.id, alreadyMember: true };
  }
  sqlite
    .prepare(
      `INSERT INTO thread_participants (thread_id, agent_id, role, joined_at)
       VALUES (?, ?, 'member', ?)`,
    )
    .run(ctx.threadId, target.id, Date.now());
  return { agentId: target.id, name: target.name, addedAs: 'member' };
}

interface EnsureRepoResult {
  /** Resolved absolute repo path. */
  repoPath: string;
  /** The directory was created by this call. */
  created: boolean;
  /** `git init` ran (false when the dir was already a repo). */
  initialized: boolean;
}

/**
 * Make `repoPathInput` an absolute, git-initialized directory so a later run's
 * `git worktree add` can succeed. Unlike the manual POST /api/projects/:id/init-repo
 * route (which refuses to create arbitrary dirs), the chat flow CREATES the
 * directory — a project the manager invents usually doesn't exist yet. Relative
 * paths are resolved against the server cwd. Idempotent.
 */
function ensureRepoInitialized(
  repoPathInput: string,
  name: string,
  goal: string,
): EnsureRepoResult {
  const repoPath = path.isAbsolute(repoPathInput)
    ? repoPathInput
    : path.resolve(process.cwd(), repoPathInput);
  let created = false;
  if (!fs.existsSync(repoPath)) {
    fs.mkdirSync(repoPath, { recursive: true });
    created = true;
  }
  if (fs.existsSync(path.join(repoPath, '.git'))) {
    return { repoPath, created, initialized: false };
  }
  const env = { ...process.env, GIT_TERMINAL_PROMPT: '0' };
  const git = (...args: string[]): string =>
    execFileSync('git', args, { cwd: repoPath, env, stdio: 'pipe' }).toString();
  git('init', '-b', 'main');
  try {
    execFileSync('git', ['config', '--get', 'user.email'], { cwd: repoPath, env, stdio: 'pipe' });
  } catch {
    git('config', 'user.email', 'harness@local');
    git('config', 'user.name', 'WISP');
  }
  git('config', 'commit.gpgsign', 'false');
  const readme = path.join(repoPath, 'README.md');
  if (!fs.existsSync(readme)) {
    fs.writeFileSync(readme, `# ${name}\n\n${goal}\n`, 'utf8');
  }
  git('add', '-A');
  git('commit', '-m', 'initial commit');
  return { repoPath, created, initialized: true };
}

async function handleCreateProject(
  d: Extract<ManagerDirective, { kind: 'create_project' }>,
  ctx: DirectiveContext,
): Promise<unknown> {
  // Resolve team members. If `team` omitted, use current thread members
  // excluding the manager.
  let teamRefs: string[];
  if (d.team && d.team.length > 0) {
    teamRefs = d.team;
  } else {
    const parts = db
      .select({ agentId: threadParticipants.agentId, role: threadParticipants.role })
      .from(threadParticipants)
      .where(eq(threadParticipants.threadId, ctx.threadId))
      .all();
    const memberIds = parts.filter((p) => p.role === 'member').map((p) => p.agentId);
    // Fall back to a sensible default team so create_project works from a fresh
    // manager-only thread (the common first-time case) instead of erroring.
    teamRefs = memberIds.length > 0 ? memberIds : ['frontend-dev', 'backend-dev', 'qa-engineer'];
  }

  const resolved = teamRefs.map((ref) => {
    const r = resolveAgentRef(ref);
    if (!r) throw new Error(`unknown_team_agent: ${ref}`);
    const a = db.select().from(agents).where(eq(agents.id, r.id)).get();
    if (!a) throw new Error(`agent_row_missing: ${ref}`);
    return a;
  });

  // Build the team rolesJson. Use seedKey (or sanitized name) as the role name.
  const team: Team = {
    roles: resolved.map((a) => ({
      role: a.seedKey ?? a.name.toLowerCase().replace(/[^a-z0-9]+/g, '-'),
      agentId: a.id,
      model: a.model,
      allowedTools: a.allowedTools,
      systemPrompt: a.systemPrompt,
    })),
  };

  // Ensure the repo exists + is git-initialized (relatives resolved to absolute)
  // so a later run's `git worktree add` succeeds. This is what makes "create a
  // project via chat" actually runnable, converging with the manual flow.
  let repoInit: EnsureRepoResult;
  try {
    repoInit = ensureRepoInitialized(d.repoPath, d.name, d.goal);
  } catch (err) {
    throw new Error(`repo_init_failed: ${err instanceof Error ? err.message : String(err)}`);
  }

  const projectId = randomUUID();
  const teamId = randomUUID();
  const now = new Date();
  const tx = sqlite.transaction(() => {
    sqlite
      .prepare(
        `INSERT INTO projects (id, name, goal, repo_path, created_at)
         VALUES (?, ?, ?, ?, ?)`,
      )
      .run(projectId, d.name, d.goal, repoInit.repoPath, now.getTime());
    sqlite
      .prepare(`INSERT INTO teams (id, project_id, roles_json) VALUES (?, ?, ?)`)
      .run(teamId, projectId, JSON.stringify(team));
  });
  tx();

  // v1.9 — auto-seed an empty brief row so the manager's create_project flow
  // converges with the manual sidebar create-project flow. Both surfaces now
  // produce identical post-create state.
  ensureBriefRow(projectId);

  return {
    projectId,
    name: d.name,
    goal: d.goal,
    repoPath: repoInit.repoPath,
    repoInitialized: repoInit.initialized,
    teamSize: resolved.length,
    teamAgents: resolved.map((a) => ({ id: a.id, name: a.name })),
  };
}

async function handleStartRun(
  d: Extract<ManagerDirective, { kind: 'start_run' }>,
  ctx: DirectiveContext,
): Promise<unknown> {
  // If no projectId given, look up the most recent create_project action in
  // this thread.
  let projectId = d.projectId;
  if (!projectId) {
    const recent = db
      .select()
      .from(chatActions)
      .where(eq(chatActions.threadId, ctx.threadId))
      .orderBy(desc(chatActions.createdAt))
      .all();
    const created = recent.find((r) => r.kind === 'create_project' && r.status === 'ok');
    const result = created?.resultJson as { projectId?: string } | null | undefined;
    if (!result?.projectId) {
      throw new Error('no_project_to_run: pass projectId or create_project first');
    }
    projectId = result.projectId;
  }

  const project = db.select().from(projectsTable).where(eq(projectsTable.id, projectId)).get();
  if (!project) throw new Error(`project_not_found: ${projectId}`);

  // Pick the latest plan; if none, the manager needs to generate one first
  // (we don't auto-plan here to keep the directive cheap and predictable).
  const latestPlan = db
    .select()
    .from(plansTable)
    .where(eq(plansTable.projectId, projectId))
    .orderBy(desc(plansTable.id))
    .get();
  if (!latestPlan) {
    return {
      projectId,
      runStarted: false,
      reason: 'no_plan_yet',
      hint: 'Generate a plan via the project page first, then run start_run again.',
    };
  }

  // Defer to the runs runtime via a deferred import to avoid a circular dep.
  const { getDefaultRuntime } = await import('./runs.js');
  const runtime = getDefaultRuntime();
  const startResult = await runtime.startRun({ planId: latestPlan.id });
  if (!startResult.ok) {
    throw new Error(`run_start_failed: ${startResult.error}`);
  }
  return { projectId, planId: latestPlan.id, runId: startResult.runId };
}

/**
 * Generate + lock a plan for a project from chat. The plan-gen call is slow
 * (60-90s), so this handler validates eagerly + synchronously (so an obviously
 * un-plannable request fails the chat_actions row immediately, not after 90s),
 * then launches a NON-awaited background job that calls the server's own
 * existing endpoints over loopback HTTP:
 *   POST /api/projects/:id/plan  (reuses the fully-tested plan-gen route)
 *   POST /api/plans/:planId/lock
 * On completion the bg job patches the chat_actions row + publishes a
 * `chat.action-update` WS event so the UI flips the pending card to ok/failed.
 *
 * The directive's persisted status starts as 'pending'; start_run must be
 * emitted in a SEPARATE later turn (the plan is not ready in this turn).
 */
async function handleGeneratePlan(
  d: Extract<ManagerDirective, { kind: 'generate_plan' }>,
  ctx: DirectiveContext,
  actionId: string,
): Promise<unknown> {
  // Resolve projectId (same pattern as handleStartRun).
  let projectId = d.projectId;
  if (!projectId) {
    const recent = db
      .select()
      .from(chatActions)
      .where(eq(chatActions.threadId, ctx.threadId))
      .orderBy(desc(chatActions.createdAt))
      .all();
    const created = recent.find((r) => r.kind === 'create_project' && r.status === 'ok');
    const result = created?.resultJson as { projectId?: string } | null | undefined;
    if (!result?.projectId) {
      throw new Error('no_project: pass projectId or create_project first');
    }
    projectId = result.projectId;
  }

  // Eager validation — fail fast (synchronous throw → status persisted as
  // 'failed' immediately) before launching the background job.
  const project = db.select().from(projectsTable).where(eq(projectsTable.id, projectId)).get();
  if (!project) throw new Error(`project_not_found: ${projectId}`);
  const teamRow = db.select().from(teamsTable).where(eq(teamsTable.projectId, projectId)).get();
  if (!teamRow) throw new Error('team_missing: configure a team before generating a plan');

  const threadId = ctx.threadId;
  const targetProjectId = projectId;

  // Background job — intentionally NOT awaited. Reuses the existing plan-gen
  // route over loopback HTTP (zero changes to the critical plan path) and
  // always sends x-allow-unbriefed: 1 (create_project seeds an unready brief).
  void (async () => {
    try {
      // Defer past the synchronous chat_actions INSERT that executeDirective
      // performs after this handler returns (a microtask), so the bg job's
      // UPDATE/patch provably targets an existing row even on a sync throw.
      await new Promise((resolve) => setImmediate(resolve));
      // WISP_HOST is a BIND address; 0.0.0.0 / :: are not valid connect targets
      // (ECONNREFUSED on Windows/macOS). Normalize to loopback for the self-call
      // — the server always answers on loopback when bound to a wildcard.
      const connectHost =
        env.WISP_HOST === '0.0.0.0' || env.WISP_HOST === '::' ? '127.0.0.1' : env.WISP_HOST;
      const base = `http://${connectHost}:${env.WISP_PORT}`;
      const planRes = await fetch(`${base}/api/projects/${targetProjectId}/plan`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'x-allow-unbriefed': '1' },
        body: '{}',
        signal: AbortSignal.timeout(240_000),
      });
      const planData = (await planRes.json().catch(() => ({}))) as {
        id?: string;
        error?: string;
        message?: string;
      };
      if (!planRes.ok || !planData.id) {
        const err = planData.error || planData.message || `plan_gen_http_${planRes.status}`;
        patchActionFailed(actionId, threadId, err);
        return;
      }
      const planId = planData.id;

      const lockRes = await fetch(`${base}/api/plans/${planId}/lock`, {
        method: 'POST',
        signal: AbortSignal.timeout(15_000),
      });
      if (!lockRes.ok) {
        const lockData = (await lockRes.json().catch(() => ({}))) as {
          error?: string;
          message?: string;
        };
        const err = lockData.error || lockData.message || `lock_http_${lockRes.status}`;
        // Remove the orphaned unlocked draft this job just created so a retry
        // or start_run can't pick it up (plan recency ordering is by UUID, not
        // time, so a stray draft is a real hazard).
        try {
          sqlite.prepare(`DELETE FROM plans WHERE id = ? AND status = 'draft'`).run(planId);
        } catch {
          /* best-effort */
        }
        patchActionFailed(actionId, threadId, err);
        return;
      }

      const resultJson = { projectId: targetProjectId, planId };
      sqlite
        .prepare(`UPDATE chat_actions SET status = ?, result_json = ? WHERE id = ?`)
        .run('ok', JSON.stringify(resultJson), actionId);
      publishToThread(threadId, {
        type: 'chat.action-update',
        threadId,
        actionId,
        status: 'ok',
        resultJson,
      });
    } catch (err) {
      patchActionFailed(actionId, threadId, err instanceof Error ? err.message : String(err));
    }
  })();

  return { projectId: targetProjectId, planGenStarted: true };
}

/** Patch a generate_plan chat_actions row to 'failed' + notify subscribers. */
function patchActionFailed(actionId: string, threadId: string, error: string): void {
  const resultJson = { error };
  try {
    sqlite
      .prepare(`UPDATE chat_actions SET status = 'failed', result_json = ? WHERE id = ?`)
      .run(JSON.stringify(resultJson), actionId);
  } catch {
    // ignore — the row may not exist if the DB was closed mid-flight (tests).
  }
  publishToThread(threadId, {
    type: 'chat.action-update',
    threadId,
    actionId,
    status: 'failed',
    resultJson,
  });
}

async function handleInvokeSkill(
  d: Extract<ManagerDirective, { kind: 'invoke_skill' }>,
  ctx: DirectiveContext,
  out: ExtraMessage[],
): Promise<unknown> {
  if (!ctx.skillRegistry) throw new Error('skills_not_configured');
  const skillResult = await invokeSkill({
    registry: ctx.skillRegistry,
    name: d.name,
    args: d.args,
    runner: ctx.runner,
  });
  if (skillResult.failed === 'skill_not_found') {
    throw new Error(`unknown_skill: ${d.name}`);
  }

  const manager = db.select().from(agents).where(eq(agents.seedKey, 'manager')).get();
  if (!manager) throw new Error('manager_agent_missing');

  const messageId = randomUUID();
  const createdAt = new Date();
  const content =
    skillResult.text ||
    (skillResult.failed ? `(skill failed: ${skillResult.failed})` : '(no output)');

  sqlite
    .prepare(
      `INSERT INTO agent_messages
         (id, thread_id, role, content, tokens_in, tokens_out, duration_ms,
          error_reason, author_agent_id, created_at)
       VALUES (?, ?, 'assistant', ?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(
      messageId,
      ctx.threadId,
      content,
      skillResult.tokensIn || null,
      skillResult.tokensOut || null,
      skillResult.durationMs,
      skillResult.failed,
      manager.id,
      createdAt.getTime(),
    );

  out.push({
    id: messageId,
    threadId: ctx.threadId,
    role: 'assistant',
    content,
    authorAgentId: manager.id,
    tokensIn: skillResult.tokensIn || null,
    tokensOut: skillResult.tokensOut || null,
    durationMs: skillResult.durationMs,
    errorReason: skillResult.failed,
    createdAt,
  });

  return {
    skillName: skillResult.skillName,
    durationMs: skillResult.durationMs,
    tokensIn: skillResult.tokensIn,
    tokensOut: skillResult.tokensOut,
    failed: skillResult.failed,
  };
}

/** Soft cap on directives executed per turn — guards against runaway loops. */
export const MAX_DIRECTIVES_PER_TURN = 4;

/**
 * Resolve the seed-key suffix used by team_role names back to an Agent row,
 * falling back to seedKey or name. Used by the route layer.
 */
export function ensureThreadHasManager(threadId: string): void {
  const existing = db
    .select()
    .from(threadParticipants)
    .where(eq(threadParticipants.threadId, threadId))
    .all();
  if (existing.find((p) => p.role === 'manager')) return;
  const manager = db.select().from(agents).where(eq(agents.seedKey, 'manager')).get();
  if (!manager) return; // seeder will add later, never block
  // Look up the existing thread to check if it's a manager-owned thread or a
  // legacy single-agent thread we should leave alone.
  const thread = db.select().from(agentThreads).where(eq(agentThreads.id, threadId)).get();
  if (!thread) return;
  // Only auto-promote when the thread's primary agent IS the manager, so
  // legacy single-agent threads (Lena talking to user) keep their behavior.
  if (thread.agentId !== manager.id) return;
  sqlite
    .prepare(
      `INSERT OR IGNORE INTO thread_participants (thread_id, agent_id, role, joined_at)
       VALUES (?, ?, 'manager', ?)`,
    )
    .run(threadId, manager.id, Date.now());
}
