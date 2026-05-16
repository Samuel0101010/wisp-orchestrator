import './setup.js';
import { describe, it, expect } from 'vitest';
import { buildPlannerPrompt } from '../orchestrator/planner.js';
import type { Team } from '@wisp/schemas';

const longPrompt = (s: string): string => s + ' '.repeat(Math.max(0, 60 - s.length));

function team(roles: Array<{ role: string; model?: 'opus' | 'sonnet' | 'haiku' }>): Team {
  return {
    roles: roles.map((r) => ({
      role: r.role,
      model: r.model ?? 'sonnet',
      allowedTools: ['Read'],
      systemPrompt: longPrompt(`You are the ${r.role}.`),
    })),
  };
}

describe('buildPlannerPrompt', () => {
  it('enumerates the role names literally for a 3-role team', () => {
    const p = buildPlannerPrompt(
      'build a thing',
      team([{ role: 'architect' }, { role: 'developer' }, { role: 'qa' }]),
    );
    expect(p).toContain('`architect`, `developer`, `qa`');
    expect(p).toContain('3 roles');
    expect(p).toContain('## Goal\nbuild a thing');
  });

  it('enumerates the role names literally for a 4-role team with custom names', () => {
    const p = buildPlannerPrompt(
      'ship a feature',
      team([
        { role: 'architect', model: 'opus' },
        { role: 'backend-dev' },
        { role: 'frontend-dev' },
        { role: 'qa' },
      ]),
    );
    expect(p).toContain('`architect`, `backend-dev`, `frontend-dev`, `qa`');
    expect(p).toContain('4 roles');
  });

  it('uses singular when team has exactly one role', () => {
    const p = buildPlannerPrompt('one role only', team([{ role: 'solo' }]));
    expect(p).toContain('1 role:');
    expect(p).toContain('`solo`');
  });

  it('describes the DAG schema with role:string (no enum)', () => {
    const p = buildPlannerPrompt(
      'x',
      team([{ role: 'architect' }, { role: 'developer' }, { role: 'qa' }]),
    );
    // Regression check: must NOT contain the legacy enum literal.
    expect(p).not.toContain('"architect" | "developer" | "qa"');
    expect(p).toContain('role: string');
    expect(p).toContain('team: { roles: AgentSpec[] }');
  });

  it('mentions preflight prose so the planner emits the hint when appropriate', () => {
    const p = buildPlannerPrompt('x', team([{ role: 'architect' }]));
    expect(p).toContain('preflight runs ONCE');
  });

  it('mentions CRLF-tolerance prose so planner emits cross-platform-safe gates', () => {
    const p = buildPlannerPrompt('x', team([{ role: 'architect' }]));
    expect(p).toContain('replace(/\\r?\\n$/');
  });
});
