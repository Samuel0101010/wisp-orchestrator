export type WorldState = Record<string, boolean>;

export interface Action {
  name: string;
  cost: number;
  preconditions: Partial<WorldState>;
  effects: Partial<WorldState>;
}

export interface GoapInput {
  initial: WorldState;
  goal: Partial<WorldState>;
  actions: Action[];
}

export interface GoapOptions {
  /**
   * Hard cap on node expansions (pops) before the search aborts. Guards the
   * single-threaded server: without it a pathological input (e.g. many
   * independent boolean actions, or an unreachable goal) enumerates an
   * exponential state space synchronously and pins the event loop for
   * minutes. On exceeding the cap we throw {@link GoapBudgetExceededError}.
   */
  maxExpansions?: number;
}

/**
 * Thrown when {@link planGoap} exceeds its expansion budget. Distinct from a
 * clean "no plan exists" (`null`) so callers can report "search space too
 * large" instead of the misleading "no plan for this combination".
 */
export class GoapBudgetExceededError extends Error {
  readonly expansions: number;
  constructor(expansions: number) {
    super(`GOAP search exceeded its budget of ${expansions} expansions`);
    this.name = 'GoapBudgetExceededError';
    this.expansions = expansions;
  }
}

const DEFAULT_MAX_EXPANSIONS = 50_000;

function preMet(state: WorldState, pre: Partial<WorldState>): boolean {
  for (const [k, v] of Object.entries(pre)) {
    if (state[k] !== v) return false;
  }
  return true;
}

function goalMet(state: WorldState, goal: Partial<WorldState>): boolean {
  return preMet(state, goal);
}

function applyEffects(state: WorldState, effects: Partial<WorldState>): WorldState {
  const out: WorldState = { ...state };
  for (const [k, v] of Object.entries(effects)) {
    out[k] = v as boolean;
  }
  return out;
}

function key(state: WorldState): string {
  return Object.entries(state)
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([k, v]) => `${k}=${v ? 1 : 0}`)
    .join(',');
}

/**
 * Uniform-cost search (Dijkstra) over world states. The previous A* used a
 * heuristic that counted unsatisfied goal predicates — inadmissible whenever
 * an action satisfies multiple goal predicates or has cost 0, which let the
 * goal-at-pop test return a non-cheapest plan. Action costs are non-negative,
 * so Dijkstra (h = 0) is both admissible and optimal, and returns the cheapest
 * plan for every legal input. A binary min-heap keyed on g, best-g dedup at
 * insertion, parent back-pointers (no per-push path clone) and a hard
 * expansion cap keep the search bounded in time and memory.
 */
export function planGoap(input: GoapInput, opts: GoapOptions = {}): Action[] | null {
  const maxExpansions = opts.maxExpansions ?? DEFAULT_MAX_EXPANSIONS;

  interface SearchNode {
    state: WorldState;
    g: number;
    parent: number; // index into nodes[]; -1 for the root
    action: Action | null; // action taken from parent to reach this node
  }

  const nodes: SearchNode[] = [];
  const bestG = new Map<string, number>();

  // Binary min-heap of node indices ordered by nodes[i].g. Cheaper than the
  // old per-iteration full sort (O(log n) push/pop vs O(n log n) per pop).
  const heap: number[] = [];
  const less = (a: number, b: number) => nodes[a]!.g < nodes[b]!.g;
  const push = (idx: number) => {
    heap.push(idx);
    let i = heap.length - 1;
    while (i > 0) {
      const p = (i - 1) >> 1;
      if (!less(heap[i]!, heap[p]!)) break;
      [heap[i], heap[p]] = [heap[p]!, heap[i]!];
      i = p;
    }
  };
  const pop = (): number => {
    const top = heap[0]!;
    const last = heap.pop()!;
    if (heap.length > 0) {
      heap[0] = last;
      let i = 0;
      for (;;) {
        const l = 2 * i + 1;
        const r = 2 * i + 2;
        let m = i;
        if (l < heap.length && less(heap[l]!, heap[m]!)) m = l;
        if (r < heap.length && less(heap[r]!, heap[m]!)) m = r;
        if (m === i) break;
        [heap[i], heap[m]] = [heap[m]!, heap[i]!];
        i = m;
      }
    }
    return top;
  };

  nodes.push({ state: input.initial, g: 0, parent: -1, action: null });
  bestG.set(key(input.initial), 0);
  push(0);

  let expansions = 0;
  while (heap.length > 0) {
    const curIdx = pop();
    const cur = nodes[curIdx]!;
    const curKey = key(cur.state);

    // Lazy deletion: a cheaper path to this state was queued after this entry.
    const best = bestG.get(curKey);
    if (best != null && cur.g > best) continue;

    if (goalMet(cur.state, input.goal)) {
      const path: Action[] = [];
      for (let idx = curIdx; idx !== -1; idx = nodes[idx]!.parent) {
        const a = nodes[idx]!.action;
        if (a) path.push(a);
      }
      path.reverse();
      return path;
    }

    if (++expansions > maxExpansions) {
      throw new GoapBudgetExceededError(maxExpansions);
    }

    for (const a of input.actions) {
      if (!preMet(cur.state, a.preconditions)) continue;
      const next = applyEffects(cur.state, a.effects);
      const g = cur.g + a.cost;
      const nk = key(next);
      const prevBest = bestG.get(nk);
      if (prevBest != null && prevBest <= g) continue;
      bestG.set(nk, g);
      const nextIdx = nodes.length;
      nodes.push({ state: next, g, parent: curIdx, action: a });
      push(nextIdx);
    }
  }
  return null;
}
