import { describe, it, expect } from 'vitest';
import { parseTeam, safeParseTeam } from './team.js';

const validTeam = {
  architect: {
    role: 'architect',
    model: 'opus',
    allowedTools: ['Read'],
    systemPrompt: 'arch prompt',
  },
  developer: {
    role: 'developer',
    model: 'sonnet',
    allowedTools: ['Read', 'Edit'],
    systemPrompt: 'dev prompt',
  },
  qa: {
    role: 'qa',
    model: 'sonnet',
    allowedTools: ['Read'],
    systemPrompt: 'qa prompt',
  },
};

describe('parseTeam', () => {
  it('parses a structurally valid team', () => {
    const team = parseTeam(validTeam);
    expect(team.architect.model).toBe('opus');
    expect(team.developer.role).toBe('developer');
    expect(team.qa.role).toBe('qa');
  });

  it('rejects missing slot', () => {
    const broken = { architect: validTeam.architect, developer: validTeam.developer };
    const result = safeParseTeam(broken);
    expect(result.success).toBe(false);
  });

  it('rejects bad role enum', () => {
    const broken = {
      ...validTeam,
      architect: { ...validTeam.architect, role: 'wizard' },
    };
    const result = safeParseTeam(broken);
    expect(result.success).toBe(false);
  });

  it('does NOT enforce slot/role coherence (left to route layer)', () => {
    // architect slot containing a developer-roled spec parses OK at the schema
    // level; the route layer is expected to reject this.
    const swapped = {
      ...validTeam,
      architect: { ...validTeam.architect, role: 'developer' },
    };
    const result = safeParseTeam(swapped);
    expect(result.success).toBe(true);
  });
});
