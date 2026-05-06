import './setup.js';
import { describe, it, expect } from 'vitest';
import { builtInTemplates, templateSchema } from '../templates/index.js';

describe('built-in templates', () => {
  it('loads exactly four templates', () => {
    expect(builtInTemplates).toHaveLength(4);
  });

  it('has unique kebab-case ids', () => {
    const ids = builtInTemplates.map((t) => t.id);
    expect(new Set(ids).size).toBe(ids.length);
    for (const id of ids) {
      expect(id).toMatch(/^[a-z][a-z0-9-]*$/);
    }
  });

  it('every template re-validates via templateSchema', () => {
    for (const t of builtInTemplates) {
      const r = templateSchema.safeParse(t);
      expect(r.success, `${t.id} failed schema parse`).toBe(true);
    }
  });

  it.each(['ts-library', 'python-backend', 'refactor-squad', 'data-pipeline'])(
    'includes built-in: %s',
    (id) => {
      expect(builtInTemplates.some((t) => t.id === id)).toBe(true);
    },
  );

  it('every template team uses the M3 mcp__ tool naming where memory tools are referenced', () => {
    for (const t of builtInTemplates) {
      for (const role of t.team.roles) {
        for (const tool of role.allowedTools) {
          if (tool.startsWith('memory.')) {
            throw new Error(
              `template ${t.id} role ${role.role} uses legacy 'memory.' name: '${tool}' (use mcp__agent-harness-memory__... instead)`,
            );
          }
        }
      }
    }
  });

  it('every template provides at least one suggestedGoal', () => {
    for (const t of builtInTemplates) {
      expect(t.suggestedGoals.length).toBeGreaterThanOrEqual(1);
      for (const g of t.suggestedGoals) {
        expect(g.length).toBeGreaterThanOrEqual(10);
      }
    }
  });
});

describe('templateSchema', () => {
  it('rejects an empty roles array via teamSchema', () => {
    const r = templateSchema.safeParse({
      id: 't',
      name: 'Test',
      description: 'x'.repeat(40),
      team: { roles: [] },
      suggestedGoals: ['a goal that is at least 10 chars long'],
    });
    expect(r.success).toBe(false);
  });

  it('rejects non-kebab-case id', () => {
    const t: unknown = {
      id: 'TS-Library',
      name: 'Test',
      description: 'x'.repeat(40),
      team: {
        roles: [
          {
            role: 'architect',
            model: 'opus',
            allowedTools: ['Read'],
            systemPrompt: 'x'.repeat(60),
          },
        ],
      },
      suggestedGoals: ['a goal that is at least 10 chars long'],
    };
    expect(templateSchema.safeParse(t).success).toBe(false);
  });
});
