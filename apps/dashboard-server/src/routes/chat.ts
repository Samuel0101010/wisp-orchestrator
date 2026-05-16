/**
 * Agent chat (Model B + chat v2) — threads, participants, messages, directives.
 *
 * Threads
 *   POST   /api/agents/:agentId/threads                  create
 *   GET    /api/agents/:agentId/threads                  list (newest first)
 *   GET    /api/threads/:threadId                        thread + agent + project
 *   PATCH  /api/threads/:threadId                        rename
 *   DELETE /api/threads/:threadId
 *   POST   /api/threads/:threadId/compress               summarise → 1 system msg
 *
 * Participants (chat v2)
 *   GET    /api/threads/:threadId/participants
 *   POST   /api/threads/:threadId/participants           body: { agentId, role? }
 *   DELETE /api/threads/:threadId/participants/:agentId
 *
 * Messages
 *   GET    /api/threads/:threadId/messages               oldest → newest
 *   POST   /api/threads/:threadId/messages               send + replies
 *
 * Send semantics
 *   - One user row is persisted immediately (write-ahead).
 *   - One pending assistant stub is also persisted immediately so a hard
 *     process kill leaves a recoverable errorReason='pending' marker rather
 *     than an orphaned user message.
 *   - The "responder" is determined by:
 *       1. body.addressedTo if set (must be a participant)
 *       2. first @mention in the content matching a participant
 *       3. the manager participant (chat v2 multi-agent threads)
 *       4. the thread's primary agent (legacy single-agent threads)
 *   - If the responder is the manager, its reply is parsed for
 *     <<ACTION>>{...}<<END>> directives. Each directive runs through
 *     chat-directives.ts and may yield additional `assistant` rows
 *     (e.g. consult creates a fresh assistant message from the consulted
 *     specialist).
 *   - The response body has shape { user, assistants[], actions[] } where
 *     assistants[0] is always the primary responder.
 *
 * Audit trail
 *   chat_actions rows are inserted for every directive (success or fail) so
 *   the UI can render "Manager created project X" inline cards.
 */

import { randomUUID } from 'node:crypto';
import { asc, desc, eq } from 'drizzle-orm';
import type { FastifyPluginAsync } from 'fastify';
import { z } from 'zod';
import {
  agents,
  agentMessages,
  agentThreads,
  addParticipantInputSchema,
  chatActions,
  createThreadInputSchema,
  projects,
  sendMessageInputSchema,
  threadParticipants,
  type AgentModel,
} from '@wisp/schemas';
import { runClaude, type SubprocessRunner } from '@wisp/orchestrator';
import { db, sqlite } from '../db/index.js';
import { env } from '../env.js';
import { getLastAuthProbe } from '../auth-status.js';
import { wrap } from './wrap.js';
import {
  composePrompt,
  parseDirectives,
  parseMentions,
  runAgentTurn,
  type HistoryMessage,
} from './chat-engine.js';
import {
  executeDirective,
  ensureThreadHasManager,
  MAX_DIRECTIVES_PER_TURN,
  type ExecutedDirective,
} from './chat-directives.js';
import type { SkillRegistry } from '../skills/registry.js';

export interface ChatRouterDeps {
  /** Test seam — swap the underlying runner. Default: real runClaude. */
  runner?: SubprocessRunner;
  skillRegistry?: SkillRegistry;
}

function stripDirectiveSigils(text: string): string {
  return text.replace(/<<ACTION>>/g, '«ACTION»').replace(/<<END>>/g, '«END»');
}

export function buildManagerSystemPrompt(
  base: string,
  registry: SkillRegistry | undefined,
): string {
  if (!registry) return base;
  const skills = registry.list();
  if (skills.length === 0) return base;
  const skillsList = skills
    .map((s) => {
      const desc = stripDirectiveSigils(s.description);
      const hint = s.argumentHint ? stripDirectiveSigils(s.argumentHint) : null;
      return `- ${s.name}: ${desc}` + (hint ? ` (args: ${hint})` : '');
    })
    .join('\n');
  return `${base}\n\n## Available skills\n\nUse <<ACTION>>{"kind":"invoke_skill","name":"<NAME>","args":"<args>"}<<END>> to invoke:\n${skillsList}`;
}

function autoTitle(firstMessage: string): string {
  const trimmed = firstMessage.trim().replace(/\s+/g, ' ');
  if (trimmed.length <= 60) return trimmed;
  return trimmed.slice(0, 57) + '…';
}

interface AgentRow {
  id: string;
  name: string;
  model: AgentModel;
  systemPrompt: string;
  allowedTools: string[];
  seedKey: string | null;
}

function loadAgent(id: string): AgentRow | null {
  const a = db
    .select({
      id: agents.id,
      name: agents.name,
      model: agents.model,
      systemPrompt: agents.systemPrompt,
      allowedTools: agents.allowedTools,
      seedKey: agents.seedKey,
    })
    .from(agents)
    .where(eq(agents.id, id))
    .get();
  return a ?? null;
}

function listParticipantAgents(threadId: string): Array<AgentRow & { role: 'manager' | 'member' }> {
  const rows = db
    .select({
      agentId: threadParticipants.agentId,
      role: threadParticipants.role,
    })
    .from(threadParticipants)
    .where(eq(threadParticipants.threadId, threadId))
    .all();
  const out: Array<AgentRow & { role: 'manager' | 'member' }> = [];
  for (const r of rows) {
    const a = loadAgent(r.agentId);
    if (a) out.push({ ...a, role: r.role as 'manager' | 'member' });
  }
  return out;
}

export function createChatRouter(deps: ChatRouterDeps = {}): FastifyPluginAsync {
  const runner: SubprocessRunner = deps.runner ?? runClaude;

  return async (app) => {
    // ---------- Threads ----------

    app.post(
      '/api/agents/:agentId/threads',
      wrap(async (req, reply) => {
        const { agentId } = z.object({ agentId: z.string().min(1) }).parse(req.params);
        const parsed = createThreadInputSchema.safeParse(req.body ?? {});
        if (!parsed.success) {
          reply.code(400);
          return { error: 'invalid_body', issues: parsed.error.issues };
        }
        const agent = await db.select().from(agents).where(eq(agents.id, agentId)).get();
        if (!agent) {
          reply.code(404);
          return { error: 'agent_not_found' };
        }
        if (parsed.data.projectId != null) {
          const proj = await db
            .select()
            .from(projects)
            .where(eq(projects.id, parsed.data.projectId))
            .get();
          if (!proj) {
            reply.code(400);
            return { error: 'project_not_found' };
          }
        }
        const now = new Date();
        const row = {
          id: randomUUID(),
          agentId,
          projectId: parsed.data.projectId ?? null,
          title: parsed.data.title ?? null,
          createdAt: now,
          updatedAt: now,
        };
        const tx = sqlite.transaction(() => {
          sqlite
            .prepare(
              `INSERT INTO agent_threads (id, agent_id, project_id, title, created_at, updated_at)
               VALUES (?, ?, ?, ?, ?, ?)`,
            )
            .run(
              row.id,
              row.agentId,
              row.projectId,
              row.title,
              row.createdAt.getTime(),
              row.updatedAt.getTime(),
            );
          // Auto-add the primary agent as a participant. Role depends on
          // whether they're the seed manager.
          const role = agent.seedKey === 'manager' ? 'manager' : 'member';
          sqlite
            .prepare(
              `INSERT INTO thread_participants (thread_id, agent_id, role, joined_at)
               VALUES (?, ?, ?, ?)`,
            )
            .run(row.id, agentId, role, row.createdAt.getTime());
        });
        tx();
        reply.code(201);
        return row;
      }),
    );

    app.get(
      '/api/agents/:agentId/threads',
      wrap(async (req, reply) => {
        const { agentId } = z.object({ agentId: z.string().min(1) }).parse(req.params);
        const agent = await db.select().from(agents).where(eq(agents.id, agentId)).get();
        if (!agent) {
          reply.code(404);
          return { error: 'agent_not_found' };
        }
        const rows = await db
          .select()
          .from(agentThreads)
          .where(eq(agentThreads.agentId, agentId))
          .orderBy(desc(agentThreads.updatedAt))
          .all();
        return rows;
      }),
    );

    app.get(
      '/api/threads/:threadId',
      wrap(async (req, reply) => {
        const { threadId } = z.object({ threadId: z.string().min(1) }).parse(req.params);
        const thread = await db
          .select()
          .from(agentThreads)
          .where(eq(agentThreads.id, threadId))
          .get();
        if (!thread) {
          reply.code(404);
          return { error: 'thread_not_found' };
        }
        const agent = await db.select().from(agents).where(eq(agents.id, thread.agentId)).get();
        const project = thread.projectId
          ? await db.select().from(projects).where(eq(projects.id, thread.projectId)).get()
          : null;
        const participants = listParticipantAgents(threadId).map((p) => ({
          agentId: p.id,
          name: p.name,
          seedKey: p.seedKey,
          role: p.role,
        }));
        const actions = await db
          .select()
          .from(chatActions)
          .where(eq(chatActions.threadId, threadId))
          .orderBy(asc(chatActions.createdAt))
          .all();
        return {
          thread,
          agent: agent ?? null,
          project: project ?? null,
          participants,
          actions,
        };
      }),
    );

    app.patch(
      '/api/threads/:threadId',
      wrap(async (req, reply) => {
        const { threadId } = z.object({ threadId: z.string().min(1) }).parse(req.params);
        const body = z
          .object({ title: z.string().max(200).nullable().optional() })
          .refine((v) => v.title !== undefined, { message: 'title required' })
          .parse(req.body);
        const existing = await db
          .select()
          .from(agentThreads)
          .where(eq(agentThreads.id, threadId))
          .get();
        if (!existing) {
          reply.code(404);
          return { error: 'thread_not_found' };
        }
        await db
          .update(agentThreads)
          .set({ title: body.title ?? null, updatedAt: new Date() })
          .where(eq(agentThreads.id, threadId))
          .run();
        const updated = await db
          .select()
          .from(agentThreads)
          .where(eq(agentThreads.id, threadId))
          .get();
        return updated ?? existing;
      }),
    );

    app.delete(
      '/api/threads/:threadId',
      wrap(async (req, reply) => {
        const { threadId } = z.object({ threadId: z.string().min(1) }).parse(req.params);
        const existing = await db
          .select()
          .from(agentThreads)
          .where(eq(agentThreads.id, threadId))
          .get();
        if (!existing) {
          reply.code(404);
          return { error: 'thread_not_found' };
        }
        await db.delete(agentThreads).where(eq(agentThreads.id, threadId)).run();
        reply.code(204);
        return null;
      }),
    );

    // ---------- Participants ----------

    app.get(
      '/api/threads/:threadId/participants',
      wrap(async (req, reply) => {
        const { threadId } = z.object({ threadId: z.string().min(1) }).parse(req.params);
        const thread = await db
          .select()
          .from(agentThreads)
          .where(eq(agentThreads.id, threadId))
          .get();
        if (!thread) {
          reply.code(404);
          return { error: 'thread_not_found' };
        }
        return listParticipantAgents(threadId).map((p) => ({
          agentId: p.id,
          name: p.name,
          seedKey: p.seedKey,
          role: p.role,
        }));
      }),
    );

    app.post(
      '/api/threads/:threadId/participants',
      wrap(async (req, reply) => {
        const { threadId } = z.object({ threadId: z.string().min(1) }).parse(req.params);
        const parsed = addParticipantInputSchema.safeParse(req.body);
        if (!parsed.success) {
          reply.code(400);
          return { error: 'invalid_body', issues: parsed.error.issues };
        }
        const thread = await db
          .select()
          .from(agentThreads)
          .where(eq(agentThreads.id, threadId))
          .get();
        if (!thread) {
          reply.code(404);
          return { error: 'thread_not_found' };
        }
        const agent = await db
          .select()
          .from(agents)
          .where(eq(agents.id, parsed.data.agentId))
          .get();
        if (!agent) {
          reply.code(404);
          return { error: 'agent_not_found' };
        }
        // If a manager already exists and the new participant is requested as
        // 'manager', demote to 'member' (we only allow one).
        let role = parsed.data.role;
        if (role === 'manager') {
          const hasManager = await db
            .select()
            .from(threadParticipants)
            .where(eq(threadParticipants.threadId, threadId))
            .all();
          if (hasManager.find((p) => p.role === 'manager')) {
            role = 'member';
          }
        }
        try {
          sqlite
            .prepare(
              `INSERT INTO thread_participants (thread_id, agent_id, role, joined_at)
               VALUES (?, ?, ?, ?)`,
            )
            .run(threadId, agent.id, role, Date.now());
        } catch (err) {
          // Composite PK collision = already a member.
          if (err instanceof Error && /UNIQUE constraint failed/i.test(err.message)) {
            reply.code(409);
            return { error: 'already_participant' };
          }
          throw err;
        }
        reply.code(201);
        return { agentId: agent.id, name: agent.name, role };
      }),
    );

    app.delete(
      '/api/threads/:threadId/participants/:agentId',
      wrap(async (req, reply) => {
        const { threadId, agentId } = z
          .object({ threadId: z.string().min(1), agentId: z.string().min(1) })
          .parse(req.params);
        const existing = await db
          .select()
          .from(threadParticipants)
          .where(eq(threadParticipants.threadId, threadId))
          .all();
        const target = existing.find((p) => p.agentId === agentId);
        if (!target) {
          reply.code(404);
          return { error: 'participant_not_found' };
        }
        if (target.role === 'manager') {
          reply.code(409);
          return { error: 'cannot_remove_manager' };
        }
        sqlite
          .prepare(`DELETE FROM thread_participants WHERE thread_id = ? AND agent_id = ?`)
          .run(threadId, agentId);
        reply.code(204);
        return null;
      }),
    );

    // ---------- Compress thread ----------

    app.post(
      '/api/threads/:threadId/compress',
      wrap(async (req, reply) => {
        const { threadId } = z.object({ threadId: z.string().min(1) }).parse(req.params);
        const thread = await db
          .select()
          .from(agentThreads)
          .where(eq(agentThreads.id, threadId))
          .get();
        if (!thread) {
          reply.code(404);
          return { error: 'thread_not_found' };
        }
        const messages = await db
          .select()
          .from(agentMessages)
          .where(eq(agentMessages.threadId, threadId))
          .orderBy(asc(agentMessages.createdAt))
          .all();
        if (messages.length < 4) {
          return { compressed: false, reason: 'not_enough_messages' };
        }
        // Use the manager (or thread's primary agent) to summarise.
        const manager = await db.select().from(agents).where(eq(agents.seedKey, 'manager')).get();
        const summariser = manager ?? loadAgent(thread.agentId);
        if (!summariser) {
          reply.code(500);
          return { error: 'no_summariser_agent_available' };
        }
        const transcript = messages.map((m) => `${m.role}: ${m.content}`).join('\n\n');
        const summaryPrompt =
          'Summarise the conversation below into 4–8 short bullet points covering ' +
          'decisions, open questions, and any action items. Keep it neutral, ' +
          'preserve names of people / projects, and do not invent facts. ' +
          'Output the bullets only — no preamble.';
        const turn = await runAgentTurn({
          systemPrompt: summaryPrompt,
          prompt: transcript,
          allowedTools: [],
          model: summariser.model,
          taskId: `chat-compress-${threadId.slice(0, 8)}`,
          runner: deps.runner ?? runner,
        });
        if (turn.failed || !turn.text.trim()) {
          reply.code(502);
          return { compressed: false, error: turn.failed ?? 'empty_summary' };
        }
        // Replace messages atomically: keep the first user msg + insert one
        // assistant summary message authored by the summariser.
        const firstUser = messages.find((m) => m.role === 'user');
        const summaryId = randomUUID();
        const tx = sqlite.transaction(() => {
          sqlite.prepare(`DELETE FROM agent_messages WHERE thread_id = ?`).run(threadId);
          if (firstUser) {
            sqlite
              .prepare(
                `INSERT INTO agent_messages
                   (id, thread_id, role, content, tokens_in, tokens_out, duration_ms,
                    error_reason, author_agent_id, created_at)
                 VALUES (?, ?, 'user', ?, NULL, NULL, NULL, NULL, NULL, ?)`,
              )
              .run(firstUser.id, threadId, firstUser.content, firstUser.createdAt.getTime());
          }
          sqlite
            .prepare(
              `INSERT INTO agent_messages
                 (id, thread_id, role, content, tokens_in, tokens_out, duration_ms,
                  error_reason, author_agent_id, created_at)
               VALUES (?, ?, 'assistant', ?, ?, ?, ?, NULL, ?, ?)`,
            )
            .run(
              summaryId,
              threadId,
              `[Conversation summary]\n${turn.text.trim()}`,
              turn.tokensIn || null,
              turn.tokensOut || null,
              turn.durationMs,
              summariser.id,
              Date.now(),
            );
        });
        tx();
        return {
          compressed: true,
          remainingMessageCount: firstUser ? 2 : 1,
          summaryTokens: turn.tokensOut,
          summaryDurationMs: turn.durationMs,
        };
      }),
    );

    // ---------- Messages ----------

    app.get(
      '/api/threads/:threadId/messages',
      wrap(async (req, reply) => {
        const { threadId } = z.object({ threadId: z.string().min(1) }).parse(req.params);
        const thread = await db
          .select()
          .from(agentThreads)
          .where(eq(agentThreads.id, threadId))
          .get();
        if (!thread) {
          reply.code(404);
          return { error: 'thread_not_found' };
        }
        const rows = await db
          .select()
          .from(agentMessages)
          .where(eq(agentMessages.threadId, threadId))
          .orderBy(asc(agentMessages.createdAt))
          .all();
        return rows;
      }),
    );

    app.post(
      '/api/threads/:threadId/messages',
      wrap(async (req, reply) => {
        const { threadId } = z.object({ threadId: z.string().min(1) }).parse(req.params);
        const parsed = sendMessageInputSchema.safeParse(req.body);
        if (!parsed.success) {
          reply.code(400);
          return { error: 'invalid_body', issues: parsed.error.issues };
        }

        const thread = await db
          .select()
          .from(agentThreads)
          .where(eq(agentThreads.id, threadId))
          .get();
        if (!thread) {
          reply.code(404);
          return { error: 'thread_not_found' };
        }

        // Make sure the manager is auto-promoted on legacy threads that
        // pre-date chat v2 (no-op for new threads — already added on create).
        ensureThreadHasManager(threadId);

        // Determine the responder.
        const participants = listParticipantAgents(threadId);
        if (participants.length === 0) {
          // Fallback: use the thread's primary agent as a one-shot responder.
          const primary = loadAgent(thread.agentId);
          if (!primary) {
            reply.code(404);
            return { error: 'agent_not_found' };
          }
          participants.push({ ...primary, role: 'member' });
        }
        const responder = pickResponder(participants, parsed.data, thread.agentId);
        if (!responder) {
          reply.code(404);
          return { error: 'no_responder_found' };
        }

        if (env.WISP_AUTH_MODE === 'subscription' && !env.WISP_MOCK_CLI) {
          const last = getLastAuthProbe();
          if (last && !last.ok) {
            reply.code(503);
            return { error: 'auth-failed', hint: last.hint };
          }
        }

        // Write-ahead: persist user msg + pending assistant stub + (maybe)
        // auto-title in one transaction so a hard kill leaves recoverable
        // state, not orphaned messages.
        const now = new Date();
        const userMsgId = randomUUID();
        const assistantId = randomUUID();
        const tx = sqlite.transaction(() => {
          sqlite
            .prepare(
              `INSERT INTO agent_messages
                 (id, thread_id, role, content, tokens_in, tokens_out, duration_ms,
                  error_reason, author_agent_id, created_at)
               VALUES (?, ?, 'user', ?, NULL, NULL, NULL, NULL, NULL, ?)`,
            )
            .run(userMsgId, threadId, parsed.data.content, now.getTime());
          sqlite
            .prepare(
              `INSERT INTO agent_messages
                 (id, thread_id, role, content, tokens_in, tokens_out, duration_ms,
                  error_reason, author_agent_id, created_at)
               VALUES (?, ?, 'assistant', '', NULL, NULL, NULL, 'pending', ?, ?)`,
            )
            .run(assistantId, threadId, responder.id, now.getTime() + 1);
          const count =
            sqlite
              .prepare<
                unknown[],
                { c: number }
              >('SELECT COUNT(*) AS c FROM agent_messages WHERE thread_id = ?')
              .get(threadId)?.c ?? 0;
          if (count === 2 && !thread.title) {
            sqlite
              .prepare('UPDATE agent_threads SET title = ?, updated_at = ? WHERE id = ?')
              .run(autoTitle(parsed.data.content), now.getTime(), threadId);
          } else {
            sqlite
              .prepare('UPDATE agent_threads SET updated_at = ? WHERE id = ?')
              .run(now.getTime(), threadId);
          }
        });
        tx();

        // Build conversation history visible to the responder (oldest first,
        // skipping the just-inserted pending stub and any errored rows).
        const prior = await db
          .select()
          .from(agentMessages)
          .where(eq(agentMessages.threadId, threadId))
          .orderBy(asc(agentMessages.createdAt))
          .all();
        const history: HistoryMessage[] = prior
          .filter((m) => m.id !== userMsgId && m.id !== assistantId && m.errorReason == null)
          .map((m) => {
            const author = m.authorAgentId ? loadAgent(m.authorAgentId) : null;
            return {
              role: m.role as 'user' | 'assistant',
              content: m.content,
              authorName: author?.name,
            };
          });
        // If the responder is the manager, parse + execute directives.
        const isManager = responder.seedKey === 'manager';
        const effectiveSystemPrompt = isManager
          ? buildManagerSystemPrompt(responder.systemPrompt, deps.skillRegistry)
          : responder.systemPrompt;
        const composed = composePrompt(effectiveSystemPrompt, history, parsed.data.content, 'user');

        const turn = await runAgentTurn({
          systemPrompt: composed.systemPrompt,
          prompt: composed.prompt,
          allowedTools: responder.allowedTools,
          model: responder.model,
          taskId: `chat-${threadId.slice(0, 8)}-${responder.seedKey ?? 'agent'}`,
          runner: deps.runner ?? runner,
        });
        const parsedDirectives = isManager
          ? parseDirectives(turn.text)
          : { directives: [], errors: [], cleaned: turn.text };

        // Persist primary assistant message (UPDATE the pending stub).
        // Bug 7: never persist a literal "(no response)" sentinel as user-
        // visible content — if the subprocess exited cleanly but produced no
        // text (Claude returned tool-use only, or an empty result frame), tag
        // the row with errorReason='empty-response' so the UI renders an
        // error chip + retry affordance instead of showing the sentinel.
        const primaryContent = parsedDirectives.cleaned || turn.text || '';
        const errorReason =
          turn.failed ?? (primaryContent.length === 0 ? 'empty-response' : null);
        await db
          .update(agentMessages)
          .set({
            content: primaryContent,
            tokensIn: turn.tokensIn || null,
            tokensOut: turn.tokensOut || null,
            durationMs: turn.durationMs,
            errorReason,
            createdAt: new Date(),
          })
          .where(eq(agentMessages.id, assistantId))
          .run();
        await db
          .update(agentThreads)
          .set({ updatedAt: new Date() })
          .where(eq(agentThreads.id, threadId))
          .run();

        // Execute directives sequentially (capped). Each may persist an
        // additional message + an audit row.
        const executed: ExecutedDirective[] = [];
        const directives = parsedDirectives.directives.slice(0, MAX_DIRECTIVES_PER_TURN);
        for (const d of directives) {
          const r = await executeDirective(d.directive, {
            threadId,
            managerMessageId: assistantId,
            runner: deps.runner ?? runner,
            skillRegistry: deps.skillRegistry,
          });
          executed.push(r);
        }

        // Reload primary + extra messages so the response reflects the
        // canonical persisted shape (with createdAt etc).
        const primaryRow = await db
          .select()
          .from(agentMessages)
          .where(eq(agentMessages.id, assistantId))
          .get();
        const extraRows = executed.flatMap((e) =>
          e.extraMessages.map((m) => ({
            id: m.id,
            threadId: m.threadId,
            role: m.role,
            content: m.content,
            tokensIn: m.tokensIn,
            tokensOut: m.tokensOut,
            durationMs: m.durationMs,
            errorReason: m.errorReason,
            authorAgentId: m.authorAgentId,
            createdAt: m.createdAt,
          })),
        );

        const userRow = await db
          .select()
          .from(agentMessages)
          .where(eq(agentMessages.id, userMsgId))
          .get();

        if (turn.failed || errorReason) {
          reply.code(502);
        } else {
          reply.code(201);
        }
        return {
          user: userRow,
          assistants: [primaryRow, ...extraRows].filter(Boolean),
          actions: executed.map((e) => ({
            id: e.id,
            kind: e.kind,
            status: e.status,
            payload: e.payload,
            result: e.result,
          })),
          directiveErrors: parsedDirectives.errors,
        };
      }),
    );
  };
}

function pickResponder(
  participants: Array<AgentRow & { role: 'manager' | 'member' }>,
  body: { content: string; addressedTo?: string },
  primaryAgentId: string,
): (AgentRow & { role: 'manager' | 'member' }) | null {
  // 1. Explicit addressedTo wins (must be a participant).
  if (body.addressedTo) {
    const direct = participants.find((p) => p.id === body.addressedTo);
    if (direct) return direct;
    // Fall through if the addressedTo agent isn't a participant — we don't
    // silently route to someone else.
    return null;
  }
  // 2. @mention in content (first one matching a participant).
  const mentions = parseMentions(body.content);
  for (const m of mentions) {
    const lc = m.toLowerCase();
    const match = participants.find((p) => p.name.toLowerCase() === lc || p.seedKey === lc);
    if (match) return match;
  }
  // 3. Manager.
  const manager = participants.find((p) => p.role === 'manager');
  if (manager) return manager;
  // 4. Legacy: thread's primary agent.
  const primary = participants.find((p) => p.id === primaryAgentId);
  if (primary) return primary;
  return participants[0] ?? null;
}
