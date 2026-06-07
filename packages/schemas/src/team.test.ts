import { describe, it, expect } from 'vitest';
import { parseTeam, safeParseTeam } from './team.js';
import { MAX_TEAM_ROLES } from './plan.js';

const validRole = (overrides: Partial<{ role: string; model: string; systemPrompt: string }>) => ({
  role: overrides.role ?? 'architect',
  model: overrides.model ?? 'sonnet',
  allowedTools: ['Read'],
  systemPrompt: overrides.systemPrompt ?? 'a'.repeat(60),
});

describe('parseTeam (variable roles)', () => {
  it('parses a 3-role team', () => {
    const t = parseTeam({
      roles: [
        validRole({ role: 'architect' }),
        validRole({ role: 'developer' }),
        validRole({ role: 'qa' }),
      ],
    });
    expect(t.roles).toHaveLength(3);
  });

  it('parses a 4-role team with custom role names', () => {
    const t = parseTeam({
      roles: [
        validRole({ role: 'architect', model: 'opus' }),
        validRole({ role: 'backend-dev' }),
        validRole({ role: 'frontend-dev' }),
        validRole({ role: 'qa' }),
      ],
    });
    expect(t.roles).toHaveLength(4);
    expect(t.roles[1]!.role).toBe('backend-dev');
  });

  it('rejects empty roles array', () => {
    expect(safeParseTeam({ roles: [] }).success).toBe(false);
  });

  it('rejects more than the role cap', () => {
    const roles = Array.from({ length: MAX_TEAM_ROLES + 1 }, (_, i) =>
      validRole({ role: `r${i}` }),
    );
    expect(safeParseTeam({ roles }).success).toBe(false);
  });

  it('rejects duplicate role names', () => {
    const r = safeParseTeam({ roles: [validRole({ role: 'dev' }), validRole({ role: 'dev' })] });
    expect(r.success).toBe(false);
    if (!r.success) {
      expect(r.error.issues.some((i) => /duplicate role: dev/i.test(i.message))).toBe(true);
    }
  });

  it('rejects role names that are not kebab-case', () => {
    expect(safeParseTeam({ roles: [validRole({ role: 'Architect' })] }).success).toBe(false);
    expect(safeParseTeam({ roles: [validRole({ role: '1abc' })] }).success).toBe(false);
    expect(safeParseTeam({ roles: [validRole({ role: 'a' })] }).success).toBe(false); // min 2
  });

  it('rejects model not in opus/sonnet/haiku', () => {
    expect(safeParseTeam({ roles: [validRole({ model: 'gpt-4' })] }).success).toBe(false);
  });

  it('rejects systemPrompt under 40 chars', () => {
    expect(safeParseTeam({ roles: [validRole({ systemPrompt: 'short' })] }).success).toBe(false);
  });
});
