import { describe, expect, it } from 'vitest';
import {
  buildBriefSummaryForAgentsPreview,
  composeTaskPromptPreview,
  type PreviewBrief,
  type PreviewTaskNode,
} from './composedPrompt';

const node: PreviewTaskNode = {
  id: 'sample-1',
  role: 'developer',
  prompt: 'Do the thing.',
  successCriteria: { build: 'pnpm build', test: 'pnpm test' },
};

function makeBrief(overrides: Partial<PreviewBrief> = {}): PreviewBrief {
  return {
    targetAudience: null,
    successCriteria: null,
    designPrefs: null,
    platform: null,
    constraints: null,
    deadline: null,
    ...overrides,
  };
}

describe('buildBriefSummaryForAgentsPreview', () => {
  it('mirrors the server: "## Project context" with the populated fields', () => {
    const out = buildBriefSummaryForAgentsPreview(
      makeBrief({ targetAudience: 'indie devs', designPrefs: 'dark, minimal', platform: 'web' }),
    );
    expect(out).not.toBeNull();
    expect(out).toContain('## Project context');
    expect(out).toContain('Target audience: indie devs');
    expect(out).toContain('Design preferences: dark, minimal');
    expect(out).toContain('Platform: web');
    expect(out).not.toContain('Constraints:');
  });

  it('returns null for a null/undefined brief or one with all six fields empty', () => {
    expect(buildBriefSummaryForAgentsPreview(null)).toBeNull();
    expect(buildBriefSummaryForAgentsPreview(undefined)).toBeNull();
    expect(buildBriefSummaryForAgentsPreview(makeBrief())).toBeNull();
  });

  it('caps the block to MAX_AGENT_BRIEF_CHARS including the marker', () => {
    const out = buildBriefSummaryForAgentsPreview(makeBrief({ constraints: 'x'.repeat(5000) }));
    expect(out).not.toBeNull();
    expect(out!.length).toBeLessThanOrEqual(1_500);
    expect(out).toContain('… [truncated]');
  });
});

describe('composeTaskPromptPreview — project context section', () => {
  it('emits "## Project context" after # Goal and before # Task', () => {
    const briefContext = buildBriefSummaryForAgentsPreview(
      makeBrief({ platform: 'web', targetAudience: 'indie devs' }),
    )!;
    const out = composeTaskPromptPreview('Build a thing', node, null, briefContext);

    const goalIdx = out.indexOf('# Goal');
    const ctxIdx = out.indexOf('## Project context');
    const taskIdx = out.indexOf('# Task:');
    expect(goalIdx).toBeGreaterThanOrEqual(0);
    expect(ctxIdx).toBeGreaterThan(goalIdx);
    expect(taskIdx).toBeGreaterThan(ctxIdx);
    expect(out).toContain('Platform: web');
  });

  it('omits the section when no brief context is supplied', () => {
    const out = composeTaskPromptPreview('Build a thing', node, null);
    expect(out).not.toContain('## Project context');
  });

  it('omits the section for empty/whitespace brief context', () => {
    const out = composeTaskPromptPreview('Build a thing', node, null, '   ');
    expect(out).not.toContain('## Project context');
  });
});
