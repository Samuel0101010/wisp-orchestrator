import { useTranslation } from 'react-i18next';
import { Database } from 'lucide-react';
import { usePromptBundles, useDeletePromptBundle } from '@/api/queries';
import { Skeleton } from '@/components/ui/skeleton';
import { EmptyState } from '@/components/ui/empty-state';
import { ErrorBanner } from '@/components/ui/error-banner';

export function PromptBundlesRoute() {
  const { t } = useTranslation();
  const q = usePromptBundles();
  const del = useDeletePromptBundle();

  if (q.isLoading) {
    return (
      <div className="space-y-4">
        <header>
          <h1 className="text-2xl font-semibold">{t('promptBundles.title')}</h1>
          <p className="mt-1 text-sm text-muted-foreground">{t('promptBundles.loading')}</p>
        </header>
        <div className="space-y-2 rounded-md border border-border p-4">
          {Array.from({ length: 4 }).map((_, i) => (
            <Skeleton key={i} className="h-5 w-full" />
          ))}
        </div>
      </div>
    );
  }
  if (q.error) {
    return (
      <div className="space-y-4">
        <header>
          <h1 className="text-2xl font-semibold">{t('promptBundles.title')}</h1>
        </header>
        <ErrorBanner
          title={t('promptBundles.loadFailed')}
          message={t('errors.retryHint')}
          onRetry={() => q.refetch()}
        />
      </div>
    );
  }
  const rows = q.data ?? [];

  return (
    <div className="space-y-4">
      <header>
        <h1 className="text-2xl font-semibold">{t('promptBundles.title')}</h1>
        <p className="mt-1 text-sm text-muted-foreground">
          {t('promptBundles.subtitle', { count: rows.length })}
        </p>
        <p className="mt-1 max-w-2xl text-xs text-muted-foreground/80">
          {t('promptBundles.explanation')}
        </p>
      </header>
      {rows.length === 0 ? (
        <EmptyState
          icon={<Database className="h-6 w-6" />}
          title={t('promptBundles.emptyTitle')}
          description={t('promptBundles.emptyDescription')}
        />
      ) : (
        <div className="overflow-x-auto rounded-md border border-border">
          <table className="w-full min-w-[720px] text-sm">
            <thead className="bg-muted/40 text-left text-xs uppercase tracking-wide text-muted-foreground">
              <tr>
                <th className="px-3 py-2">{t('promptBundles.cols.bundleKey')}</th>
                <th className="px-3 py-2">{t('promptBundles.cols.model')}</th>
                <th className="px-3 py-2">{t('promptBundles.cols.session')}</th>
                <th className="px-3 py-2">{t('promptBundles.cols.hits')}</th>
                <th className="px-3 py-2">{t('promptBundles.cols.lastUsed')}</th>
                <th className="px-3 py-2" />
              </tr>
            </thead>
            <tbody>
              {rows.map((r) => (
                <tr
                  key={r.bundleKey}
                  className="border-t border-border transition-colors hover:bg-accent/30"
                >
                  <td className="px-3 py-2 font-mono text-xs">{r.bundleKey.slice(0, 12)}…</td>
                  <td className="px-3 py-2 font-mono uppercase">{r.model}</td>
                  <td className="px-3 py-2 font-mono text-xs text-muted-foreground">
                    {r.claudeSessionId ? r.claudeSessionId.slice(0, 12) + '…' : '—'}
                  </td>
                  <td className="px-3 py-2 tabular-nums">{r.hitCount}</td>
                  <td className="px-3 py-2 text-xs text-muted-foreground">
                    {new Date(r.lastUsedAt).toLocaleString()}
                  </td>
                  <td className="px-3 py-2 text-right">
                    <button
                      onClick={() => del.mutate(r.bundleKey)}
                      disabled={del.isPending && del.variables === r.bundleKey}
                      className="rounded-md border border-destructive/40 px-2.5 py-1 text-xs font-medium text-destructive transition-colors hover:bg-destructive/10 disabled:cursor-not-allowed disabled:opacity-50"
                    >
                      {del.isPending && del.variables === r.bundleKey
                        ? t('promptBundles.actions.resetting')
                        : t('promptBundles.actions.reset')}
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}
