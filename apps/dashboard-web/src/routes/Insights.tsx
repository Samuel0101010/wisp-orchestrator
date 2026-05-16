import { useTranslation } from 'react-i18next';
import { useQuery } from '@tanstack/react-query';
import { Sparkles, FileText, Activity } from 'lucide-react';
import { apiFetch } from '@/api/client';
import { useRunSummaries } from '@/api/queries';
import { Skeleton } from '@/components/ui/skeleton';
import { ErrorBanner } from '@/components/ui/error-banner';
import { EmptyState } from '@/components/ui/empty-state';

interface TrajectoryRow {
  id: string;
  projectId: string | null;
  prompt: string;
  outcome: string;
  lessons: string | null;
  tokensTotal: number;
  createdAt: string | number;
}
interface PriorRow {
  role: string;
  baseRole: string;
  phase: 'orchestration' | 'substantive' | 'unspecified';
  model: string;
  alpha: number;
  beta: number;
  mean: number;
  samples: number;
}

function LoadingRows({ rows = 3 }: { rows?: number }) {
  return (
    <div className="space-y-2">
      {Array.from({ length: rows }).map((_, i) => (
        <Skeleton key={i} className="h-4 w-full" />
      ))}
    </div>
  );
}

export function InsightsRoute() {
  const { t } = useTranslation();
  const trajQ = useQuery<TrajectoryRow[]>({
    queryKey: ['insights', 'trajectories'],
    queryFn: () => apiFetch('/api/insights/trajectories'),
  });
  const priorsQ = useQuery<PriorRow[]>({
    queryKey: ['insights', 'router-priors'],
    queryFn: () => apiFetch('/api/insights/router-priors'),
  });
  const summariesQ = useRunSummaries();

  return (
    <div className="space-y-8">
      <header>
        <h1 className="text-2xl font-semibold">{t('insights.title')}</h1>
        <p className="mt-1 text-sm text-muted-foreground">
          {t('insights.trajectoriesTitle')} · {t('insights.summariesTitle')} ·{' '}
          {t('insights.priorsTitle')}
        </p>
      </header>

      <section className="space-y-2" aria-labelledby="insights-trajectories">
        <h2 id="insights-trajectories" className="text-lg font-semibold">
          {t('insights.trajectoriesTitle')}
        </h2>
        {trajQ.isLoading ? (
          <LoadingRows />
        ) : trajQ.error ? (
          <ErrorBanner onRetry={() => trajQ.refetch()} />
        ) : (trajQ.data?.length ?? 0) === 0 ? (
          <div className="rounded-md border border-dashed border-border/40">
            <EmptyState
              icon={<Sparkles />}
              title={t('insights.trajectories.empty.title')}
              description={t('insights.trajectories.empty.description')}
            />
          </div>
        ) : (
          <div
            className="overflow-x-auto rounded-md border border-border"
            tabIndex={0}
            role="region"
            aria-label={t('insights.trajectoriesTitle')}
          >
            <table className="w-full min-w-[640px] text-sm">
              <thead className="bg-muted/40 text-left text-xs uppercase tracking-wide text-muted-foreground">
                <tr>
                  <th className="px-3 py-2">{t('insights.cols.ts')}</th>
                  <th className="px-3 py-2">{t('insights.cols.outcome')}</th>
                  <th className="px-3 py-2">{t('insights.cols.prompt')}</th>
                  <th className="px-3 py-2">{t('insights.cols.tokens')}</th>
                </tr>
              </thead>
              <tbody>
                {trajQ.data?.map((traj) => (
                  <tr key={traj.id} className="border-t border-border">
                    <td className="px-3 py-1.5 text-xs tabular-nums">
                      {new Date(traj.createdAt).toLocaleString()}
                    </td>
                    <td className="px-3 py-1.5">
                      <span
                        className={
                          traj.outcome === 'success'
                            ? 'text-emerald-600 dark:text-emerald-400'
                            : 'text-destructive'
                        }
                      >
                        {traj.outcome}
                      </span>
                    </td>
                    <td className="max-w-md truncate px-3 py-1.5">{traj.prompt}</td>
                    <td className="px-3 py-1.5 font-mono tabular-nums">{traj.tokensTotal}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>

      <section className="space-y-2" aria-labelledby="insights-summaries">
        <h2 id="insights-summaries" className="text-lg font-semibold">
          {t('insights.summariesTitle')}
        </h2>
        {summariesQ.isLoading ? (
          <LoadingRows />
        ) : summariesQ.error ? (
          <ErrorBanner onRetry={() => summariesQ.refetch()} />
        ) : (summariesQ.data?.length ?? 0) === 0 ? (
          <div className="rounded-md border border-dashed border-border/40">
            <EmptyState
              icon={<FileText />}
              title={t('insights.runSummaries.empty.title')}
              description={t('insights.runSummaries.empty.description')}
            />
          </div>
        ) : (
          <ul className="space-y-2">
            {summariesQ.data?.map((s) => (
              <li
                key={s.runId}
                className="rounded-md border border-border bg-card p-3 text-sm shadow-sm"
              >
                <div className="mb-1 flex items-center justify-between text-xs text-muted-foreground">
                  <span>{new Date(s.createdAt).toLocaleString()}</span>
                  <span className="font-mono">{s.runId.slice(0, 8)}</span>
                </div>
                <pre className="whitespace-pre-wrap font-sans leading-relaxed">{s.summaryMd}</pre>
              </li>
            ))}
          </ul>
        )}
      </section>

      <section className="space-y-2" aria-labelledby="insights-priors">
        <h2 id="insights-priors" className="text-lg font-semibold">
          {t('insights.priorsTitle')}
        </h2>
        {priorsQ.isLoading ? (
          <LoadingRows />
        ) : priorsQ.error ? (
          <ErrorBanner onRetry={() => priorsQ.refetch()} />
        ) : (priorsQ.data?.length ?? 0) === 0 ? (
          <div className="rounded-md border border-dashed border-border/40">
            <EmptyState
              icon={<Activity />}
              title={t('insights.routerPriors.empty.title')}
              description={t('insights.routerPriors.empty.description')}
            />
          </div>
        ) : (
          <div
            className="overflow-x-auto rounded-md border border-border"
            tabIndex={0}
            role="region"
            aria-label={t('insights.priorsTitle')}
          >
            <table className="w-full min-w-[640px] text-sm">
              <thead className="bg-muted/40 text-left text-xs uppercase tracking-wide text-muted-foreground">
                <tr>
                  <th className="px-3 py-2">{t('insights.cols.role')}</th>
                  <th className="px-3 py-2">{t('insights.cols.phase')}</th>
                  <th className="px-3 py-2">{t('insights.cols.model')}</th>
                  <th className="px-3 py-2">α</th>
                  <th className="px-3 py-2">β</th>
                  <th className="px-3 py-2">{t('insights.cols.mean')}</th>
                  <th className="px-3 py-2">{t('insights.cols.samples')}</th>
                </tr>
              </thead>
              <tbody>
                {priorsQ.data?.map((p) => (
                  <tr key={`${p.role}-${p.model}`} className="border-t border-border">
                    <td className="px-3 py-1.5 font-mono">{p.role}</td>
                    <td className="px-3 py-1.5 font-mono text-xs">{p.phase}</td>
                    <td className="px-3 py-1.5 font-mono">{p.model}</td>
                    <td className="px-3 py-1.5 tabular-nums">{p.alpha.toFixed(2)}</td>
                    <td className="px-3 py-1.5 tabular-nums">{p.beta.toFixed(2)}</td>
                    <td className="px-3 py-1.5 tabular-nums">{p.mean.toFixed(3)}</td>
                    <td className="px-3 py-1.5 tabular-nums">{p.samples}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>
    </div>
  );
}
