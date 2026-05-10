import './setup.js';
import { describe, expect, it, beforeEach, beforeAll } from 'vitest';
import { tokenize, computeTfidf, cosineSim } from '../reasoningbank/tfidf.js';
import { storeTrajectory, retrieveSimilar } from '../reasoningbank/store.js';
import { sqlite } from '../db/index.js';
import { runMigrations } from '../db/migrate.js';

beforeAll(() => {
  runMigrations();
});

describe('tfidf', () => {
  it('tokenizes lowercase, drops stopwords and short tokens', () => {
    const toks = tokenize('The quick BROWN fox jumps over the lazy dog 42');
    expect(toks).toEqual(['quick', 'brown', 'fox', 'jumps', 'over', 'lazy', 'dog']);
  });

  it('computes tfidf weights given a corpus', () => {
    const docs = [['cat', 'dog'], ['cat', 'bird'], ['fish']];
    const v = computeTfidf(docs[0], docs);
    expect(v['dog']).toBeGreaterThan(v['cat']);
  });

  it('cosine similarity is 1 for identical vectors', () => {
    const a = { x: 1, y: 2 };
    expect(cosineSim(a, a)).toBeCloseTo(1, 5);
  });

  it('cosine similarity is 0 for disjoint vectors', () => {
    expect(cosineSim({ a: 1 }, { b: 1 })).toBeCloseTo(0, 5);
  });
});

describe('trajectory store', () => {
  beforeEach(() => {
    sqlite.prepare('DELETE FROM trajectories').run();
  });

  it('round-trips a trajectory and retrieves it as top-1 for similar prompt', async () => {
    const id = await storeTrajectory({
      projectId: null,
      prompt: 'add login form to dashboard',
      planJson: { tasks: [] },
      outcome: 'success',
      lessons: 'use react-hook-form',
      tokensTotal: 1200,
    });
    const top = await retrieveSimilar('add login form to admin', null, 3);
    expect(top.length).toBeGreaterThan(0);
    expect(top[0].id).toBe(id);
    expect(top[0].score).toBeGreaterThan(0);
    expect(top[0].lessons).toBe('use react-hook-form');
  });

  it('returns empty for empty corpus', async () => {
    const top = await retrieveSimilar('foo', null, 3);
    expect(top).toEqual([]);
  });
});
