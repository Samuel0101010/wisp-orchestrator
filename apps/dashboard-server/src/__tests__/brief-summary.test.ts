import './setup.js';
import { describe, expect, it } from 'vitest';
import type { ProjectBrief } from '@wisp/schemas';
import {
  buildBriefSummaryForAgents,
  MAX_AGENT_BRIEF_CHARS,
} from '../orchestrator/brief-context.js';

function makeBrief(overrides: Partial<ProjectBrief> = {}): ProjectBrief {
  return {
    id: 'b1',
    projectId: 'p1',
    targetAudience: null,
    successCriteria: null,
    designPrefs: null,
    platform: null,
    constraints: null,
    deadline: null,
    completenessScore: 0,
    prdPath: null,
    briefReady: false,
    createdAt: new Date(),
    updatedAt: new Date(),
    ...overrides,
  };
}

describe('buildBriefSummaryForAgents', () => {
  it('returns a "## Project context" block with the populated fields', () => {
    const out = buildBriefSummaryForAgents(
      makeBrief({
        targetAudience: 'indie devs',
        designPrefs: 'dark, minimal',
        platform: 'web',
      }),
    );
    expect(out).not.toBeNull();
    expect(out).toContain('## Project context');
    expect(out).toContain('Target audience: indie devs');
    expect(out).toContain('Design preferences: dark, minimal');
    expect(out).toContain('Platform: web');
    // Omits fields that are null.
    expect(out).not.toContain('Constraints:');
    expect(out).not.toContain('Success criteria:');
  });

  it('formats the deadline as an ISO date', () => {
    const out = buildBriefSummaryForAgents(
      makeBrief({ deadline: new Date('2026-12-31T00:00:00.000Z') }),
    );
    expect(out).toContain('Deadline: 2026-12-31');
  });

  it('returns null for a null brief or one with all six fields empty', () => {
    expect(buildBriefSummaryForAgents(null)).toBeNull();
    expect(buildBriefSummaryForAgents(undefined)).toBeNull();
    // completenessScore/prdPath/briefReady are present but not among the six.
    expect(buildBriefSummaryForAgents(makeBrief({ completenessScore: 80 }))).toBeNull();
  });

  it('caps the block to MAX_AGENT_BRIEF_CHARS including the truncation marker', () => {
    const out = buildBriefSummaryForAgents(makeBrief({ constraints: 'x'.repeat(5000) }));
    expect(out).not.toBeNull();
    // Hard cap: the marker length is reserved out of the slice budget, so the
    // final string (marker included) must not exceed the advertised cap.
    expect(out!.length).toBeLessThanOrEqual(MAX_AGENT_BRIEF_CHARS);
    expect(out).toContain('… [truncated]');
  });
});
