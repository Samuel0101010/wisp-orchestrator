import { z } from 'zod';

/**
 * Wire-level agent definition. Mirrors the `agents` SQL row but allows the
 * client to omit server-managed fields (id, timestamps).
 */
export const agentKindSchema = z.enum(['seed', 'user', 'team-backfill']);
export type AgentKind = z.infer<typeof agentKindSchema>;

export const agentSchema = z.object({
  id: z.string().min(1),
  name: z.string().min(1).max(120),
  model: z.enum(['opus', 'sonnet', 'haiku']),
  systemPrompt: z.string().min(1).max(8000),
  allowedTools: z.array(z.string()).max(64),
  color: z.string().max(40).nullable().optional(),
  description: z.string().max(2000).nullable().optional(),
  avatarUrl: z.string().max(400).nullable().optional(),
  seedKey: z.string().max(80).nullable().optional(),
  kind: agentKindSchema.optional(),
  createdAt: z.union([z.string(), z.number(), z.date()]),
  updatedAt: z.union([z.string(), z.number(), z.date()]),
});
export type Agent = z.infer<typeof agentSchema>;

export const createAgentInputSchema = z.object({
  name: z.string().min(1).max(120),
  model: z.enum(['opus', 'sonnet', 'haiku']),
  systemPrompt: z.string().min(1).max(8000),
  allowedTools: z.array(z.string()).max(64).default([]),
  color: z.string().max(40).optional(),
  description: z.string().max(2000).optional(),
  avatarUrl: z.string().max(400).optional(),
});
export type CreateAgentInput = z.infer<typeof createAgentInputSchema>;

export const updateAgentInputSchema = createAgentInputSchema
  .partial()
  .refine((v) => Object.keys(v).length > 0, { message: 'at least one field required' });
export type UpdateAgentInput = z.infer<typeof updateAgentInputSchema>;

/**
 * Thread (conversation) in chat. Soft-bound to projectId — null = cross-project.
 */
export const agentThreadSchema = z.object({
  id: z.string().min(1),
  agentId: z.string().min(1),
  projectId: z.string().min(1).nullable(),
  title: z.string().nullable(),
  createdAt: z.union([z.string(), z.number(), z.date()]),
  updatedAt: z.union([z.string(), z.number(), z.date()]),
});
export type AgentThread = z.infer<typeof agentThreadSchema>;

export const createThreadInputSchema = z.object({
  projectId: z.string().min(1).nullable().optional(),
  title: z.string().max(200).optional(),
});
export type CreateThreadInput = z.infer<typeof createThreadInputSchema>;

export const messageRoleSchema = z.enum(['user', 'assistant']);
export type MessageRole = z.infer<typeof messageRoleSchema>;

export const agentMessageSchema = z.object({
  id: z.string().min(1),
  threadId: z.string().min(1),
  role: messageRoleSchema,
  content: z.string(),
  tokensIn: z.number().int().nullable(),
  tokensOut: z.number().int().nullable(),
  durationMs: z.number().int().nullable(),
  errorReason: z.string().nullable(),
  authorAgentId: z.string().nullable().optional(),
  createdAt: z.union([z.string(), z.number(), z.date()]),
});
export type AgentMessage = z.infer<typeof agentMessageSchema>;

export const sendMessageInputSchema = z.object({
  content: z.string().min(1).max(16000),
  /**
   * If set, route the message to this specific agent (must already be a
   * participant of the thread). Otherwise the manager replies, unless the
   * content contains an @agent-name mention.
   */
  addressedTo: z.string().min(1).optional(),
  /**
   * IDs of files previously uploaded via POST /api/threads/:id/attachments.
   * The server resolves them against the per-thread upload index and makes
   * the files available to the manager turn (working directory + manifest).
   */
  attachmentIds: z.array(z.string()).max(10).optional(),
});
export type SendMessageInput = z.infer<typeof sendMessageInputSchema>;

export const sendMessageResponseSchema = z.object({
  user: agentMessageSchema,
  /**
   * Replies generated for this turn, in the order they were produced.
   * For a single-agent thread this is one entry; for multi-agent threads
   * the manager may also have triggered <<ACTION>> directives that produced
   * additional consult-replies — each lands as its own assistant message.
   */
  assistants: z.array(agentMessageSchema),
  /**
   * Side effects executed by manager directives (project created, member
   * added, …). UI surfaces these as inline action cards.
   */
  actions: z
    .array(
      z.object({
        id: z.string(),
        kind: z.enum([
          'consult',
          'add_member',
          'create_project',
          'start_run',
          'invoke_skill',
          'generate_plan',
          'import_brief',
        ]),
        status: z.enum(['pending', 'ok', 'failed']),
        payload: z.unknown(),
        result: z.unknown().nullable(),
      }),
    )
    .default([]),
  /**
   * Parse failures for <<ACTION>> blocks the manager emitted but that were
   * not valid directives (invalid JSON / wrong shape). Without surfacing
   * these, a malformed directive is silently dropped while the manager's
   * prose claims the action happened.
   */
  directiveErrors: z.array(z.string()).default([]),
});
export type SendMessageResponse = z.infer<typeof sendMessageResponseSchema>;

// ----- Multi-participant threads (chat v2) -----

export const participantRoleSchema = z.enum(['manager', 'member']);
export type ParticipantRole = z.infer<typeof participantRoleSchema>;

export const threadParticipantSchema = z.object({
  threadId: z.string().min(1),
  agentId: z.string().min(1),
  role: participantRoleSchema,
  joinedAt: z.union([z.string(), z.number(), z.date()]),
});
export type ThreadParticipant = z.infer<typeof threadParticipantSchema>;

export const addParticipantInputSchema = z.object({
  agentId: z.string().min(1),
  role: participantRoleSchema.default('member'),
});
export type AddParticipantInput = z.infer<typeof addParticipantInputSchema>;

// ----- Manager directives (chat v2) -----
//
// The manager system prompt teaches the model to embed structured directives
// in its replies as `<<ACTION>>{...json...}<<END>>`. The server parses each
// block, executes it, persists the result to chat_actions, and exposes the
// outcome on the SendMessage response.

export const consultDirectiveSchema = z.object({
  kind: z.literal('consult'),
  agent: z.string().min(1), // seed key or agent name (resolved server-side)
  question: z.string().min(1).max(8000),
});

export const addMemberDirectiveSchema = z.object({
  kind: z.literal('add_member'),
  agent: z.string().min(1),
});

export const createProjectDirectiveSchema = z.object({
  kind: z.literal('create_project'),
  name: z.string().min(1).max(120),
  goal: z.string().min(1).max(2000),
  repoPath: z.string().min(1).max(1000),
  // Seed-keys or agent names. If omitted, defaults to the current thread's
  // members (excluding the manager).
  team: z.array(z.string().min(1)).max(16).optional(),
});

export const startRunDirectiveSchema = z.object({
  kind: z.literal('start_run'),
  /**
   * Project to start a run on. If omitted, uses the most recently
   * create_project'd project from this thread.
   */
  projectId: z.string().min(1).optional(),
});

export const invokeSkillDirectiveSchema = z.object({
  kind: z.literal('invoke_skill'),
  name: z.string().min(1).max(80),
  args: z.string().max(8000).default(''),
});

export const generatePlanDirectiveSchema = z.object({
  kind: z.literal('generate_plan'),
  // Project to plan for. If omitted, resolves from the most recent
  // create_project action in this thread.
  projectId: z.string().min(1).optional(),
});

export const importBriefDirectiveSchema = z.object({
  kind: z.literal('import_brief'),
  /**
   * Project whose brief (docs/PRD.md) the attachment becomes. If omitted,
   * resolves from the most recent create_project action in this thread.
   */
  projectId: z.string().min(1).optional(),
  /** Filename of a markdown attachment previously uploaded to this thread. */
  filename: z.string().min(1).max(255),
});

export const directiveSchema = z.union([
  consultDirectiveSchema,
  addMemberDirectiveSchema,
  createProjectDirectiveSchema,
  startRunDirectiveSchema,
  invokeSkillDirectiveSchema,
  generatePlanDirectiveSchema,
  importBriefDirectiveSchema,
]);
export type ManagerDirective = z.infer<typeof directiveSchema>;
