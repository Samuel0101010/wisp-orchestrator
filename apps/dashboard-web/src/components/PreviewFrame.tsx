import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Eye, Monitor, Play, Smartphone, Square, Tablet } from 'lucide-react';
import {
  usePreviewStatus,
  useStartPreview,
  useStopPreview,
  type PreviewStatusResponse,
} from '@/api/queries';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { StatusPill, type StatusPillTone } from '@/components/ui/status-pill';
import { toast } from '@/components/ui/use-toast';

interface PreviewFrameProps {
  projectId: string;
}

type Viewport = 'desktop' | 'tablet' | 'mobile';

const VIEWPORT_WIDTH: Record<Viewport, string> = {
  desktop: '100%',
  tablet: '768px',
  mobile: '375px',
};

function resolveStatus(
  status: PreviewStatusResponse | undefined,
): 'stopped' | 'starting' | 'running' | 'error' {
  if (!status) return 'stopped';
  if (status.running) return 'running';
  if (status.status === 'starting') return 'starting';
  if (status.status === 'error' || status.error) return 'error';
  return 'stopped';
}

const STATUS_TONE: Record<'stopped' | 'starting' | 'running' | 'error', StatusPillTone> = {
  stopped: 'neutral',
  starting: 'warning',
  running: 'success',
  error: 'destructive',
};

/**
 * Per-project preview tab. Spawns the project's dev server inside the
 * harness, then frames it via the reverse-proxy at `/preview/:projectId/`.
 *
 * Console-log streaming is intentionally out of scope for Phase 3 — only
 * status + start/stop + a viewport switcher.
 */
export function PreviewFrame({ projectId }: PreviewFrameProps) {
  const { t } = useTranslation();
  const status = usePreviewStatus(projectId);
  const start = useStartPreview(projectId);
  const stop = useStopPreview(projectId);
  const [viewport, setViewport] = useState<Viewport>('desktop');

  const state = resolveStatus(status.data);
  const tone = STATUS_TONE[state];

  const handleStart = async (): Promise<void> => {
    try {
      const res = await start.mutateAsync();
      if (res.status === 'error') {
        toast({
          title: t('preview.toasts.startFailed'),
          description: res.error ?? '',
          variant: 'destructive',
        });
      }
    } catch (err) {
      toast({
        title: t('preview.toasts.startFailed'),
        description: (err as Error).message,
        variant: 'destructive',
      });
    }
  };

  const handleStop = async (): Promise<void> => {
    try {
      await stop.mutateAsync();
    } catch (err) {
      toast({
        title: t('preview.toasts.stopFailed'),
        description: (err as Error).message,
        variant: 'destructive',
      });
    }
  };

  const running = state === 'running';
  const port = status.data?.port;

  return (
    <Card data-testid="preview-frame">
      <CardHeader className="flex flex-row items-start justify-between space-y-0 pb-3">
        <div className="flex flex-col gap-1">
          <CardTitle className="flex items-center gap-2 text-sm font-medium">
            <Eye className="h-4 w-4 text-muted-foreground" />
            {t('preview.title')}
            <StatusPill tone={tone} live={state === 'starting'}>
              <span data-testid="preview-status">{t(`preview.status.${state}`)}</span>
            </StatusPill>
          </CardTitle>
          <CardDescription className="text-xs">{t('preview.description')}</CardDescription>
        </div>
        <div className="flex items-center gap-2">
          <ViewportSwitcher selected={viewport} onSelect={setViewport} />
          <Button
            type="button"
            size="sm"
            variant="outline"
            onClick={() => void handleStart()}
            disabled={running || start.isPending}
            data-testid="preview-start"
          >
            <Play className="mr-1 h-3 w-3" />
            {t('preview.start')}
          </Button>
          <Button
            type="button"
            size="sm"
            variant="ghost"
            onClick={() => void handleStop()}
            disabled={!running || stop.isPending}
            data-testid="preview-stop"
          >
            <Square className="mr-1 h-3 w-3" />
            {t('preview.stop')}
          </Button>
        </div>
      </CardHeader>
      <CardContent>
        {running && port ? (
          <div className="flex justify-center bg-muted/40 p-3">
            <iframe
              key={port}
              data-testid="preview-iframe"
              src={`/preview/${projectId}/`}
              title={t('preview.title')}
              sandbox="allow-scripts allow-forms allow-same-origin"
              style={{ width: VIEWPORT_WIDTH[viewport], height: '600px' }}
              className="rounded border border-border bg-background"
            />
          </div>
        ) : (
          <p
            className="py-12 text-center text-sm text-muted-foreground"
            data-testid="preview-empty"
          >
            {t('preview.empty')}
          </p>
        )}
      </CardContent>
    </Card>
  );
}

interface ViewportSwitcherProps {
  selected: Viewport;
  onSelect: (v: Viewport) => void;
}

function ViewportSwitcher({ selected, onSelect }: ViewportSwitcherProps) {
  const { t } = useTranslation();
  return (
    <div className="flex items-center gap-1 rounded-md border border-border p-0.5">
      <ViewportButton
        viewport="desktop"
        selected={selected === 'desktop'}
        onClick={() => onSelect('desktop')}
        icon={<Monitor className="h-3.5 w-3.5" />}
        label={t('preview.viewport.desktop')}
        testid="preview-viewport-desktop"
      />
      <ViewportButton
        viewport="tablet"
        selected={selected === 'tablet'}
        onClick={() => onSelect('tablet')}
        icon={<Tablet className="h-3.5 w-3.5" />}
        label={t('preview.viewport.tablet')}
        testid="preview-viewport-tablet"
      />
      <ViewportButton
        viewport="mobile"
        selected={selected === 'mobile'}
        onClick={() => onSelect('mobile')}
        icon={<Smartphone className="h-3.5 w-3.5" />}
        label={t('preview.viewport.mobile')}
        testid="preview-viewport-mobile"
      />
    </div>
  );
}

interface ViewportButtonProps {
  viewport: Viewport;
  selected: boolean;
  onClick: () => void;
  icon: React.ReactNode;
  label: string;
  testid: string;
}

function ViewportButton({ selected, onClick, icon, label, testid }: ViewportButtonProps) {
  return (
    <button
      type="button"
      onClick={onClick}
      data-testid={testid}
      data-selected={selected}
      aria-pressed={selected}
      title={label}
      className={
        'inline-flex h-7 w-7 items-center justify-center rounded-sm transition-colors ' +
        (selected
          ? 'bg-background text-foreground shadow-sm'
          : 'text-muted-foreground hover:bg-muted/60')
      }
    >
      {icon}
      <span className="sr-only">{label}</span>
    </button>
  );
}
