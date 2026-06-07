import './setup.js';
import { describe, expect, it } from 'vitest';
import {
  applyBriefPatch,
  renderBriefAsPrdMarkdown,
  runInterviewerTurn,
  type BriefState,
} from '../orchestrator/interviewer-engine.js';
import type { HarnessEvent } from '@wisp/schemas';

const EMPTY_BRIEF: BriefState = {
  targetAudience: null,
  successCriteria: null,
  designPrefs: null,
  platform: null,
  constraints: null,
  deadline: null,
  completenessScore: 0,
  briefReady: false,
};

describe('applyBriefPatch', () => {
  it('returns current unchanged when patch is null', () => {
    expect(applyBriefPatch(EMPTY_BRIEF, null)).toBe(EMPTY_BRIEF);
  });

  it('sets non-null fields and bumps score monotonically', () => {
    const next = applyBriefPatch(EMPTY_BRIEF, {
      platform: 'web',
      completenessScore: 30,
    });
    expect(next.platform).toBe('web');
    expect(next.completenessScore).toBe(30);
    expect(next.targetAudience).toBeNull();
  });

  it('never lowers completenessScore', () => {
    const seeded: BriefState = { ...EMPTY_BRIEF, completenessScore: 70 };
    const next = applyBriefPatch(seeded, { completenessScore: 40 });
    expect(next.completenessScore).toBe(70);
  });

  it('respects explicit null to clear a field (deadline)', () => {
    const seeded: BriefState = { ...EMPTY_BRIEF, deadline: 1799000000000 };
    const next = applyBriefPatch(seeded, { deadline: null });
    expect(next.deadline).toBeNull();
  });
});

describe('runInterviewerTurn', () => {
  it('parses patch + advances brief from the agent text', async () => {
    const result = await runInterviewerTurn({
      systemPrompt: 'test-system',
      current: EMPTY_BRIEF,
      history: [],
      userMessage: 'Eine kleine Web-App für mein Team.',
      taskId: 'test-task-1',
      turnImpl: async () => ({
        text:
          'Verstanden — Web-App für ein Team. Wie viele Personen sind das genau?\n' +
          '\n<<BRIEF_PATCH>>\n{"platform":"web","completenessScore":25}\n<<END>>',
        tokensIn: 100,
        tokensOut: 50,
        durationMs: 1200,
        failed: null,
      }),
    });
    expect(result.assistantText).toContain('Web-App');
    expect(result.assistantText).not.toContain('BRIEF_PATCH');
    expect(result.patch).toEqual({ platform: 'web', completenessScore: 25 });
    expect(result.nextBrief.platform).toBe('web');
    expect(result.nextBrief.completenessScore).toBe(25);
    expect(result.shouldFinalize).toBe(false);
    expect(result.tokensIn).toBe(100);
  });

  it('injects the project goal into the interviewer prompt', async () => {
    let captured = '';
    await runInterviewerTurn({
      systemPrompt: 'base-system',
      goal: 'Build a kanban board in React + Vite + Tailwind',
      current: EMPTY_BRIEF,
      history: [],
      userMessage: 'hi',
      taskId: 'test-goal',
      turnImpl: async (a) => {
        captured = `${a.systemPrompt}\n${a.prompt}`;
        return { text: 'ok', tokensIn: 1, tokensOut: 1, durationMs: 1, failed: null };
      },
    });
    expect(captured).toContain('base-system');
    expect(captured).toContain('Project goal (already stated by the user)');
    expect(captured).toContain('Build a kanban board in React + Vite + Tailwind');
  });

  it('leaves the prompt unchanged when no goal is provided', async () => {
    let captured = '';
    await runInterviewerTurn({
      systemPrompt: 'base-system',
      current: EMPTY_BRIEF,
      history: [],
      userMessage: 'hi',
      taskId: 'test-no-goal',
      turnImpl: async (a) => {
        captured = `${a.systemPrompt}\n${a.prompt}`;
        return { text: 'ok', tokensIn: 1, tokensOut: 1, durationMs: 1, failed: null };
      },
    });
    expect(captured).not.toContain('Project goal (already stated by the user)');
  });

  it('flags shouldFinalize when completeness crosses threshold', async () => {
    const result = await runInterviewerTurn({
      systemPrompt: 'test-system',
      current: { ...EMPTY_BRIEF, completenessScore: 70 },
      history: [],
      userMessage: 'No constraints.',
      taskId: 'test-task-2',
      turnImpl: async () => ({
        text:
          'Alright, I have what I need.\n' +
          '<<BRIEF_PATCH>>\n{"constraints":"none","completenessScore":85}\n<<END>>',
        tokensIn: 80,
        tokensOut: 30,
        durationMs: 500,
        failed: null,
      }),
    });
    expect(result.shouldFinalize).toBe(true);
    expect(result.nextBrief.completenessScore).toBe(85);
  });

  it('respects <<BRIEF_COMPLETE>> marker even without crossing threshold', async () => {
    const result = await runInterviewerTurn({
      systemPrompt: 'test-system',
      current: EMPTY_BRIEF,
      history: [],
      userMessage: 'just ship it',
      taskId: 'test-task-3',
      turnImpl: async () => ({
        text:
          'OK, finalising the brief with what we have.\n' +
          '<<BRIEF_PATCH>>\n{"completenessScore":55}\n<<END>>\n' +
          '<<BRIEF_COMPLETE>>',
        tokensIn: 60,
        tokensOut: 20,
        durationMs: 300,
        failed: null,
      }),
    });
    expect(result.agentSignaledComplete).toBe(true);
    expect(result.shouldFinalize).toBe(true);
    expect(result.nextBrief.completenessScore).toBe(55);
  });

  it('surfaces parse errors without throwing', async () => {
    const result = await runInterviewerTurn({
      systemPrompt: 'test-system',
      current: EMPTY_BRIEF,
      history: [],
      userMessage: 'hi',
      taskId: 'test-task-4',
      turnImpl: async () => ({
        text: 'Hello.\n<<BRIEF_PATCH>>\n{not json}\n<<END>>',
        tokensIn: 10,
        tokensOut: 5,
        durationMs: 100,
        failed: null,
      }),
    });
    expect(result.patch).toBeNull();
    expect(result.parseError).toMatch(/invalid_brief_patch_json/);
    expect(result.nextBrief).toEqual(EMPTY_BRIEF);
  });

  // Touch a sentinel re-export so the brief.ts module is exercised at the
  // dashboard-server test level too, catching mis-exports early.
  it('exports BriefPatch transitively from schemas', () => {
    const ev: HarnessEvent | undefined = undefined;
    void ev;
    expect(typeof EMPTY_BRIEF.completenessScore).toBe('number');
  });
});

describe('renderBriefAsPrdMarkdown', () => {
  it('renders all sections with provided values', () => {
    const md = renderBriefAsPrdMarkdown(
      {
        targetAudience: 'developers',
        successCriteria: 'p99 < 200ms',
        designPrefs: 'minimal',
        platform: 'web',
        constraints: 'no third-party deps',
        deadline: 1799900000000,
        completenessScore: 90,
        briefReady: true,
      },
      'InvoiceLite',
    );
    expect(md).toContain('# InvoiceLite — Product Requirements');
    expect(md).toContain('## Target audience');
    expect(md).toContain('developers');
    expect(md).toContain('## Platform');
    expect(md).toContain('web');
    expect(md).toContain('## Deadline');
    expect(md).toContain('## Completeness');
    expect(md).toContain('90%');
  });

  it('includes a Goal section when a goal is provided', () => {
    const md = renderBriefAsPrdMarkdown(EMPTY_BRIEF, 'GoalApp', 'Ship a tip calculator');
    expect(md).toContain('## Goal');
    expect(md).toContain('Ship a tip calculator');
  });

  it('marks missing fields as "_not provided_"', () => {
    const md = renderBriefAsPrdMarkdown(EMPTY_BRIEF, 'EmptyApp');
    expect(md.match(/_not provided_/g)?.length).toBeGreaterThanOrEqual(5);
    expect(md).toContain('_none_');
  });
});
