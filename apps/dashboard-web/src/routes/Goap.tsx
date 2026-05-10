import { useState } from 'react';
import { usePlanGoap, type GoapAction } from '@/api/queries';

const EXAMPLE = {
  initial: '{}',
  goal: '{"hasReport": true}',
  actions: JSON.stringify([
    { name: 'gather-info', cost: 1, preconditions: {}, effects: { hasInfo: true } },
    { name: 'analyze', cost: 2, preconditions: { hasInfo: true }, effects: { hasAnalysis: true } },
    { name: 'write-report', cost: 3, preconditions: { hasAnalysis: true }, effects: { hasReport: true } },
  ], null, 2),
};

export function GoapRoute() {
  const [initial, setInitial] = useState(EXAMPLE.initial);
  const [goal, setGoal] = useState(EXAMPLE.goal);
  const [actions, setActions] = useState(EXAMPLE.actions);
  const [parseError, setParseError] = useState<string | null>(null);
  const planM = usePlanGoap();

  const submit = () => {
    setParseError(null);
    try {
      const body = {
        initial: JSON.parse(initial),
        goal: JSON.parse(goal),
        actions: JSON.parse(actions),
      };
      planM.mutate(body);
    } catch (err) {
      setParseError(err instanceof Error ? err.message : String(err));
    }
  };

  return (
    <div className="space-y-4">
      <header>
        <h1 className="text-2xl font-semibold">GOAP Planner</h1>
        <p className="text-sm text-muted-foreground">
          Goal-oriented action planning over boolean world state. Provide initial state, goal, and an action library; get back the cheapest plan.
        </p>
      </header>

      <div className="grid grid-cols-1 gap-3 md:grid-cols-3">
        {[
          { label: 'Initial state', value: initial, set: setInitial },
          { label: 'Goal', value: goal, set: setGoal },
          { label: 'Actions', value: actions, set: setActions },
        ].map(({ label, value, set }) => (
          <div key={label} className="flex flex-col">
            <label className="text-xs uppercase text-muted-foreground">{label}</label>
            <textarea
              value={value}
              onChange={(e) => set(e.target.value)}
              className="h-48 rounded border border-border bg-background p-2 font-mono text-xs"
            />
          </div>
        ))}
      </div>

      <div className="flex items-center gap-2">
        <button
          onClick={submit}
          disabled={planM.isPending}
          className="rounded bg-primary px-4 py-1.5 text-sm text-primary-foreground hover:opacity-90 disabled:opacity-50"
        >
          {planM.isPending ? 'Planning…' : 'Plan'}
        </button>
        <button
          onClick={() => { setInitial(EXAMPLE.initial); setGoal(EXAMPLE.goal); setActions(EXAMPLE.actions); }}
          className="rounded border border-border px-4 py-1.5 text-sm text-muted-foreground hover:bg-accent hover:text-accent-foreground"
        >
          Load example
        </button>
        {parseError && <span className="text-sm text-destructive">JSON error: {parseError}</span>}
      </div>

      {planM.data && (
        <div className="rounded border border-border bg-card p-3">
          <h2 className="text-sm font-semibold">
            {planM.data.plan === null
              ? 'No plan exists'
              : planM.data.plan.length === 0
                ? 'Goal already satisfied'
                : `Plan (cost ${planM.data.totalCost})`}
          </h2>
          {planM.data.plan && planM.data.plan.length > 0 && (
            <ol className="mt-2 space-y-1 text-sm">
              {planM.data.plan.map((a: GoapAction, i: number) => (
                <li key={i} className="flex items-baseline gap-3">
                  <span className="text-xs text-muted-foreground">{i + 1}.</span>
                  <span className="font-mono font-semibold">{a.name}</span>
                  <span className="text-xs text-muted-foreground">cost: {a.cost}</span>
                </li>
              ))}
            </ol>
          )}
        </div>
      )}
    </div>
  );
}
