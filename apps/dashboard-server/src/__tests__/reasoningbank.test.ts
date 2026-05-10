import './setup.js';
import { describe, expect, it } from 'vitest';
import { tokenize, computeTfidf, cosineSim } from '../reasoningbank/tfidf.js';

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
