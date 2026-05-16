/**
 * Interview routes (v1.9 Phase 1) — front the requirements-interviewer agent.
 *
 *   GET    /api/projects/:projectId/interview            current brief + transcript
 *   POST   /api/projects/:projectId/interview/start      ensure brief + thread; return state
 *   POST   /api/projects/:projectId/interview/message    body: { message }; runs one turn
 *   POST   /api/projects/:projectId/interview/finalize   write PRD.md, flip briefReady
 *   PATCH  /api/projects/:projectId/interview            direct manual edits to brief
 *
 * Storage
 *   - One `project_briefs` row per project (UNIQUE).
 *   - One `agent_threads` row per project (filtered by agentId = requirements-interviewer
 *     AND projectId), reused across calls. Messages persist in `agent_messages`.
 *
 * Why a dedicated thread (not a fresh ad-hoc one): re-opening the brief later
 * picks up the conversation, the UI can show prior turns, and the interviewer
 * agent gets the full context for free.
 */

import { randomUUID } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { and, asc, eq } from 'drizzle-orm';
import type { FastifyPluginAsync } from 'fastify';
import { z } from 'zod';
import { agentMessages, agentThreads, agents, projects, type BriefPatch } from '@wisp/schemas';
import { db, sqlite } from '../db/index.js';
import { wrap } from './wrap.js';
import type { SubprocessRunner } from '@wisp/orchestrator';
import type { HistoryMessage, RunAgentTurnResult } from './chat-engine.js';
import {
  applyBriefPatch,
  renderBriefAsPrdMarkdown,
  runInterviewerTurn,
  type BriefState,
} from '../orchestrator/interviewer-engine.js';

const INTERVIEWER_SEED_KEY = 'requirements-interviewer';

export interface InterviewRouterDeps {
  /** Test seam — swap the underlying subprocess runner. */
  runner?: SubprocessRunner;
  /** Test seam — swap the agent-turn fn entirely (skips runner). */
  turnImpl?: (
    args: Parameters<typeof runInterviewerTurn>[0] extends infer A
      ? A extends { turnImpl?: infer T }
        ? NonNullable<T> extends (a: infer X) => Promise<RunAgentTurnResult>
          ? X
          : never
        : never
      : never,
  ) => Promise<RunAgentTurnResult>;
}

interface BriefRow {
  id: string;
  projectId: string;
  targetAudience: string | null;
  successCriteria: string | null;
  designPrefs: string | null;
  platform: string | null;
  constraints: string | null;
  deadline: number | null;
  completenessScore: number;
  prdPath: string | null;
  briefReady: boolean;
  createdAt: number;
  updatedAt: number;
}

function rowToBriefState(row: BriefRow): BriefState {
  return {
    targetAudience: row.targetAudience,
    successCriteria: row.successCriteria,
    designPrefs: row.designPrefs,
    platform: row.platform,
    constraints: row.constraints,
    deadline: row.deadline,
    completenessScore: row.completenessScore,
    briefReady: row.briefReady,
  };
}

function getBriefRow(projectId: string): BriefRow | undefined {
  const raw = sqlite
    .prepare(
      `SELECT id, project_id as projectId, target_audience as targetAudience,
              success_criteria as successCriteria, design_prefs as designPrefs,
              platform, constraints, deadline,
              completeness_score as completenessScore, prd_path as prdPath,
              brief_ready as briefReady, created_at as createdAt, updated_at as updatedAt
       FROM project_briefs WHERE project_id = ?`,
    )
    .get(projectId) as (Omit<BriefRow, 'briefReady'> & { briefReady: number }) | undefined;
  if (!raw) return undefined;
  return { ...raw, briefReady: !!raw.briefReady };
}

/**
 * Idempotent create-if-missing. Returns the brief row (existing or newly
 * created). Used by both the dedicated route and by the create-project paths
 * to auto-seed an empty brief.
 */
export function ensureBriefRow(projectId: string): BriefRow {
  const existing = getBriefRow(projectId);
  if (existing) return existing;
  const now = Date.now();
  sqlite
    .prepare(
      `INSERT INTO project_briefs
         (id, project_id, completeness_score, brief_ready, created_at, updated_at)
       VALUES (?, ?, 0, 0, ?, ?)`,
    )
    .run(randomUUID(), projectId, now, now);
  return getBriefRow(projectId)!;
}

function getInterviewerAgentId(): { id: string; systemPrompt: string } | null {
  const a = db
    .select({ id: agents.id, systemPrompt: agents.systemPrompt })
    .from(agents)
    .where(eq(agents.seedKey, INTERVIEWER_SEED_KEY))
    .get();
  return a ?? null;
}

function getOrCreateInterviewerThread(projectId: string): string {
  const agent = getInterviewerAgentId();
  if (!agent) throw new Error('interviewer_agent_missing');
  const existing = db
    .select({ id: agentThreads.id })
    .from(agentThreads)
    .where(and(eq(agentThreads.projectId, projectId), eq(agentThreads.agentId, agent.id)))
    .get();
  if (existing) return existing.id;
  const id = randomUUID();
  const now = Date.now();
  sqlite
    .prepare(
      `INSERT INTO agent_threads (id, agent_id, project_id, title, created_at, updated_at)
       VALUES (?, ?, ?, 'Brief', ?, ?)`,
    )
    .run(id, agent.id, projectId, now, now);
  return id;
}

interface MessageRow {
  id: string;
  threadId: string;
  role: 'user' | 'assistant';
  content: string;
  createdAt: Date;
  authorAgentId: string | null;
}

function getThreadMessages(threadId: string): MessageRow[] {
  return db
    .select({
      id: agentMessages.id,
      threadId: agentMessages.threadId,
      role: agentMessages.role,
      content: agentMessages.content,
      createdAt: agentMessages.createdAt,
      authorAgentId: agentMessages.authorAgentId,
    })
    .from(agentMessages)
    .where(eq(agentMessages.threadId, threadId))
    .orderBy(asc(agentMessages.createdAt))
    .all();
}

function appendMessage(
  threadId: string,
  role: 'user' | 'assistant',
  content: string,
  authorAgentId: string | null,
  meta?: {
    tokensIn?: number;
    tokensOut?: number;
    durationMs?: number;
    errorReason?: string | null;
  },
): MessageRow {
  const id = randomUUID();
  const now = Date.now();
  sqlite
    .prepare(
      `INSERT INTO agent_messages
         (id, thread_id, role, content, tokens_in, tokens_out, duration_ms,
          error_reason, author_agent_id, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(
      id,
      threadId,
      role,
      content,
      meta?.tokensIn ?? null,
      meta?.tokensOut ?? null,
      meta?.durationMs ?? null,
      meta?.errorReason ?? null,
      authorAgentId,
      now,
    );
  return {
    id,
    threadId,
    role,
    content,
    createdAt: new Date(now),
    authorAgentId,
  };
}

function applyPatchToDb(projectId: string, brief: BriefState): void {
  const now = Date.now();
  sqlite
    .prepare(
      `UPDATE project_briefs SET
         target_audience = ?, success_criteria = ?, design_prefs = ?,
         platform = ?, constraints = ?, deadline = ?,
         completeness_score = ?, brief_ready = ?, updated_at = ?
       WHERE project_id = ?`,
    )
    .run(
      brief.targetAudience,
      brief.successCriteria,
      brief.designPrefs,
      brief.platform,
      brief.constraints,
      brief.deadline,
      brief.completenessScore,
      brief.briefReady ? 1 : 0,
      now,
      projectId,
    );
}

const patchBodySchema = z
  .object({
    targetAudience: z.string().min(1).max(2000).nullable().optional(),
    successCriteria: z.string().min(1).max(4000).nullable().optional(),
    designPrefs: z.string().min(1).max(4000).nullable().optional(),
    platform: z.string().min(1).max(500).nullable().optional(),
    constraints: z.string().min(1).max(4000).nullable().optional(),
    deadline: z.number().int().nonnegative().nullable().optional(),
    completenessScore: z.number().int().min(0).max(100).optional(),
    briefReady: z.boolean().optional(),
  })
  .refine((v) => Object.keys(v).length > 0, {
    message: 'patch body must include at least one field',
  });

export function createInterviewRouter(deps: InterviewRouterDeps = {}): FastifyPluginAsync {
  const router: FastifyPluginAsync = async (app) => {
    // GET /api/projects/:projectId/interview
    app.get(
      '/api/projects/:projectId/interview',
      wrap(async (req, reply) => {
        const { projectId } = z.object({ projectId: z.string().min(1) }).parse(req.params);
        const project = await db.select().from(projects).where(eq(projects.id, projectId)).get();
        if (!project) {
          reply.code(404);
          return { error: 'project not found' };
        }
        const brief = getBriefRow(projectId);
        const transcript = brief ? getThreadMessages(getOrCreateInterviewerThread(projectId)) : [];
        return {
          brief: brief ?? null,
          transcript,
        };
      }),
    );

    // POST /api/projects/:projectId/interview/start
    app.post(
      '/api/projects/:projectId/interview/start',
      wrap(async (req, reply) => {
        const { projectId } = z.object({ projectId: z.string().min(1) }).parse(req.params);
        const project = await db.select().from(projects).where(eq(projects.id, projectId)).get();
        if (!project) {
          reply.code(404);
          return { error: 'project not found' };
        }
        const brief = ensureBriefRow(projectId);
        const threadId = getOrCreateInterviewerThread(projectId);
        return {
          brief,
          threadId,
          transcript: getThreadMessages(threadId),
        };
      }),
    );

    // POST /api/projects/:projectId/interview/message
    app.post(
      '/api/projects/:projectId/interview/message',
      wrap(async (req, reply) => {
        const { projectId } = z.object({ projectId: z.string().min(1) }).parse(req.params);
        const body = z.object({ message: z.string().min(1).max(8000) }).parse(req.body ?? {});
        const project = await db.select().from(projects).where(eq(projects.id, projectId)).get();
        if (!project) {
          reply.code(404);
          return { error: 'project not found' };
        }
        const agent = getInterviewerAgentId();
        if (!agent) {
          reply.code(503);
          return { error: 'interviewer_agent_missing', hint: 'seeder did not install Sarah' };
        }
        const brief = ensureBriefRow(projectId);
        if (brief.briefReady) {
          reply.code(409);
          return {
            error: 'brief_already_finalised',
            hint: 'PATCH /api/projects/:id/interview to amend, or reset briefReady via PATCH first.',
          };
        }
        const threadId = getOrCreateInterviewerThread(projectId);

        const userMsg = appendMessage(threadId, 'user', body.message, null);

        const priorMessages = getThreadMessages(threadId).slice(0, -1); // exclude the just-inserted user message
        const history: HistoryMessage[] = priorMessages.map((m) => ({
          role: m.role,
          content: m.content,
        }));

        const turnArgs: Parameters<typeof runInterviewerTurn>[0] = {
          systemPrompt: agent.systemPrompt,
          current: rowToBriefState(brief),
          history,
          userMessage: body.message,
          taskId: `interview-${projectId.slice(0, 8)}`,
          runner: deps.runner,
        };
        if (deps.turnImpl) turnArgs.turnImpl = deps.turnImpl;
        const turn = await runInterviewerTurn(turnArgs);

        const assistantMsg = appendMessage(
          threadId,
          'assistant',
          turn.assistantText || '(no response)',
          agent.id,
          {
            tokensIn: turn.tokensIn,
            tokensOut: turn.tokensOut,
            durationMs: turn.durationMs,
            errorReason: turn.failed,
          },
        );

        // Persist brief updates. agentSignaledComplete flips briefReady too —
        // the agent decided we have enough, no separate finalize call needed.
        const nextBrief: BriefState = { ...turn.nextBrief };
        if (turn.agentSignaledComplete) nextBrief.briefReady = true;
        applyPatchToDb(projectId, nextBrief);

        return {
          userMessage: userMsg,
          assistantMessage: assistantMsg,
          brief: getBriefRow(projectId),
          shouldFinalize: turn.shouldFinalize,
          parseError: turn.parseError,
        };
      }),
    );

    // POST /api/projects/:projectId/interview/finalize
    app.post(
      '/api/projects/:projectId/interview/finalize',
      wrap(async (req, reply) => {
        const { projectId } = z.object({ projectId: z.string().min(1) }).parse(req.params);
        const project = await db.select().from(projects).where(eq(projects.id, projectId)).get();
        if (!project) {
          reply.code(404);
          return { error: 'project not found' };
        }
        const brief = ensureBriefRow(projectId);
        const state = rowToBriefState(brief);
        const md = renderBriefAsPrdMarkdown({ ...state, briefReady: true }, project.name);

        let prdPath: string | null = null;
        let prdWriteError: string | null = null;
        try {
          if (fs.existsSync(project.repoPath)) {
            const docsDir = path.join(project.repoPath, 'docs');
            fs.mkdirSync(docsDir, { recursive: true });
            const target = path.join(docsDir, 'PRD.md');
            fs.writeFileSync(target, md, 'utf8');
            prdPath = 'docs/PRD.md';
          } else {
            prdWriteError = `repo_path_missing: ${project.repoPath}`;
          }
        } catch (err) {
          prdWriteError = err instanceof Error ? err.message : String(err);
        }

        const now = Date.now();
        sqlite
          .prepare(
            `UPDATE project_briefs
                SET brief_ready = 1, prd_path = ?, updated_at = ?
              WHERE project_id = ?`,
          )
          .run(prdPath, now, projectId);

        return {
          brief: getBriefRow(projectId),
          prdPath,
          prdWriteError,
        };
      }),
    );

    // PATCH /api/projects/:projectId/interview — manual edits
    app.patch(
      '/api/projects/:projectId/interview',
      wrap(async (req, reply) => {
        const { projectId } = z.object({ projectId: z.string().min(1) }).parse(req.params);
        const patch = patchBodySchema.parse(req.body ?? {});
        const project = await db.select().from(projects).where(eq(projects.id, projectId)).get();
        if (!project) {
          reply.code(404);
          return { error: 'project not found' };
        }
        const brief = ensureBriefRow(projectId);
        const briefState = rowToBriefState(brief);

        // Manual PATCH is not subject to the monotone-completenessScore rule —
        // the user is in direct control and may legitimately lower the score
        // (e.g. they realised constraints are murkier than first thought).
        const next: BriefState = applyBriefPatch(briefState, patch as BriefPatch);
        if (patch.completenessScore !== undefined) next.completenessScore = patch.completenessScore;
        if (patch.briefReady !== undefined) next.briefReady = patch.briefReady;
        applyPatchToDb(projectId, next);
        return { brief: getBriefRow(projectId) };
      }),
    );
  };

  return router;
}

export const interviewRoutes: FastifyPluginAsync = createInterviewRouter();
