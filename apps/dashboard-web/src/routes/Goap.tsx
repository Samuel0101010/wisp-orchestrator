import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { usePlanGoap, type GoapAction } from '@/api/queries';

const EXAMPLE = {
  initial: '{}',
  goal: '{"hasReport": true}',
  actions: JSON.stringify(
    [
      { name: 'gather-info', cost: 1, preconditions: {}, effects: { hasInfo: true } },
      {
        name: 'analyze',
        cost: 2,
        preconditions: { hasInfo: true },
        effects: { hasAnalysis: true },
      },
      {
        name: 'write-report',
        cost: 3,
        preconditions: { hasAnalysis: true },
        effects: { hasReport: true },
      },
    ],
    null,
    2,
  ),
};

export function GoapRoute() {
  const { t } = useTranslation();
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
        <h1 className="text-2xl font-semibold">{t('goap.title')}</h1>
        <p className="mt-1 max-w-3xl text-sm text-muted-foreground">{t('goap.subtitle')}</p>
      </header>

      <div className="grid grid-cols-1 gap-3 md:grid-cols-3">
        {[
          { label: t('goap.fields.start'), value: initial, set: setInitial },
          { label: t('goap.fields.goal'), value: goal, set: setGoal },
          { label: t('goap.fields.actions'), value: actions, set: setActions },
        ].map(({ label, value, set }) => (
          <div key={label} className="flex flex-col gap-1">
            <label className="text-xs font-medium uppercase tracking-wide text-muted-foreground">
              {label}
            </label>
            <textarea
              value={value}
              onChange={(e) => set(e.target.value)}
              className="h-56 rounded-md border border-border bg-background p-2 font-mono text-xs focus:outline-none focus:ring-2 focus:ring-ring"
              spellCheck={false}
            />
          </div>
        ))}
      </div>

      <div className="flex flex-wrap items-center gap-2">
        <button
          onClick={submit}
          disabled={planM.isPending}
          className="rounded-md bg-primary px-4 py-1.5 text-sm font-medium text-primary-foreground transition-opacity hover:opacity-90 disabled:cursor-not-allowed disabled:opacity-50"
        >
          {planM.isPending ? t('goap.actions.planning') : t('goap.actions.plan')}
        </button>
        <button
          onClick={() => {
            setInitial(EXAMPLE.initial);
            setGoal(EXAMPLE.goal);
            setActions(EXAMPLE.actions);
          }}
          className="rounded-md border border-border px-4 py-1.5 text-sm text-muted-foreground transition-colors hover:bg-accent hover:text-accent-foreground"
        >
          Load example
        </button>
        {parseError && (
          <span className="text-sm text-destructive" role="alert">
            JSON error: {parseError}
          </span>
        )}
      </div>

      {!planM.data && !planM.isPending && !parseError && (
        <p className="text-sm text-muted-foreground">{t('goap.noResult')}</p>
      )}

      {planM.data && (
        <div className="rounded-md border border-border bg-card p-4">
          <h2 className="text-sm font-semibold">
            {planM.data.plan === null
              ? 'No plan exists'
              : planM.data.plan.length === 0
                ? 'Goal already satisfied'
                : `${t('goap.result')} (cost ${planM.data.totalCost})`}
          </h2>
          {planM.data.plan && planM.data.plan.length > 0 && (
            <ol className="mt-2 space-y-1 text-sm">
              {planM.data.plan.map((a: GoapAction, i: number) => (
                <li key={i} className="flex items-baseline gap-3">
                  <span className="font-mono text-xs text-muted-foreground">{i + 1}.</span>
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
