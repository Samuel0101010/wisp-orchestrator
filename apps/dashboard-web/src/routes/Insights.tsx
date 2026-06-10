import { useTranslation } from 'react-i18next';
import { useQuery } from '@tanstack/react-query';
import { Sparkles, FileText, Activity } from 'lucide-react';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import { apiFetch } from '@/api/client';
import { useRunSummaries } from '@/api/queries';
import { Skeleton } from '@/components/ui/skeleton';
import { ErrorBanner } from '@/components/ui/error-banner';
import { EmptyState } from '@/components/ui/empty-state';
import { StatusPill } from '@/components/ui/status-pill';
import { statusLabel, statusMeta } from '@/lib/status-labels';

/**
 * Prose styling for rendered run-summary Markdown — same token-driven rules
 * as the chat transcript so headings/bold/lists/code read consistently.
 */
const SUMMARY_PROSE =
  'max-w-prose space-y-2 break-words text-sm leading-relaxed [&_a]:text-info [&_a]:underline [&_code]:rounded [&_code]:bg-foreground/10 [&_code]:px-1 [&_code]:py-0.5 [&_code]:font-mono [&_code]:text-xs [&_h1]:text-base [&_h1]:font-semibold [&_h2]:text-sm [&_h2]:font-semibold [&_h3]:font-semibold [&_li]:my-0.5 [&_ol]:list-decimal [&_ol]:pl-5 [&_pre]:overflow-x-auto [&_pre]:rounded [&_pre]:bg-foreground/10 [&_pre]:p-2 [&_pre_code]:bg-transparent [&_pre_code]:p-0 [&_strong]:font-semibold [&_ul]:list-disc [&_ul]:pl-5';

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
  const { t, i18n } = useTranslation();
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
        <nav aria-label={t('insights.jumpNav')} className="mt-2 flex flex-wrap gap-2 text-sm">
          {(
            [
              ['#insights-trajectories', 'insights.trajectoriesTitle'],
              ['#insights-summaries', 'insights.summariesTitle'],
              ['#insights-priors', 'insights.priorsTitle'],
            ] as const
          ).map(([href, key]) => (
            <a
              key={href}
              href={href}
              className="rounded-md border border-border bg-card px-2.5 py-1 text-muted-foreground transition hover:bg-accent hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
            >
              {t(key)}
            </a>
          ))}
        </nav>
      </header>

      <section className="space-y-2" aria-labelledby="insights-trajectories">
        <h2 id="insights-trajectories" className="scroll-mt-20 text-lg font-semibold">
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
                {trajQ.data?.map((traj) => {
                  const meta = statusMeta(traj.outcome);
                  const OutcomeIcon = meta.Icon;
                  return (
                    <tr key={traj.id} className="border-t border-border">
                      <td className="px-3 py-1.5 text-xs tabular-nums">
                        {new Date(traj.createdAt).toLocaleString()}
                      </td>
                      <td className="px-3 py-1.5">
                        <StatusPill
                          tone={meta.tone}
                          live={meta.live}
                          icon={<OutcomeIcon className="size-3" />}
                        >
                          {statusLabel(traj.outcome, t)}
                        </StatusPill>
                      </td>
                      <td className="max-w-md truncate px-3 py-1.5">{traj.prompt}</td>
                      <td className="px-3 py-1.5 font-mono tabular-nums">
                        {traj.tokensTotal.toLocaleString(i18n.language)}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
      </section>

      <section className="space-y-2" aria-labelledby="insights-summaries">
        <h2 id="insights-summaries" className="scroll-mt-20 text-lg font-semibold">
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
                <div className={SUMMARY_PROSE}>
                  {/* Summaries are agent-written markdown and routinely start with
                      "# …" headings — demote them so the page keeps a single h1
                      (a11y) and heading-scoped tests stay deterministic. */}
                  <ReactMarkdown remarkPlugins={[remarkGfm]} components={{ h1: 'h3', h2: 'h4' }}>
                    {s.summaryMd}
                  </ReactMarkdown>
                </div>
              </li>
            ))}
          </ul>
        )}
      </section>

      <section className="space-y-2" aria-labelledby="insights-priors">
        <h2 id="insights-priors" className="scroll-mt-20 text-lg font-semibold">
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
                  <th className="px-3 py-2 normal-case">
                    <abbr title={t('insights.cols.alphaTitle')} className="no-underline">
                      α
                    </abbr>
                  </th>
                  <th className="px-3 py-2 normal-case">
                    <abbr title={t('insights.cols.betaTitle')} className="no-underline">
                      β
                    </abbr>
                  </th>
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
