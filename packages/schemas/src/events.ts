import { z } from 'zod';

// M1: only `'pass'` is emitted today. Verification failure flows through
// `task.failed`. M5 (QA replan loop) will reintroduce richer outcomes.
const taskOutcome = z.literal('pass');
const runOutcome = z.enum(['success', 'failure', 'budget_exceeded', 'cancelled']);
const pausedReason = z.enum(['rate-limit', 'user', 'shutdown', 'consecutive-failures']);
const resourceKind = z.enum(['time', 'turns', 'tokens']);

export const harnessEventSchema = z.discriminatedUnion('type', [
  z.object({
    type: z.literal('task.started'),
    payload: z.object({ taskId: z.string() }),
  }),
  z.object({
    type: z.literal('task.completed'),
    payload: z.object({
      taskId: z.string(),
      outcome: taskOutcome,
      exitCode: z.number().int(),
    }),
  }),
  z.object({
    type: z.literal('task.failed'),
    payload: z.object({ taskId: z.string(), error: z.string() }),
  }),
  z.object({
    type: z.literal('task.text-delta'),
    payload: z.object({ taskId: z.string(), text: z.string() }),
  }),
  z.object({
    type: z.literal('task.tool-use'),
    payload: z.object({
      taskId: z.string(),
      tool: z.string(),
      input: z.unknown(),
    }),
  }),
  z.object({
    type: z.literal('task.usage'),
    payload: z.object({
      taskId: z.string(),
      tokensIn: z.number().int().nonnegative(),
      tokensOut: z.number().int().nonnegative(),
      turns: z.number().int().nonnegative(),
    }),
  }),
  z.object({
    // Emitted once per task as soon as the subprocess surfaces a session id
    // (typically in the CLI's leading `system`/`init` frame). Persisted to
    // tasks.session_id so cold-resume after a server restart can re-launch
    // the task with `claude -p --resume <sessionId>` and pick up the
    // existing conversation context instead of starting from scratch.
    type: z.literal('task.session-id'),
    payload: z.object({ taskId: z.string(), sessionId: z.string().min(1) }),
  }),
  z.object({
    type: z.literal('task.max-turns-exhausted'),
    payload: z.object({
      taskId: z.string(),
      turnsUsed: z.number().int().nonnegative(),
      maxTurns: z.number().int().nonnegative(),
    }),
  }),
  z.object({
    type: z.literal('run.started'),
    payload: z.object({ runId: z.string() }),
  }),
  z.object({
    type: z.literal('run.paused'),
    payload: z.object({
      runId: z.string(),
      pausedReason,
      resumeAt: z.number().int().nullable(),
    }),
  }),
  z.object({
    type: z.literal('run.resumed'),
    payload: z.object({ runId: z.string() }),
  }),
  z.object({
    type: z.literal('run.completed'),
    payload: z.object({ runId: z.string(), outcome: runOutcome }),
  }),
  z.object({
    type: z.literal('resource.warning'),
    payload: z.object({
      runId: z.string(),
      kind: resourceKind,
      percent: z.number(),
    }),
  }),
  z.object({
    type: z.literal('resource.exceeded'),
    payload: z.object({ runId: z.string(), kind: resourceKind }),
  }),
  z.object({
    type: z.literal('rate-limit.hit'),
    payload: z.object({
      runId: z.string(),
      taskId: z.string().nullable(),
      resetAt: z.number().int().nullable(),
      source: z.string(),
    }),
  }),
  z.object({
    type: z.literal('harness.verify-failed'),
    payload: z.object({
      taskId: z.string(),
      attempt: z.number().int().positive(),
      failures: z.array(
        z.object({
          kind: z.enum(['build', 'test', 'lint', 'custom', 'preflight']),
          cmd: z.string(),
          exitCode: z.number().int(),
          tail: z.string(),
        }),
      ),
      output: z.string(),
    }),
  }),
  z.object({
    type: z.literal('qa.replan-triggered'),
    payload: z.object({
      runId: z.string(),
      failedTaskId: z.string(),
      reason: z.string(),
    }),
  }),
  z.object({
    type: z.literal('qa.replan-exhausted'),
    payload: z.object({
      runId: z.string(),
      failedTaskId: z.string(),
      reason: z.string(),
    }),
  }),
]);

export type HarnessEvent = z.infer<typeof harnessEventSchema>;
export type HarnessEventType = HarnessEvent['type'];

export function parseHarnessEvent(input: unknown): HarnessEvent {
  return harnessEventSchema.parse(input);
}

export function safeParseHarnessEvent(
  input: unknown,
): z.SafeParseReturnType<unknown, HarnessEvent> {
  return harnessEventSchema.safeParse(input);
}
