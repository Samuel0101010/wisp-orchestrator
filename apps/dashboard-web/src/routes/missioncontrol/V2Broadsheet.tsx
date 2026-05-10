import { useMemo } from 'react';
import { Link } from 'react-router-dom';
import { useGlobalRuns, useRunsSummary } from '@/api/queries';
import { VariantSwitcher } from './Switcher';

function fmtNum(n: number) {
  return n.toLocaleString('en-US');
}

function fmtTok(n: number) {
  if (n < 1000) return String(n);
  if (n < 1_000_000) return `${(n / 1000).toFixed(1)}k`;
  return `${(n / 1_000_000).toFixed(2)}M`;
}

function statusWord(s: string): string {
  return (
    {
      running: 'In flight',
      paused: 'Paused',
      succeeded: 'Closed · ok',
      failed: 'Closed · failure',
      cancelled: 'Cancelled',
      pending: 'Awaiting',
      queued: 'Queued',
    } as Record<string, string>
  )[s] ?? s;
}

function ThroughputBars({ data }: { data: Array<{ day: string; tokens: number }> }) {
  if (!data.length) {
    return <div className="font-serif italic text-stone-500">No telemetry recorded.</div>;
  }
  const max = Math.max(...data.map((d) => d.tokens), 1);
  return (
    <div className="grid grid-cols-7 items-end gap-2" style={{ height: 96 }}>
      {data.map((d) => {
        const h = Math.max(2, (d.tokens / max) * 96);
        const day = new Date(d.day).toLocaleDateString('en-US', { weekday: 'short' });
        return (
          <div key={d.day} className="flex h-full flex-col items-stretch justify-end gap-1">
            <div className="bg-stone-900" style={{ height: h }} aria-label={`${d.day}: ${d.tokens}`} />
            <div className="text-center font-mono text-[9px] uppercase tracking-[0.2em] text-stone-600">
              {day}
            </div>
          </div>
        );
      })}
    </div>
  );
}

export function MissionControlV2Broadsheet() {
  const summary = useRunsSummary(7);
  const runs = useGlobalRuns(100);
  const data = runs.data ?? [];

  const dateline = useMemo(
    () =>
      new Date().toLocaleDateString('en-US', {
        weekday: 'long',
        year: 'numeric',
        month: 'long',
        day: 'numeric',
      }),
    [],
  );

  const live = data.filter((r) => r.status === 'running' || r.status === 'paused').slice(0, 3);
  const closed = data.filter((r) => r.status !== 'running' && r.status !== 'paused').slice(0, 12);

  const success = summary.data?.outcomeCounts.success ?? 0;
  const total = summary.data?.totalRuns ?? 0;
  const successPct = total ? Math.round((success / total) * 100) : 0;

  return (
    <div
      data-mc-variant="broadsheet"
      className="-m-6 min-h-[calc(100vh-3.5rem)] bg-[#f4ede1] px-10 pb-16 pt-6 text-stone-900"
    >
      <style>{`
        [data-mc-variant="broadsheet"] { font-feature-settings: "onum","liga","kern"; }
        [data-mc-variant="broadsheet"] .masthead {
          font-family: ui-serif, "Iowan Old Style", "Charter", "Georgia", serif;
          font-weight: 900;
          letter-spacing: -0.04em;
          font-stretch: 105%;
        }
        [data-mc-variant="broadsheet"] .body-serif {
          font-family: ui-serif, "Iowan Old Style", "Charter", "Georgia", serif;
        }
        [data-mc-variant="broadsheet"] .smallcaps {
          font-variant-caps: all-small-caps;
          letter-spacing: 0.12em;
        }
        [data-mc-variant="broadsheet"] hr.thick { border: 0; border-top: 4px solid #1c1917; }
        [data-mc-variant="broadsheet"] hr.thin { border: 0; border-top: 1px solid #44403c; }
        [data-mc-variant="broadsheet"] hr.hair { border: 0; border-top: 0.5px solid rgba(28,25,23,0.4); }
        [data-mc-variant="broadsheet"] a { color: inherit; text-decoration: underline; text-decoration-thickness: 0.5px; text-underline-offset: 3px; }
      `}</style>

      <VariantSwitcher tone="cream" />

      <header className="mt-2">
        <div className="flex items-baseline justify-between border-b border-stone-900/30 pb-1 text-[11px] uppercase tracking-[0.2em] text-stone-700 smallcaps">
          <span>Vol. I · No. 1208</span>
          <span>{dateline}</span>
          <span>Edition · Mission Control</span>
        </div>
        <h1 className="masthead mt-2 text-[clamp(3.5rem,10vw,9rem)] leading-[0.85]">The Harness Ledger</h1>
        <div className="mt-2 flex items-baseline justify-between border-t-4 border-stone-900 pt-2 text-[11px] tracking-[0.2em] text-stone-700 smallcaps">
          <span>“All that the agents do, in plain sight.”</span>
          <span className="font-mono">v1.2 · agent-harness</span>
        </div>
      </header>

      <hr className="thick mt-6" />

      <section className="mt-8 grid grid-cols-1 gap-10 lg:grid-cols-12">
        <article className="lg:col-span-5">
          <div className="smallcaps text-[11px] text-stone-700">Above the fold</div>
          <h2 className="body-serif mt-1 text-3xl font-bold leading-tight">
            {summary.data?.activeCount ? (
              <>
                {summary.data.activeCount}{' '}
                {summary.data.activeCount === 1 ? 'agent run is in flight' : 'agent runs are in flight'}; the
                rest of the docket awaits.
              </>
            ) : (
              <>The runway is clear; no agent runs are in flight at press time.</>
            )}
          </h2>
          <hr className="hair my-4" />
          <p className="body-serif text-[15px] leading-[1.55] text-stone-800">
            Over the trailing seven days the harness has dispatched{' '}
            <strong>{fmtNum(total)}</strong> runs across its assigned projects, consuming{' '}
            <strong>{fmtTok(summary.data?.totalTokens ?? 0)}</strong> tokens of model attention. Of those{' '}
            that reached an outcome, <strong>{successPct}%</strong> closed in the manner intended; the
            remainder are itemized below.
          </p>

          <hr className="hair my-4" />
          <div className="smallcaps mb-2 text-[11px] text-stone-700">In flight</div>
          {live.length === 0 ? (
            <p className="body-serif italic text-stone-600">
              No active dispatches; the editor's desk is quiet.
            </p>
          ) : (
            <ul className="body-serif divide-y divide-stone-900/15 text-[14px] leading-snug">
              {live.map((r) => (
                <li key={r.id} className="py-2">
                  <Link to={`/projects/${r.projectId}/run/${r.id}`} className="block">
                    <div className="flex items-baseline justify-between">
                      <span className="font-bold">{r.projectName}</span>
                      <span className="font-mono text-[10px] tracking-[0.15em] text-stone-600">
                        {statusWord(r.status)}
                      </span>
                    </div>
                    <div className="mt-0.5 text-[12px] text-stone-700">
                      Run <span className="font-mono">{r.id.slice(0, 10)}</span> ·{' '}
                      <span className="font-mono">{fmtTok(r.tokensInTotal + r.tokensOutTotal)}</span> tokens
                      committed across {r.turnsTotal} turn{r.turnsTotal === 1 ? '' : 's'}.
                    </div>
                  </Link>
                </li>
              ))}
            </ul>
          )}
        </article>

        <article className="lg:col-span-4 lg:border-x lg:border-stone-900/30 lg:px-8">
          <div className="smallcaps text-[11px] text-stone-700">Telemetry · seven days</div>
          <h3 className="body-serif mt-1 text-2xl font-bold leading-tight">Token throughput, by day</h3>
          <hr className="hair my-3" />
          <ThroughputBars data={summary.data?.tokensByDay ?? []} />
          <p className="body-serif mt-4 text-[13px] leading-[1.55] text-stone-800">
            A bar chart spelt out in print: each column is one day's combined input-plus-output token
            spend. Tall bars mark heavier dispatch days; flat bars mark days the editor took off.
          </p>
          <hr className="hair my-4" />
          <dl className="body-serif grid grid-cols-2 gap-y-2 text-[13px]">
            <dt className="text-stone-700">Total runs</dt>
            <dd className="text-right font-bold tabular-nums">{fmtNum(total)}</dd>
            <dt className="text-stone-700">Tokens, total</dt>
            <dd className="text-right font-bold tabular-nums">{fmtTok(summary.data?.totalTokens ?? 0)}</dd>
            <dt className="text-stone-700">Average duration</dt>
            <dd className="text-right font-bold tabular-nums">
              {Math.round((summary.data?.avgDurationMs ?? 0) / 60_000)}m
            </dd>
            <dt className="text-stone-700">Successful</dt>
            <dd className="text-right font-bold tabular-nums">
              {success}/{total} <span className="text-stone-600">({successPct}%)</span>
            </dd>
            <dt className="text-stone-700">Failed</dt>
            <dd className="text-right font-bold tabular-nums">
              {summary.data?.outcomeCounts.failure ?? 0}
            </dd>
            <dt className="text-stone-700">Cancelled</dt>
            <dd className="text-right font-bold tabular-nums">
              {summary.data?.outcomeCounts.cancelled ?? 0}
            </dd>
          </dl>
        </article>

        <article className="lg:col-span-3">
          <div className="smallcaps text-[11px] text-stone-700">The docket</div>
          <h3 className="body-serif mt-1 text-2xl font-bold leading-tight">Recent runs</h3>
          <hr className="hair my-3" />
          {closed.length === 0 ? (
            <p className="body-serif italic text-stone-600">The docket is empty.</p>
          ) : (
            <ol className="body-serif divide-y divide-stone-900/10 text-[13px]">
              {closed.map((r, i) => (
                <li key={r.id} className="py-2">
                  <Link to={`/projects/${r.projectId}/run/${r.id}`} className="block">
                    <div className="flex items-baseline gap-2">
                      <span className="w-5 text-right font-mono text-[11px] tabular-nums text-stone-500">
                        {String(i + 1).padStart(2, '0')}.
                      </span>
                      <span className="font-bold">{r.projectName}</span>
                    </div>
                    <div className="ml-7 text-[11px] text-stone-700">
                      <span className="font-mono">{r.id.slice(0, 8)}</span> · {statusWord(r.status)} ·{' '}
                      <span className="font-mono">{fmtTok(r.tokensInTotal + r.tokensOutTotal)}</span>
                    </div>
                  </Link>
                </li>
              ))}
            </ol>
          )}
        </article>
      </section>

      <hr className="thin mt-12" />
      <footer className="mt-3 flex items-baseline justify-between text-[11px] tracking-[0.2em] text-stone-700 smallcaps">
        <span>— Set in Iowan / Georgia, with mono numerals from Menlo.</span>
        <span>Page A · 1</span>
      </footer>
    </div>
  );
}
