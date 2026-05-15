/**
 * lead-runner — v2.0.0 Phase 8 (Lead Agent · Theo).
 *
 * One synthesis tick: gather everything we know about a project's current
 * situation, hand it to the lead agent (Theo) via runAgentTurn, parse the
 * structured `<<LEAD_DECISION>>` directive out of the reply, and persist
 * the result as a `lead_notes` row.
 *
 * Pure async — the caller owns HTTP plumbing. The `turnImpl` seam lets
 * tests substitute a scripted reply without spawning a Claude subprocess.
 */

import { randomUUID } from 'node:crypto';
import { and, desc, eq } from 'drizzle-orm';
import {
  agents,
  changeRequests as changeRequestsTable,
  events as eventsTable,
  leadNotes,
  parseLeadDecisionFromText,
  plans as plansTable,
  projectBriefs,
  projects,
  projectStates,
  runs as runsTable,
  type LeadDecision,
  type LeadDecisionsJson,
} from '@agent-harness/schemas';
import type { SubprocessRunner } from '@agent-harness/orchestrator';
import { db } from '../db/index.js';
import { runAgentTurn, type RunAgentTurnResult } from '../routes/chat-engine.js';
import { loadHandoffsForProject } from './handoff-loader.js';
import { env } from '../env.js';

const LEAD_SEED_KEY = 'lead';
const LEAD_TASK_ID = 'lead-tick';
const LAST_EVENT_LIMIT = 50;
const PRIOR_NOTES_LIMIT = 3;
const HANDOFF_LIMIT = 10;

export interface RunLeadTickArgs {
  projectId: string;
  /** Optional run the tick is scoped to. When set we use that run's events
   *  instead of auto-resolving the latest run on the project. */
  runId?: string;
  /** Test seam — overrides the agent-turn fn entirely. */
  turnImpl?: (args: Parameters<typeof runAgentTurn>[0]) => Promise<RunAgentTurnResult>;
  /** Test seam — passed through to runAgentTurn. */
  runner?: SubprocessRunner;
  /** Override the data dir used for handoff loading (tests). */
  dataDirOverride?: string;
}

export interface RunLeadTickResult {
  noteId: string;
  summary: string;
  decision: LeadDecision | null;
  parseError: string | null;
  tokensIn: number;
  tokensOut: number;
  durationMs: number;
  failed: string | null;
}

export interface LeadContextBundle {
  projectGoal: string;
  briefSection: string;
  stateSection: string;
  lastRunSection: string;
  openChangeRequestsSection: string;
  priorHandoffsSection: string;
  priorNotesSection: string;
}

function safe(value: string | null | undefined, fallback = '_(none)_'): string {
  if (value == null) return fallback;
  const trimmed = value.trim();
  return trimmed === '' ? fallback : trimmed;
}

function shorten(s: string, max: number): string {
  if (s.length <= max) return s;
  return s.slice(0, max - 1) + '…';
}

function getLeadSystemPrompt(): string {
  const row = db
    .select({ systemPrompt: agents.systemPrompt })
    .from(agents)
    .where(eq(agents.seedKey, LEAD_SEED_KEY))
    .get();
  // Fallback if the seeder hasn't run yet (tests, fresh DB). Keeps the
  // runner usable in degraded mode — the seeded prompt is the real one.
  return (
    row?.systemPrompt ??
    'You are Theo, the team lead. Read the context and emit one <<LEAD_DECISION>>{...}<<END>> directive after a short narrative.'
  );
}

/**
 * Build the markdown prompt body the lead sees. Exported for tests so they
 * can assert section composition without running the full tick.
 */
export function composeLeadPrompt(bundle: LeadContextBundle): string {
  return [
    '## Project goal',
    safe(bundle.projectGoal),
    '',
    '## Brief',
    bundle.briefSection,
    '',
    '## Current state',
    bundle.stateSection,
    '',
    '## Last run summary',
    bundle.lastRunSection,
    '',
    '## Open change requests',
    bundle.openChangeRequestsSection,
    '',
    '## Prior handoffs',
    bundle.priorHandoffsSection,
    '',
    '## Prior lead notes',
    bundle.priorNotesSection,
    '',
    'Now synthesise and emit your narrative followed by exactly one <<LEAD_DECISION>>{...}<<END>> directive.',
  ].join('\n');
}

interface BuildBundleArgs {
  projectId: string;
  project: typeof projects.$inferSelect;
  scopedRun: typeof runsTable.$inferSelect | null;
  dataDir: string;
}

function buildBundle(args: BuildBundleArgs): LeadContextBundle {
  const { projectId, project, scopedRun, dataDir } = args;

  // Brief.
  const briefRow = db
    .select()
    .from(projectBriefs)
    .where(eq(projectBriefs.projectId, projectId))
    .get();
  let briefSection = '_(no brief row)_';
  if (briefRow) {
    briefSection = [
      `- briefReady: ${briefRow.briefReady ? 'true' : 'false'}`,
      `- completeness: ${briefRow.completenessScore}%`,
      `- platform: ${safe(briefRow.platform)}`,
      `- targetAudience: ${safe(briefRow.targetAudience)}`,
      `- successCriteria: ${safe(briefRow.successCriteria)}`,
      `- designPrefs: ${safe(briefRow.designPrefs)}`,
      `- constraints: ${safe(briefRow.constraints)}`,
    ].join('\n');
  }

  // Latest project state snapshot.
  const stateRow = db
    .select()
    .from(projectStates)
    .where(eq(projectStates.projectId, projectId))
    .orderBy(desc(projectStates.createdAt))
    .get();
  let stateSection = '_(no project-state snapshot yet)_';
  if (stateRow) {
    const features = (stateRow.completedFeatures ?? []).slice(0, 12);
    const todos = (stateRow.openTodos ?? []).slice(0, 12);
    const issues = (stateRow.knownIssues ?? []).slice(0, 12);
    stateSection = [
      '### Implemented features',
      features.length ? features.map((f) => `- ${f}`).join('\n') : '_(none)_',
      '',
      '### Open todos',
      todos.length ? todos.map((t) => `- ${t}`).join('\n') : '_(none)_',
      '',
      '### Known issues',
      issues.length ? issues.map((i) => `- ${i}`).join('\n') : '_(none)_',
    ].join('\n');
  }

  // Last run summary + events.
  let lastRunSection = '_(no runs yet)_';
  if (scopedRun) {
    const evRows = db
      .select()
      .from(eventsTable)
      .where(eq(eventsTable.runId, scopedRun.id))
      .orderBy(desc(eventsTable.ts))
      .limit(LAST_EVENT_LIMIT)
      .all();
    const evLines = evRows
      .slice()
      .reverse()
      .map((e) => `- ${e.type}${e.taskId ? ` (${e.taskId})` : ''}`)
      .join('\n');
    lastRunSection = [
      `- runId: ${scopedRun.id}`,
      `- status: ${scopedRun.status}`,
      `- outcome: ${scopedRun.outcome ?? '_(in progress)_'}`,
      `- startedAt: ${scopedRun.startedAt ? new Date(scopedRun.startedAt).toISOString() : '_(none)_'}`,
      `- endedAt: ${scopedRun.endedAt ? new Date(scopedRun.endedAt).toISOString() : '_(none)_'}`,
      '',
      `### Recent events (oldest first, capped to ${LAST_EVENT_LIMIT})`,
      evLines || '_(none)_',
    ].join('\n');
  }

  // Open change requests.
  const openCrs = db
    .select()
    .from(changeRequestsTable)
    .where(
      and(eq(changeRequestsTable.projectId, projectId), eq(changeRequestsTable.status, 'pending')),
    )
    .all();
  const openChangeRequestsSection =
    openCrs.length === 0
      ? '_(none)_'
      : openCrs
          .slice(0, 15)
          .map(
            (cr) => `- [${cr.source}] ${shorten((cr.userPrompt ?? '').replace(/\s+/g, ' '), 200)}`,
          )
          .join('\n');

  // Prior handoffs.
  let priorHandoffsSection = '_(none)_';
  try {
    const handoffs = loadHandoffsForProject({
      dataDir,
      projectId,
      limit: HANDOFF_LIMIT,
    });
    if (handoffs.length > 0) {
      priorHandoffsSection = handoffs
        .map((h) => `- **${h.role}** (${h.taskId}): ${shorten(h.prompt.replace(/\s+/g, ' '), 180)}`)
        .join('\n');
    }
  } catch {
    priorHandoffsSection = '_(handoff store unavailable)_';
  }

  // Prior lead notes.
  const priorNotes = db
    .select()
    .from(leadNotes)
    .where(eq(leadNotes.projectId, projectId))
    .orderBy(desc(leadNotes.createdAt))
    .limit(PRIOR_NOTES_LIMIT)
    .all();
  const priorNotesSection =
    priorNotes.length === 0
      ? '_(none)_'
      : priorNotes
          .map(
            (n) =>
              `- ${new Date(n.createdAt).toISOString()}: ${shorten(n.summaryMd.replace(/\s+/g, ' '), 240)}`,
          )
          .join('\n');

  return {
    projectGoal: project.goal,
    briefSection,
    stateSection,
    lastRunSection,
    openChangeRequestsSection,
    priorHandoffsSection,
    priorNotesSection,
  };
}

/**
 * Resolve which run the tick is scoped to. Caller-supplied `runId` wins;
 * otherwise we pick the most recent run on any plan of this project.
 */
function resolveScopedRun(args: {
  projectId: string;
  runId?: string;
}): typeof runsTable.$inferSelect | null {
  if (args.runId) {
    return db.select().from(runsTable).where(eq(runsTable.id, args.runId)).get() ?? null;
  }
  const planRows = db
    .select({ id: plansTable.id })
    .from(plansTable)
    .where(eq(plansTable.projectId, args.projectId))
    .all();
  if (planRows.length === 0) return null;
  const planIds = new Set(planRows.map((p) => p.id));
  const recent = db.select().from(runsTable).orderBy(desc(runsTable.startedAt)).limit(20).all();
  return recent.find((r) => planIds.has(r.planId)) ?? null;
}

export async function runLeadTick(args: RunLeadTickArgs): Promise<RunLeadTickResult> {
  const project = db.select().from(projects).where(eq(projects.id, args.projectId)).get();
  if (!project) {
    throw new Error(`project_not_found: ${args.projectId}`);
  }

  const dataDir = args.dataDirOverride ?? env.HARNESS_DATA_DIR;
  const scopedRun = resolveScopedRun({ projectId: args.projectId, runId: args.runId });
  const bundle = buildBundle({ projectId: args.projectId, project, scopedRun, dataDir });

  const systemPrompt = getLeadSystemPrompt();
  const promptBody = composeLeadPrompt(bundle);
  const turnImpl = args.turnImpl ?? runAgentTurn;

  const turn = await turnImpl({
    systemPrompt,
    prompt: promptBody,
    allowedTools: ['Read', 'Grep', 'Glob'],
    model: 'opus',
    taskId: LEAD_TASK_ID,
    runner: args.runner,
  });

  const parsed = parseLeadDecisionFromText(turn.text);
  const cleaned = parsed.cleanedText || turn.text;

  const noteId = randomUUID();
  const decisionsForRow: LeadDecisionsJson | null = parsed.decision ?? null;

  db.insert(leadNotes)
    .values({
      id: noteId,
      projectId: args.projectId,
      runId: scopedRun?.id ?? args.runId ?? null,
      summaryMd: cleaned,
      decisionsJson: decisionsForRow ?? null,
      triggeredRunId: null,
      createdAt: new Date(),
    })
    .run();

  return {
    noteId,
    summary: cleaned,
    decision: parsed.decision,
    parseError: parsed.parseError,
    tokensIn: turn.tokensIn,
    tokensOut: turn.tokensOut,
    durationMs: turn.durationMs,
    failed: turn.failed,
  };
}
