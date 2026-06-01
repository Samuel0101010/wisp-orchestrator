import { describe, it, expect } from 'vitest';
import type { TFunction } from 'i18next';
import {
  reconcileEnabledActions,
  clip,
  isValidAction,
  isBooleanRecord,
  findDuplicateName,
  formatPlannerError,
} from './Goap';
import { ApiError } from '@/api/client';

const S = (...xs: string[]) => new Set(xs);

// Mock t() that echoes the chosen key, or the interpolated `detail` when present.
const tMock = ((key: string, _def?: string, opts?: { detail?: string }) =>
  opts?.detail ?? key) as unknown as TFunction;

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

describe('clip', () => {
  it('leaves short labels untouched', () => {
    expect(clip('short', 16)).toBe('short');
  });
  it('truncates long labels with an ellipsis', () => {
    const out = clip('this-is-an-extremely-long-action-name', 16);
    expect(out).toHaveLength(16);
    expect(out.endsWith('…')).toBe(true);
  });
});

describe('isValidAction', () => {
  it('accepts a string name with a finite numeric cost', () => {
    expect(isValidAction({ name: 'a', cost: 1, preconditions: {}, effects: {} })).toBe(true);
  });
  it('rejects a missing cost (would render NaN in the cost sum)', () => {
    expect(isValidAction({ name: 'a' })).toBe(false);
  });
  it('rejects a non-finite or non-numeric cost', () => {
    expect(isValidAction({ name: 'a', cost: NaN })).toBe(false);
    expect(isValidAction({ name: 'a', cost: '3' })).toBe(false);
  });
  it('rejects a non-string name and non-objects', () => {
    expect(isValidAction({ cost: 1 })).toBe(false);
    expect(isValidAction(null)).toBe(false);
    expect(isValidAction('x')).toBe(false);
  });
});

describe('isBooleanRecord', () => {
  it('accepts an all-boolean object (and the empty object)', () => {
    expect(isBooleanRecord({ a: true, b: false })).toBe(true);
    expect(isBooleanRecord({})).toBe(true);
  });
  it('rejects non-boolean values, arrays and null', () => {
    expect(isBooleanRecord({ a: 1 })).toBe(false);
    expect(isBooleanRecord({ a: 'yes' })).toBe(false);
    expect(isBooleanRecord([])).toBe(false);
    expect(isBooleanRecord(null)).toBe(false);
  });
});

describe('findDuplicateName', () => {
  it('returns the first repeated name', () => {
    expect(findDuplicateName(['a', 'b', 'a'])).toBe('a');
  });
  it('returns null when all names are unique', () => {
    expect(findDuplicateName(['a', 'b', 'c'])).toBeNull();
    expect(findDuplicateName([])).toBeNull();
  });
});

describe('formatPlannerError', () => {
  it('maps a 422 search_exhausted body to the friendly key', () => {
    const err = new ApiError(422, 'Request failed: 422', { error: 'search_exhausted' });
    expect(formatPlannerError(err, tMock)).toBe('goap.errors.searchExhausted');
  });
  it('expands a 400 zod issues body into a per-field detail string', () => {
    const err = new ApiError(400, 'Request failed: 400 Bad Request', {
      error: 'invalid_body',
      issues: [{ path: ['goal', 'x'], message: 'Expected boolean, received number' }],
    });
    expect(formatPlannerError(err, tMock)).toBe('goal.x: Expected boolean, received number');
  });
  it('falls back to the raw message for an ApiError without a useful body', () => {
    const err = new ApiError(500, 'Request failed: 500 Internal Server Error', undefined);
    expect(formatPlannerError(err, tMock)).toBe('Request failed: 500 Internal Server Error');
  });
  it('falls back to message / String for non-ApiError values', () => {
    expect(formatPlannerError(new Error('boom'), tMock)).toBe('boom');
    expect(formatPlannerError('weird', tMock)).toBe('weird');
  });
});
