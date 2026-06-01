import { describe, it, expect } from 'vitest';
import { reconcileEnabledActions } from './Goap';

const S = (...xs: string[]) => new Set(xs);

describe('reconcileEnabledActions', () => {
  it('keeps a previously-disabled existing action OFF across a JSON edit', () => {
    // User knew {a,b,c}, toggled c off (enabled={a,b}), then edits the JSON.
    // The dead-branch bug used to re-enable c here.
    const out = reconcileEnabledActions(S('a', 'b'), S('a', 'b', 'c'), S('a', 'b', 'c'));
    expect([...out].sort()).toEqual(['a', 'b']);
  });

  it('defaults a brand-new action (absent from known) to enabled', () => {
    const out = reconcileEnabledActions(S('a', 'b'), S('a', 'b'), S('a', 'b', 'd'));
    expect([...out].sort()).toEqual(['a', 'b', 'd']);
  });

  it('drops names that were removed from the JSON', () => {
    const out = reconcileEnabledActions(S('a', 'b', 'c'), S('a', 'b', 'c'), S('a', 'b'));
    expect(out.has('c')).toBe(false);
  });

  it('enables everything on the first parse when nothing is known yet', () => {
    const out = reconcileEnabledActions(S(), S(), S('a', 'b'));
    expect([...out].sort()).toEqual(['a', 'b']);
  });
});
