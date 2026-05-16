import { useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Wrench } from 'lucide-react';
import { useSkills, useReloadSkills } from '@/api/queries';
import { Skeleton } from '@/components/ui/skeleton';
import { EmptyState } from '@/components/ui/empty-state';
import { ErrorBanner } from '@/components/ui/error-banner';

type SourceFilter = 'all' | 'seed' | 'project' | 'user' | 'plugin';

function sourceBucket(source: string): Exclude<SourceFilter, 'all'> {
  if (source.startsWith('plugin:')) return 'plugin';
  if (source === 'project' || source === 'user' || source === 'seed') return source;
  return 'seed';
}

function sourceBadgeClasses(source: string): string {
  // Tailwind palette per origin so a glance at the page reveals provenance.
  if (source === 'seed') return 'bg-sky-500/15 text-sky-700 dark:text-sky-300';
  if (source === 'project') return 'bg-emerald-500/15 text-emerald-700 dark:text-emerald-300';
  if (source === 'user') return 'bg-amber-500/15 text-amber-800 dark:text-amber-300';
  return 'bg-fuchsia-500/15 text-fuchsia-700 dark:text-fuchsia-300';
}

export function SkillsRoute() {
  const { t } = useTranslation();
  const skillsQ = useSkills();
  const reload = useReloadSkills();
  const [filter, setFilter] = useState<SourceFilter>('all');

  const skills = useMemo(() => skillsQ.data ?? [], [skillsQ.data]);
  const counts = useMemo(() => {
    const c = { all: skills.length, seed: 0, project: 0, user: 0, plugin: 0 };
    for (const s of skills) c[sourceBucket(s.source)] += 1;
    return c;
  }, [skills]);
  const visible =
    filter === 'all' ? skills : skills.filter((s) => sourceBucket(s.source) === filter);

  if (skillsQ.isLoading) {
    return (
      <div className="space-y-4">
        <header>
          <h1 className="text-2xl font-semibold tracking-tight">{t('skills.title')}</h1>
          <p className="mt-1 text-sm text-muted-foreground">{t('skills.loading')}</p>
        </header>
        <ul className="grid grid-cols-1 gap-3 md:grid-cols-2">
          {Array.from({ length: 4 }).map((_, i) => (
            <li key={i} className="space-y-3 rounded-md border border-border bg-card p-4">
              <Skeleton className="h-5 w-1/3" />
              <Skeleton className="h-4 w-4/5" />
              <Skeleton className="h-4 w-2/3" />
            </li>
          ))}
        </ul>
      </div>
    );
  }
  if (skillsQ.error) {
    return (
      <div className="space-y-4">
        <header>
          <h1 className="text-2xl font-semibold tracking-tight">{t('skills.title')}</h1>
        </header>
        <ErrorBanner
          title={t('skills.loadFailed')}
          message={t('errors.retryHint')}
          onRetry={() => skillsQ.refetch()}
        />
      </div>
    );
  }

  return (
    <div className="space-y-4">
      <header className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h1 className="text-2xl font-semibold tracking-tight">{t('skills.title')}</h1>
          <p className="mt-1 text-sm text-muted-foreground">
            {t('skills.subtitle', { count: skills.length })}
          </p>
        </div>
        <button
          onClick={() => reload.mutate()}
          disabled={reload.isPending}
          className="rounded-md border border-border bg-card px-3 py-1.5 text-sm hover:bg-accent disabled:cursor-not-allowed disabled:opacity-50"
        >
          {reload.isPending ? t('skills.reloading') : t('skills.reload')}
        </button>
      </header>

      <div className="flex flex-wrap gap-1.5 text-xs" role="tablist" aria-label={t('skills.title')}>
        {(['all', 'seed', 'project', 'user', 'plugin'] as SourceFilter[]).map((key) => {
          const isActive = filter === key;
          return (
            <button
              key={key}
              role="tab"
              aria-selected={isActive}
              tabIndex={isActive ? 0 : -1}
              data-filter={key}
              onClick={() => setFilter(key)}
              onKeyDown={(e) => {
                if (e.key !== 'ArrowRight' && e.key !== 'ArrowLeft') return;
                e.preventDefault();
                const dir = e.key === 'ArrowRight' ? 1 : -1;
                const filtered: SourceFilter[] = ['all', 'seed', 'project', 'user', 'plugin'];
                const idx = filtered.indexOf(filter);
                const nextKey = filtered[(idx + dir + filtered.length) % filtered.length]!;
                setFilter(nextKey);
                requestAnimationFrame(() => {
                  document
                    .querySelector<HTMLElement>(`[role="tab"][data-filter="${nextKey}"]`)
                    ?.focus();
                });
              }}
              className={
                'rounded-md border px-2.5 py-1 transition ' +
                (isActive
                  ? 'border-foreground bg-foreground text-background'
                  : 'border-border bg-card hover:bg-accent')
              }
            >
              {t(`skills.filter.${key}`)} <span className="ml-1 opacity-60">{counts[key]}</span>
            </button>
          );
        })}
      </div>

      {visible.length === 0 ? (
        <EmptyState
          icon={<Wrench className="h-6 w-6" />}
          title={t('skills.emptyTitle')}
          description={
            skills.length === 0 ? t('skills.emptyDescription') : t('skills.emptyDescription')
          }
        />
      ) : (
        <ul className="grid grid-cols-1 gap-3 md:grid-cols-2">
          {visible.map((s) => (
            <li
              key={`${s.source}::${s.name}`}
              className="rounded-md border border-border bg-card p-4 transition-shadow hover:shadow-sm"
            >
              <div className="flex items-start justify-between gap-2">
                <h3 className="font-mono text-base font-semibold">{s.name}</h3>
                <div className="flex shrink-0 items-center gap-1.5">
                  <span
                    className={`rounded px-2 py-0.5 text-xs font-medium ${sourceBadgeClasses(s.source)}`}
                  >
                    {t(`skills.filter.${sourceBucket(s.source)}`)}
                  </span>
                  <span className="rounded bg-secondary px-2 py-0.5 text-xs font-medium uppercase text-secondary-foreground">
                    {s.model}
                  </span>
                </div>
              </div>
              <p className="mt-2 text-sm text-muted-foreground">{s.description}</p>
              {s.argumentHint && (
                <p className="mt-2 font-mono text-xs text-muted-foreground">
                  args: {s.argumentHint}
                </p>
              )}
              {s.allowedTools.length > 0 ? (
                <div className="mt-3 flex flex-wrap gap-1">
                  {s.allowedTools.map((tool) => (
                    <span
                      key={tool}
                      className="rounded border border-border px-1.5 py-0.5 font-mono text-xs"
                    >
                      {tool}
                    </span>
                  ))}
                </div>
              ) : (
                <p className="mt-3 font-mono text-xs italic text-muted-foreground-soft">
                  {t('skills.noTools')}
                </p>
              )}
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
