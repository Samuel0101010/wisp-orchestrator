/**
 * Per-model display metadata. Used by inline hints next to the model select
 * and by the cost-estimate panel.
 *
 * Subscription mode (the only supported mode) doesn't bill per-token, so
 * we describe relative cost rather than dollar amounts. The actual quota
 * consumption is visible in run-level token totals after a run completes.
 */

import type { AgentSpec } from '@wisp/schemas';

export type Model = AgentSpec['model'];

export interface ModelInfo {
  id: Model;
  name: string;
  costClass: 'cheap' | 'standard' | 'expensive';
  /** Relative weight for back-of-envelope cost estimates (haiku=1). */
  costWeight: number;
  notes: string;
}

export const MODEL_INFO: Record<Model, ModelInfo> = {
  haiku: {
    id: 'haiku',
    name: 'Haiku',
    costClass: 'cheap',
    costWeight: 1,
    notes: 'Fast and cheap. Good for QA gates, simple file edits, and prompt probes.',
  },
  sonnet: {
    id: 'sonnet',
    name: 'Sonnet',
    costClass: 'standard',
    costWeight: 4,
    notes: 'Balanced. Default for development work.',
  },
  opus: {
    id: 'opus',
    name: 'Opus',
    costClass: 'expensive',
    costWeight: 20,
    notes: 'Highest quality. Use for architecture and complex reasoning.',
  },
};

export const MODEL_LIST: ModelInfo[] = [MODEL_INFO.haiku, MODEL_INFO.sonnet, MODEL_INFO.opus];
