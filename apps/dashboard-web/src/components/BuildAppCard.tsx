/**
 * BuildAppCard — Phase 7 (v1.15) settings-tab card that triggers the native
 * packager and surfaces the resulting installer.
 *
 * The button is disabled until:
 *   - the project has packageTarget != 'web'
 *   - at least one run on the project has outcome=success
 *   - no pending change-requests remain (resolve those in iteration first)
 *   - no build is currently in flight
 *
 * On success the download button appears with the installer basename + a
 * short sha256 prefix. Failures with a known PackagerError code render a
 * localized hint (e.g. "Tauri CLI missing — pnpm add -g @tauri-apps/cli").
 */

import { type ReactElement, useMemo } from 'react';
import { useTranslation } from 'react-i18next';
import { Download, Hammer, PackageOpen } from 'lucide-react';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { toast } from '@/components/ui/use-toast';
import { ApiError } from '@/api/client';
import {
  useBuildStatus,
  useChangeRequests,
  useDownloadArtifact,
  useProjectRuns,
  useStartBuild,
  type PackagerError,
  type PackageTarget,
} from '@/api/queries';

interface BuildAppCardProps {
  projectId: string;
  packageTarget: PackageTarget;
}

function formatBytes(n: number | null | undefined): string {
  if (!n || n <= 0) return '—';
  const units = ['B', 'KB', 'MB', 'GB'];
  let value = n;
  let unit = 0;
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024;
    unit += 1;
  }
  return `${value.toFixed(unit === 0 ? 0 : 1)} ${units[unit]}`;
}

function basenameOf(p: string | null | undefined): string {
  if (!p) return '—';
  const idx = Math.max(p.lastIndexOf('/'), p.lastIndexOf('\\'));
  return idx >= 0 ? p.slice(idx + 1) : p;
}

export function BuildAppCard({ projectId, packageTarget }: BuildAppCardProps): ReactElement {
  const { t } = useTranslation();
  const buildStatus = useBuildStatus(projectId);
  const changeRequests = useChangeRequests(projectId, 'pending');
  const projectRuns = useProjectRuns(projectId);
  const startBuild = useStartBuild(projectId);
  const downloadArtifact = useDownloadArtifact(projectId);

  const hasSuccess = useMemo(
    () => (projectRuns.data ?? []).some((r) => r.outcome === 'success'),
    [projectRuns.data],
  );
  const pendingCount = changeRequests.data?.length ?? 0;
  const recent = buildStatus.data?.recentBuild ?? null;
  const artifactPath = buildStatus.data?.artifactPath ?? null;

  if (packageTarget === 'web') {
    return (
      <Card data-testid="build-app-card">
        <CardHeader className="flex flex-row items-center gap-2 space-y-0 pb-2">
          <PackageOpen className="h-4 w-4 text-muted-foreground" />
          <div className="flex flex-col gap-0.5">
            <CardTitle className="text-sm font-medium">{t('buildApp.title')}</CardTitle>
            <CardDescription className="text-2xs">{t('buildApp.disabledHint')}</CardDescription>
          </div>
        </CardHeader>
        <CardContent>
          <p className="text-xs text-muted-foreground" data-testid="build-status">
            {t('buildApp.status.web')}
          </p>
        </CardContent>
      </Card>
    );
  }

  let disabledReason: string | null = null;
  if (!hasSuccess) disabledReason = t('buildApp.disabled.noSuccess');
  else if (pendingCount > 0)
    disabledReason = t('buildApp.disabled.pending', { count: pendingCount });
  else if (startBuild.isPending) disabledReason = t('buildApp.actions.building');

  const handleBuild = async (): Promise<void> => {
    try {
      const result = await startBuild.mutateAsync();
      // A non-ok HTTP response throws from apiFetch and lands in catch; a
      // resolved promise means the build succeeded.
      if (result.ok) toast({ title: t('buildApp.toasts.success') });
    } catch (err) {
      // The server returns the typed code in the error BODY (ApiError.body),
      // not in the message — read it there. A known PackagerError gets a
      // localized hint; route-level rejections (409/400) carry a human-readable
      // message; otherwise fall back to the generic build-failed copy.
      const known: PackagerError[] = [
        'tauri_cli_missing',
        'rust_toolchain_missing',
        'web_build_failed',
        'tauri_build_failed',
        'artifact_not_found',
        'unsupported_target',
      ];
      const body =
        err instanceof ApiError && err.body && typeof err.body === 'object'
          ? (err.body as { error?: string; message?: string })
          : null;
      const code = body?.error;
      const description =
        code && (known as string[]).includes(code)
          ? t(`buildApp.errors.${code}`)
          : (body?.message ?? t('buildApp.errors.tauri_build_failed'));
      toast({
        title: t('buildApp.toasts.failed'),
        description,
        variant: 'destructive',
      });
    }
  };

  const statusKey = artifactPath
    ? 'built'
    : startBuild.isPending
      ? 'building'
      : disabledReason
        ? 'notReady'
        : 'ready';

  const sha = recent?.sha256 ?? null;
  const shaShort = sha ? sha.slice(0, 8) : null;

  return (
    <Card data-testid="build-app-card">
      <CardHeader className="flex flex-row items-center justify-between space-y-0 pb-2">
        <div className="flex flex-col gap-0.5">
          <CardTitle className="flex items-center gap-2 text-sm font-medium">
            <Hammer className="h-4 w-4 text-muted-foreground" />
            {t('buildApp.title')}
          </CardTitle>
          <CardDescription className="text-2xs">{t('buildApp.description')}</CardDescription>
        </div>
        <Button
          type="button"
          size="sm"
          onClick={() => void handleBuild()}
          disabled={disabledReason !== null}
          title={disabledReason ?? undefined}
          data-testid="build-app-button"
        >
          {startBuild.isPending ? t('buildApp.actions.building') : t('buildApp.actions.build')}
        </Button>
      </CardHeader>
      <CardContent className="flex flex-col gap-3">
        <div className="flex items-center gap-2 text-xs">
          <Badge variant="outline" data-testid="build-status">
            {t(`buildApp.status.${statusKey}`)}
          </Badge>
          {disabledReason && (
            <span className="text-muted-foreground" data-testid="build-error">
              {disabledReason}
            </span>
          )}
        </div>
        {artifactPath && (
          <div className="flex flex-wrap items-center gap-2 text-xs">
            <span className="font-mono" title={artifactPath}>
              {basenameOf(artifactPath)}
            </span>
            {recent?.sizeBytes != null && (
              <span className="text-muted-foreground">{formatBytes(recent.sizeBytes)}</span>
            )}
            {shaShort && (
              <span className="font-mono text-muted-foreground" title={sha ?? undefined}>
                {shaShort}
              </span>
            )}
            <Button
              type="button"
              size="sm"
              variant="outline"
              onClick={() => downloadArtifact()}
              data-testid="build-app-download"
            >
              <Download className="mr-1 h-3 w-3" />
              {t('buildApp.actions.download')}
            </Button>
          </div>
        )}
        {recent && !recent.ok && recent.error && (
          <p className="text-xs text-destructive" data-testid="build-error">
            {t(`buildApp.errors.${recent.error}`)}
          </p>
        )}
      </CardContent>
    </Card>
  );
}
