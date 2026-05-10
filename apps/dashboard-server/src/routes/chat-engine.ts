/**
 * Chat v2 engine — split out of routes/chat.ts to keep the route handlers
 * focused on HTTP/SQL plumbing.
 *
 *   runAgentTurn(opts)       Spawn `claude -p` for one agent and return the
 *                            full reply text, token counts and failure mode.
 *
 *   parseDirectives(text)    Pull out <<ACTION>>{...json...}<<END>> blocks
 *                            from a manager reply. Tolerant of extra
 *                            whitespace, garbage between directives, and
 *                            invalid JSON inside a block (skipped + reported).
 *
 *   composePrompt(...)       Builds the conversation transcript that the
 *                            agent sees in `--prompt`. Same shape as v1.
 */

import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  directiveSchema,
  type AgentModel,
  type ManagerDirective,
} from '@agent-harness/schemas';
import { runClaude, type SubprocessRunner } from '@agent-harness/orchestrator';

const CHAT_MAX_TURNS = 4;
const CHAT_TIMEOUT_MS = 180_000;
const CHAT_HISTORY_BUDGET_CHARS = 24_000;

export interface RunAgentTurnOpts {
  systemPrompt: string;
  prompt: string;
  allowedTools: string[];
  model: AgentModel;
  taskId: string;
  runner?: SubprocessRunner;
}

export interface RunAgentTurnResult {
  text: string;
  tokensIn: number;
  tokensOut: number;
  durationMs: number;
  failed: string | null;
}

export async function runAgentTurn(opts: RunAgentTurnOpts): Promise<RunAgentTurnResult> {
  const runner: SubprocessRunner = opts.runner ?? runClaude;
  const cwd = await mkdtemp(join(tmpdir(), 'harness-chat-'));
  const ac = new AbortController();
  const timeoutId = setTimeout(() => ac.abort(), CHAT_TIMEOUT_MS);
  const t0 = Date.now();
  let text = '';
  let tokensIn = 0;
  let tokensOut = 0;
  let failed: string | null = null;
  try {
    for await (const ev of runner({
      cwd,
      prompt: opts.prompt,
      systemPrompt: opts.systemPrompt,
      allowedTools: opts.allowedTools,
      model: opts.model,
      maxTurns: CHAT_MAX_TURNS,
      taskId: opts.taskId,
      signal: ac.signal,
    })) {
      if (ev.type === 'task.text-delta') {
        text += ev.payload.text;
      } else if (ev.type === 'task.usage') {
        tokensIn = ev.payload.tokensIn;
        tokensOut = ev.payload.tokensOut;
      } else if (ev.type === 'task.failed') {
        failed = ev.payload.error;
      }
    }
  } catch (err) {
    failed = err instanceof Error ? err.message : String(err);
  } finally {
    clearTimeout(timeoutId);
    await rm(cwd, { recursive: true, force: true }).catch(() => {
      /* best-effort */
    });
  }
  return { text, tokensIn, tokensOut, durationMs: Date.now() - t0, failed };
}

export interface HistoryMessage {
  role: 'user' | 'assistant';
  content: string;
  /** Display name of the speaker — useful in multi-agent transcripts. */
  authorName?: string;
}

export function composePrompt(
  systemPrompt: string,
  history: HistoryMessage[],
  next: string,
  nextSpeaker: string = 'user',
): { systemPrompt: string; prompt: string } {
  // Truncate from the front if the budget is exceeded.
  let chars = 0;
  const kept: HistoryMessage[] = [];
  for (let i = history.length - 1; i >= 0; i--) {
    const m = history[i]!;
    chars += m.content.length;
    if (chars > CHAT_HISTORY_BUDGET_CHARS) break;
    kept.unshift(m);
  }
  const transcript = kept
    .map((m) => `${m.authorName ? `${m.authorName} (${m.role})` : m.role}: ${m.content}`)
    .join('\n\n');
  const composed = transcript
    ? `--- conversation so far ---\n${transcript}\n\n--- new message ---\n${nextSpeaker}: ${next}`
    : next;
  return { systemPrompt, prompt: composed };
}

// ----- Directive parsing -----

export interface ParsedDirective {
  /** The validated, typed directive payload. */
  directive: ManagerDirective;
  /** The raw <<ACTION>>...<<END>> snippet, for audit/debugging. */
  raw: string;
}

export interface DirectiveParseError {
  raw: string;
  reason: string;
}

export interface DirectiveParseResult {
  directives: ParsedDirective[];
  errors: DirectiveParseError[];
  /** Reply text with the <<ACTION>> blocks stripped — what the user sees. */
  cleaned: string;
}

const DIRECTIVE_RE = /<<ACTION>>\s*([\s\S]*?)\s*<<END>>/g;

export function parseDirectives(text: string): DirectiveParseResult {
  const directives: ParsedDirective[] = [];
  const errors: DirectiveParseError[] = [];
  let cleaned = text;
  let m: RegExpExecArray | null;
  // Reset lastIndex on each call (regex literal is module-scoped).
  DIRECTIVE_RE.lastIndex = 0;
  while ((m = DIRECTIVE_RE.exec(text)) !== null) {
    const raw = m[0]!;
    const body = m[1]!.trim();
    let parsed: unknown;
    try {
      parsed = JSON.parse(body);
    } catch (err) {
      errors.push({ raw, reason: `invalid_json: ${err instanceof Error ? err.message : String(err)}` });
      continue;
    }
    const result = directiveSchema.safeParse(parsed);
    if (!result.success) {
      errors.push({ raw, reason: `invalid_shape: ${result.error.issues.map((i) => i.message).join('; ')}` });
      continue;
    }
    directives.push({ directive: result.data, raw });
  }
  // Strip every directive snippet from the cleaned text. Done in a second
  // pass so a single bad block doesn't pollute the prose the user sees.
  cleaned = text.replace(DIRECTIVE_RE, '').replace(/\n{3,}/g, '\n\n').trim();
  return { directives, errors, cleaned };
}

// ----- @mention parsing -----

const MENTION_RE = /(?:^|\s)@([a-zA-Z][a-zA-Z0-9_-]{0,40})/g;

/**
 * Extract @mention names from a user message. Returns the raw names (without
 * the @ sigil), order-preserving, deduplicated.
 */
export function parseMentions(text: string): string[] {
  const found: string[] = [];
  let m: RegExpExecArray | null;
  MENTION_RE.lastIndex = 0;
  while ((m = MENTION_RE.exec(text)) !== null) {
    const name = m[1]!;
    if (!found.includes(name)) found.push(name);
  }
  return found;
}
