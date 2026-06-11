import { describe, it, expect } from 'vitest';
import {
  defaultSkillsForRole,
  BUILDER_DISCIPLINE_SKILL,
  QA_VERIFICATION_SKILL,
  FRONTEND_QUALITY_SKILL,
} from './role-skills.js';
import { agentSpecSchema } from './plan.js';

describe('defaultSkillsForRole', () => {
  it('maps QA-ish roles to qa-verification (and never builder-discipline)', () => {
    for (const role of ['qa', 'qa-engineer', 'quality-assurance', 'tester']) {
      expect(defaultSkillsForRole(role)).toEqual([QA_VERIFICATION_SKILL]);
    }
    // De-dup suffixes from the Team Builder keep their mapping.
    expect(defaultSkillsForRole('qa-engineer-2')).toEqual([QA_VERIFICATION_SKILL]);
  });

  it('maps frontend builders to discipline + frontend quality', () => {
    for (const role of ['frontend-dev', 'ui-dev', 'web-dev']) {
      expect(defaultSkillsForRole(role)).toEqual([
        BUILDER_DISCIPLINE_SKILL,
        FRONTEND_QUALITY_SKILL,
      ]);
    }
  });

  it('maps generic builders to builder-discipline', () => {
    for (const role of [
      'developer',
      'backend-dev',
      'mobile-dev',
      'devops',
      'security',
      'packager',
      'ml-engineer',
      'core-dev',
    ]) {
      expect(defaultSkillsForRole(role)).toEqual([BUILDER_DISCIPLINE_SKILL]);
    }
  });

  it('leaves non-coding roles without skills', () => {
    for (const role of ['architect', 'designer', 'tech-writer', 'lead', 'manager', '']) {
      expect(defaultSkillsForRole(role)).toEqual([]);
    }
  });
});

describe('agentSpecSchema.skills', () => {
  const base = {
    role: 'developer',
    model: 'sonnet' as const,
    allowedTools: ['Read'],
    systemPrompt: 'x'.repeat(50),
  };

  it('accepts an optional skills array and round-trips it', () => {
    const parsed = agentSpecSchema.parse({ ...base, skills: ['builder-discipline'] });
    expect(parsed.skills).toEqual(['builder-discipline']);
    // Optional: plans without the field keep parsing.
    expect(agentSpecSchema.parse(base).skills).toBeUndefined();
  });

  it('rejects more than 8 skills and empty names', () => {
    expect(
      agentSpecSchema.safeParse({ ...base, skills: Array.from({ length: 9 }, (_, i) => `s${i}`) })
        .success,
    ).toBe(false);
    expect(agentSpecSchema.safeParse({ ...base, skills: [''] }).success).toBe(false);
  });
});
