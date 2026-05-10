const STOPWORDS = new Set([
  'the','a','an','and','or','but','of','to','in','on','at','for','with','by','from','as',
  'is','are','was','were','be','been','being','have','has','had','do','does','did','will',
  'would','could','should','may','might','can','this','that','these','those','it','its',
  'i','you','he','she','we','they','them','him','her','us','my','your','our','their',
]);

export function tokenize(text: string): string[] {
  return text
    .toLowerCase()
    .split(/[^a-z]+/)
    .filter((t) => t.length >= 3 && !STOPWORDS.has(t));
}

export type SparseVec = Record<string, number>;

export function computeTfidf(doc: string[], corpus: string[][]): SparseVec {
  const N = corpus.length || 1;
  const tf: Record<string, number> = {};
  for (const t of doc) tf[t] = (tf[t] ?? 0) + 1;
  const docLen = doc.length || 1;
  const out: SparseVec = {};
  for (const [t, freq] of Object.entries(tf)) {
    let df = 0;
    for (const d of corpus) if (d.includes(t)) df++;
    const idf = Math.log((1 + N) / (1 + df)) + 1;
    out[t] = (freq / docLen) * idf;
  }
  return out;
}

export function cosineSim(a: SparseVec, b: SparseVec): number {
  let dot = 0, na = 0, nb = 0;
  for (const [k, v] of Object.entries(a)) {
    na += v * v;
    if (k in b) dot += v * b[k];
  }
  for (const v of Object.values(b)) nb += v * v;
  if (na === 0 || nb === 0) return 0;
  return dot / (Math.sqrt(na) * Math.sqrt(nb));
}
