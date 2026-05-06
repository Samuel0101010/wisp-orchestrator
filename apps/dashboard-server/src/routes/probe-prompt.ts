/**
 * POST /api/probe-prompt
 *
 * Lets the user test a system prompt against a sample goal without committing
 * to a full run. Spawns claude -p once with maxTurns capped low (2) in an
 * ephemeral tmp cwd, collects the response text and token usage, returns.
 *
 * Auth-gated like /api/runs: in subscription mode, refuses if the auth probe
 * is currently failing.
 *
 * NOT a heavy-duty endpoint — there's no walker, no DB persistence, no MCP
 * config injection. Probing is a UX convenience, not part of the run history.
 */

import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { z } from 'zod';
import type { FastifyPluginAsync } from 'fastify';
import { runClaude, type SubprocessRunner } from '@agent-harness/orchestrator';
import { wrap } from './wrap.js';
import { env } from '../env.js';
import { getLastAuthProbe } from '../auth-status.js';

export interface ProbePromptDeps {
  /** Test seam — swap the underlying runner. Default: real runClaude. */
  runner?: SubprocessRunner;
}

const PROBE_MAX_TURNS = 2;
const PROBE_TIMEOUT_MS = 90_000;

const bodySchema = z.object({
  systemPrompt: z.string().min(1).max(4000),
  sampleGoal: z.string().min(1).max(4000),
  model: z.enum(['opus', 'sonnet', 'haiku']),
  allowedTools: z.array(z.string()).max(64).default([]),
});

export function probePromptRoutes(deps: ProbePromptDeps = {}): FastifyPluginAsync {
  const runner: SubprocessRunner = deps.runner ?? runClaude;

  return async (app) => {
    app.post(
      '/api/probe-prompt',
      wrap(async (req, reply) => {
        const parsed = bodySchema.safeParse(req.body);
        if (!parsed.success) {
          reply.code(400);
          return { error: 'invalid_body', issues: parsed.error.issues };
        }
        const { systemPrompt, sampleGoal, model, allowedTools } = parsed.data;

        if (env.HARNESS_AUTH_MODE === 'subscription' && !env.HARNESS_MOCK_CLI) {
          const last = getLastAuthProbe();
          if (last && !last.ok) {
            reply.code(503);
            return { error: 'auth-failed', hint: last.hint };
          }
        }

        const tmp = await mkdtemp(join(tmpdir(), 'harness-probe-'));
        const ac = new AbortController();
        const timeoutId = setTimeout(() => ac.abort(), PROBE_TIMEOUT_MS);
        const t0 = Date.now();
        let response = '';
        let tokensIn = 0;
        let tokensOut = 0;
        let turns = 0;
        let failed: string | null = null;

        try {
          for await (const ev of runner({
            cwd: tmp,
            prompt: sampleGoal,
            systemPrompt,
            allowedTools,
            model,
            maxTurns: PROBE_MAX_TURNS,
            taskId: 'probe',
            signal: ac.signal,
          })) {
            if (ev.type === 'task.text-delta') {
              response += ev.payload.text;
            } else if (ev.type === 'task.usage') {
              tokensIn = ev.payload.tokensIn;
              tokensOut = ev.payload.tokensOut;
              turns = ev.payload.turns;
            } else if (ev.type === 'task.failed') {
              failed = ev.payload.error;
            }
          }
        } catch (err) {
          failed = err instanceof Error ? err.message : String(err);
        } finally {
          clearTimeout(timeoutId);
          await rm(tmp, { recursive: true, force: true }).catch(() => {
            /* best-effort */
          });
        }

        const elapsedMs = Date.now() - t0;

        if (failed) {
          reply.code(502);
          return {
            error: 'probe_failed',
            details: failed,
            partial: response,
            elapsedMs,
            tokensIn,
            tokensOut,
            turns,
          };
        }

        reply.code(200);
        return { response, elapsedMs, tokensIn, tokensOut, turns };
      }),
    );
  };
}
