import { z } from 'zod';

// M1: only `'pass'` is emitted today. Verification failure flows through
// `task.failed`. M5 (QA replan loop) will reintroduce richer outcomes.
const taskOutcome = z.literal('pass');
const runOutcome = z.enum(['success', 'failure', 'budget_exceeded', 'cancelled']);
const pausedReason = z.enum(['rate-limit', 'user', 'shutdown', 'consecutive-failures']);
const resourceKind = z.enum(['time', 'turns']);

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
