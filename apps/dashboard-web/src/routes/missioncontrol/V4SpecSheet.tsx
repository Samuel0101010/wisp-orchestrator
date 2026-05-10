import { useMemo } from 'react';
import { Link } from 'react-router-dom';
import { useGlobalRuns, useRunsSummary } from '@/api/queries';
import type { GlobalRunRow } from '@/api/queries';
import { VariantSwitcher } from './Switcher';

const COBALT = '#1d3a8a';
const RED = '#a81f1a';

function fmtTok(n: number) {
  if (n < 1000) return String(n);
  if (n < 1_000_000) return `${(n / 1000).toFixed(1)}k`;
  return `${(n / 1_000_000).toFixed(2)}M`;
}

function statusToken(r: GlobalRunRow): string {
  if (r.status === 'running') return 'RUN';
  if (r.status === 'paused') return 'PSE';
  if (r.status === 'cancelled') return 'CXL';
  if (r.status === 'failed' || r.outcome === 'failure' || r.outcome === 'budget_exceeded')
    return 'FAI';
  if (r.status === 'completed') return 'OK ';
  return 'WAI';
}
function isFailed(r: GlobalRunRow): boolean {
  return r.status === 'failed' || r.outcome === 'failure' || r.outcome === 'budget_exceeded';
}
function isSuccess(r: GlobalRunRow): boolean {
  return r.status === 'completed' && r.outcome === 'success';
}

function CornerTickFrame({
  children,
  label,
  serial,
  className = '',
}: {
  children: React.ReactNode;
  label?: string;
  serial?: string;
  className?: string;
}) {
  return (
    <div
      className={`relative border border-stone-900/60 ${className}`}
      style={{ background: '#fbf8f1' }}
    >
      <CornerTicks />
      {(label || serial) && (
        <div className="flex items-baseline justify-between border-b border-stone-900/40 px-3 py-1.5 text-[10px] uppercase tracking-[0.22em] text-stone-700">
          <span>{label}</span>
          <span className="font-mono text-[9px] text-stone-600">{serial}</span>
        </div>
      )}
      <div>{children}</div>
    </div>
  );
}

function CornerTicks() {
  const c = 'absolute h-2 w-2 border-stone-900';
  return (
    <>
      <span className={`${c} -left-px -top-px border-l border-t`} />
      <span className={`${c} -right-px -top-px border-r border-t`} />
      <span className={`${c} -bottom-px -left-px border-b border-l`} />
      <span className={`${c} -bottom-px -right-px border-b border-r`} />
    </>
  );
}

function ProjectSpec({ projectName, runs }: { projectName: string; runs: GlobalRunRow[] }) {
  const totalIn = runs.reduce((s, r) => s + r.tokensInTotal, 0);
  const totalOut = runs.reduce((s, r) => s + r.tokensOutTotal, 0);
  const turns = runs.reduce((s, r) => s + r.turnsTotal, 0);
  const live = runs.filter((r) => r.status === 'running' || r.status === 'paused').length;
  const success = runs.filter(isSuccess).length;
  const failure = runs.filter(isFailed).length;
  const closed = success + failure;
  const okPct = closed ? Math.round((success / closed) * 100) : null;
  const head = runs[0];

  return (
    <CornerTickFrame
      label={`spec · ${projectName}`}
      serial={`PRJ-${head ? head.projectId.slice(0, 6).toUpperCase() : '——————'}`}
    >
      <div className="grid grid-cols-[1fr_auto] gap-x-4 gap-y-3 px-4 py-4">
        <div>
          <div className="text-[11px] uppercase tracking-[0.2em] text-stone-600">designation</div>
          <div className="mt-0.5 text-lg font-semibold tracking-tight text-stone-900">
            {projectName}
          </div>
          <div className="font-mono text-[10px] text-stone-600">
            {runs.length} run{runs.length === 1 ? '' : 's'} on file ·{' '}
            {live > 0 ? <span style={{ color: RED }}>● {live} active</span> : 'idle'}
          </div>
        </div>
        <div className="flex items-center gap-3 text-[10px] uppercase tracking-[0.2em] text-stone-600">
          <Stamp
            text={live > 0 ? 'in flight' : closed ? 'closed' : '—'}
            tone={live > 0 ? RED : COBALT}
          />
        </div>
      </div>

      <div className="border-t border-stone-900/30">
        <DimensionRow k="tokens.in" v={fmtTok(totalIn)} unit="tok" />
        <DimensionRow k="tokens.out" v={fmtTok(totalOut)} unit="tok" />
        <DimensionRow k="turns.total" v={String(turns)} unit="turns" />
        <DimensionRow
          k="success.rate"
          v={okPct === null ? '—' : `${okPct}`}
          unit={okPct === null ? '' : '%'}
          tolerance={okPct === null ? '' : `±${100 - okPct}`}
        />
        <DimensionRow k="state.failed" v={String(failure)} unit="runs" />
      </div>

      <div className="border-t border-stone-900/30 px-4 py-3">
        <div className="mb-2 text-[10px] uppercase tracking-[0.2em] text-stone-600">
          part list · runs
        </div>
        <ol className="font-mono text-[11px]">
          {runs.slice(0, 5).map((r, i) => (
            <li key={r.id} className="flex items-baseline gap-2 border-b border-stone-900/10 py-1">
              <span className="w-6 text-stone-500">{String(i + 1).padStart(2, '0')}.</span>
              <span
                className="w-9 text-[10px] tracking-[0.1em]"
                style={{
                  color:
                    r.status === 'running' || r.status === 'paused' || isFailed(r) ? RED : COBALT,
                }}
              >
                {statusToken(r)}
              </span>
              <span className="flex-1 truncate text-stone-800">{r.id.slice(0, 12)}</span>
              <span className="tabular-nums text-stone-700">
                {fmtTok(r.tokensInTotal + r.tokensOutTotal)}
              </span>
              <Link
                to={`/projects/${r.projectId}/run/${r.id}`}
                className="text-[10px] tracking-[0.18em] text-stone-600 underline-offset-2 hover:underline"
                style={{ color: COBALT }}
              >
                ↗
              </Link>
            </li>
          ))}
          {runs.length > 5 && (
            <li className="pt-1 text-[10px] uppercase tracking-[0.2em] text-stone-500">
              + {runs.length - 5} additional runs on file
            </li>
          )}
        </ol>
      </div>
    </CornerTickFrame>
  );
}

function Stamp({ text, tone }: { text: string; tone: string }) {
  return (
    <span
      className="rounded-[2px] border px-2 py-1 text-[10px] uppercase tracking-[0.25em]"
      style={{ borderColor: tone, color: tone }}
    >
      {text}
    </span>
  );
}

function DimensionRow({
  k,
  v,
  unit,
  tolerance,
}: {
  k: string;
  v: string;
  unit?: string;
  tolerance?: string;
}) {
  return (
    <div className="grid grid-cols-[120px_auto_1fr_auto] items-center gap-3 border-b border-stone-900/10 px-4 py-1.5">
      <span className="font-mono text-[10px] uppercase tracking-[0.18em] text-stone-700">{k}</span>
      <span className="h-px flex-none" style={{ width: 16, background: '#1c1917' }} />
      <span className="relative flex items-center">
        <span
          className="block h-px flex-1"
          style={{
            background: 'repeating-linear-gradient(to right, #1c1917 0 4px, transparent 4px 8px)',
          }}
        />
      </span>
      <span className="flex items-baseline gap-1 font-mono text-[12px] tabular-nums">
        <span className="font-semibold text-stone-900">{v}</span>
        {unit && <span className="text-[10px] text-stone-600">{unit}</span>}
        {tolerance && <span className="ml-2 text-[10px] text-stone-500">{tolerance}</span>}
      </span>
    </div>
  );
}

export function MissionControlV4SpecSheet() {
  const summary = useRunsSummary(7);
  const runs = useGlobalRuns(100);
  const data = runs.data ?? [];

  const grouped = useMemo(() => {
    const m = new Map<string, GlobalRunRow[]>();
    data.forEach((r) => {
      const arr = m.get(r.projectName) ?? [];
      arr.push(r);
      m.set(r.projectName, arr);
    });
    return Array.from(m.entries()).sort((a, b) => b[1].length - a[1].length);
  }, [data]);

  const today = useMemo(
    () =>
      new Date().toLocaleDateString('en-US', {
        year: '2-digit',
        month: '2-digit',
        day: '2-digit',
      }),
    [],
  );

  return (
    <div
      data-mc-variant="specsheet"
      className="-m-6 min-h-[calc(100vh-3.5rem)] px-8 pb-12 pt-6"
      style={{
        background:
          'repeating-linear-gradient(0deg, transparent 0 23px, rgba(28,25,23,0.06) 23px 24px), repeating-linear-gradient(90deg, transparent 0 23px, rgba(28,25,23,0.06) 23px 24px), #fbf8f1',
        color: '#1c1917',
      }}
    >
      <style>{`
        [data-mc-variant="specsheet"] { font-feature-settings: "tnum","ss01"; }
        [data-mc-variant="specsheet"] *::selection { background: #1d3a8a; color: #fbf8f1; }
      `}</style>

      <VariantSwitcher tone="paper" />

      <header className="grid grid-cols-[1fr_auto] gap-6 border-b-2 border-stone-900 pb-3">
        <div>
          <div className="font-mono text-[10px] uppercase tracking-[0.25em] text-stone-700">
            harness · industries · mission control · spec sheet
          </div>
          <h1
            className="mt-1 text-4xl font-bold leading-[0.95] tracking-tight text-stone-900"
            style={{ fontStretch: '90%', letterSpacing: '-0.015em' }}
          >
            Operational specifications
            <span className="ml-3 align-middle text-2xl font-normal text-stone-500">
              · projects in observation
            </span>
          </h1>
        </div>
        <div className="flex flex-col items-end gap-1 text-[10px] uppercase tracking-[0.22em] text-stone-700">
          <table className="border border-stone-900/60 font-mono">
            <tbody>
              <Meta k="sheet" v="MC-001" />
              <Meta k="rev" v="A" />
              <Meta k="date" v={today} />
              <Meta k="scale" v="1:1" />
              <Meta k="window" v="7d" />
            </tbody>
          </table>
        </div>
      </header>

      <section className="mt-6">
        <CornerTickFrame label="general · 7-day rollup" serial="GEN-001">
          <div className="grid grid-cols-2 gap-x-8 gap-y-1 px-4 py-3 md:grid-cols-4">
            <DimensionRow k="active.runs" v={String(summary.data?.activeCount ?? 0)} unit="" />
            <DimensionRow
              k="runs.total"
              v={String(summary.data?.totalRuns ?? 0)}
              unit="in window"
            />
            <DimensionRow k="tokens.total" v={fmtTok(summary.data?.totalTokens ?? 0)} unit="tok" />
            <DimensionRow
              k="success"
              v={`${Math.round((summary.data?.successRate ?? 0) * 100)}`}
              unit="%"
              tolerance={`n=${summary.data?.totalRuns ?? 0}`}
            />
          </div>
        </CornerTickFrame>
      </section>

      <section className="mt-8">
        <div className="mb-3 flex items-baseline justify-between border-b border-stone-900/40 pb-1">
          <h2 className="text-sm font-semibold uppercase tracking-[0.22em] text-stone-700">
            Sheet 02 · projects, in detail
          </h2>
          <span className="font-mono text-[10px] uppercase tracking-[0.2em] text-stone-600">
            {grouped.length} projects · {data.length} runs · all dimensions in tokens unless noted
          </span>
        </div>
        {grouped.length === 0 ? (
          <CornerTickFrame label="no projects on file">
            <div className="px-4 py-6 font-mono text-[12px] text-stone-700">
              No projects under observation. Create one from the sidebar to populate this sheet.
            </div>
          </CornerTickFrame>
        ) : (
          <div className="grid grid-cols-1 gap-6 lg:grid-cols-2 xl:grid-cols-3">
            {grouped.map(([name, rs]) => (
              <ProjectSpec key={name} projectName={name} runs={rs} />
            ))}
          </div>
        )}
      </section>

      <footer className="mt-12 grid grid-cols-[1fr_auto] items-end gap-4 border-t-2 border-stone-900 pt-3 text-[10px] uppercase tracking-[0.22em] text-stone-700">
        <div>
          Drawn at scale · all measurements verified at last refresh ·{' '}
          <span className="font-mono">tabular-nums</span>
        </div>
        <div className="font-mono">Sheet 02 of 02 · MC-001 / A · {today} · agent-harness</div>
      </footer>
    </div>
  );
}

function Meta({ k, v }: { k: string; v: string }) {
  return (
    <tr className="border-b border-stone-900/40 last:border-b-0">
      <td className="border-r border-stone-900/40 px-2 py-0.5 text-stone-700">{k}</td>
      <td className="px-2 py-0.5 text-stone-900">{v}</td>
    </tr>
  );
}
