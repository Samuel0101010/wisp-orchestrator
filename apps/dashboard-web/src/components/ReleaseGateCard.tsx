import { useTranslation } from 'react-i18next';
import { CheckCircle2, XCircle, AlertCircle, FileText } from 'lucide-react';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { useRuntimeReport, type RuntimeReportVerdict } from '@/api/queries';

/**
 * Release-gate summary for a single run. Renders the persisted
 * runtime_reports row: boot/E2E/DoD counts, verdict badge, and the agent's
 * runtime-report.md inline (if produced).
 *
 * Hides itself when no row exists — the runtime-verifier hasn't run yet
 * (or wasn't part of the plan, or runtime-verify was disabled on this
 * project). Polls every 5s while the run is active.
 */
export function ReleaseGateCard({ runId }: { runId: string }) {
  const { t } = useTranslation();
  const report = useRuntimeReport(runId);

  if (!report.data) return null;

  const r = report.data;
  const tone = toneForVerdict(r.verdict);
  const VerdictIcon =
    tone === 'success' ? CheckCircle2 : tone === 'destructive' ? XCircle : AlertCircle;
  const verdictColorClass =
    tone === 'success'
      ? 'border-emerald-500/40 bg-emerald-500/10 text-emerald-700 dark:text-emerald-300'
      : tone === 'destructive'
        ? 'border-destructive/50 bg-destructive/10 text-destructive'
        : 'border-amber-500/40 bg-amber-500/10 text-amber-700 dark:text-amber-300';

  return (
    <Card data-testid="release-gate-card">
      <CardHeader className="space-y-2 pb-3">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <CardTitle className="flex items-center gap-2 text-sm font-medium">
            <FileText className="h-4 w-4 text-muted-foreground" />
            {t('releaseGate.title')}
          </CardTitle>
          <div
            className={`flex items-center gap-1.5 rounded-full border px-2.5 py-0.5 text-xs font-semibold ${verdictColorClass}`}
            data-testid={`release-gate-verdict-${r.verdict}`}
          >
            <VerdictIcon className="h-3.5 w-3.5" />
            {t(`releaseGate.verdict.${r.verdict}` as const)}
          </div>
        </div>
        <div className="flex flex-wrap gap-2 text-xs">
          <Badge variant={r.bootOk ? 'default' : 'destructive'} className="text-2xs">
            {t('releaseGate.boot')}: {r.bootOk ? t('releaseGate.pass') : t('releaseGate.fail')}
          </Badge>
          <Badge variant={r.e2eOk ? 'default' : 'destructive'} className="text-2xs">
            {t('releaseGate.e2e')}: {r.e2eOk ? t('releaseGate.pass') : t('releaseGate.fail')}
          </Badge>
          {r.dodTotal > 0 && (
            <Badge variant="secondary" className="text-2xs">
              {t('releaseGate.dod')}: {r.dodPassed}/{r.dodTotal}
            </Badge>
          )}
          {r.evidenceJson?.artifacts && r.evidenceJson.artifacts.length > 0 && (
            <Badge variant="outline" className="text-2xs">
              {t('releaseGate.artifacts', { count: r.evidenceJson.artifacts.length })}
            </Badge>
          )}
        </div>
      </CardHeader>
      {r.reportMd && (
        <CardContent>
          <details className="text-xs">
            <summary className="cursor-pointer text-muted-foreground hover:text-foreground">
              {t('releaseGate.showReport')}
            </summary>
            <pre className="mt-2 max-h-96 overflow-auto whitespace-pre-wrap rounded-md border border-border bg-muted/30 p-3 font-mono">
              {r.reportMd}
            </pre>
          </details>
        </CardContent>
      )}
    </Card>
  );
}

function toneForVerdict(v: RuntimeReportVerdict): 'success' | 'destructive' | 'warning' {
  switch (v) {
    case 'pass':
      return 'success';
    case 'fail':
    case 'error':
      return 'destructive';
    case 'skipped':
      return 'warning';
  }
}
