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

function heuristic(state: WorldState, goal: Partial<WorldState>): number {
  let h = 0;
  for (const [k, v] of Object.entries(goal)) {
    if (state[k] !== v) h++;
  }
  return h;
}

function key(state: WorldState): string {
  return Object.entries(state)
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([k, v]) => `${k}=${v ? 1 : 0}`)
    .join(',');
}

export function planGoap(input: GoapInput): Action[] | null {
  interface Node { state: WorldState; path: Action[]; g: number; f: number }

  const open: Node[] = [{
    state: input.initial,
    path: [],
    g: 0,
    f: heuristic(input.initial, input.goal),
  }];
  const closed = new Map<string, number>();

  while (open.length > 0) {
    // Pop cheapest f
    open.sort((a, b) => a.f - b.f);
    const cur = open.shift()!;

    if (goalMet(cur.state, input.goal)) return cur.path;

    const k = key(cur.state);
    const prev = closed.get(k);
    if (prev != null && prev <= cur.g) continue;
    closed.set(k, cur.g);

    for (const a of input.actions) {
      if (!preMet(cur.state, a.preconditions)) continue;
      const next = applyEffects(cur.state, a.effects);
      const g = cur.g + a.cost;
      open.push({
        state: next,
        path: [...cur.path, a],
        g,
        f: g + heuristic(next, input.goal),
      });
    }
  }
  return null;
}
