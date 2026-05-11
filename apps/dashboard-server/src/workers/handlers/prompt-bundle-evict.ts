import { evictStaleBundles } from '../../cache/prompt-bundle.js';

const SEVEN_DAYS_MS = 7 * 24 * 60 * 60 * 1000;

export async function promptBundleEvict(): Promise<{ deleted: number; errored: number }> {
  return evictStaleBundles(SEVEN_DAYS_MS);
}
