import { useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import {
  Edit3,
  Eye,
  Monitor,
  MousePointerSquareDashed,
  Play,
  RefreshCcw,
  Smartphone,
  Square,
  Tablet,
} from 'lucide-react';
import {
  useCreateChangeRequest,
  usePreviewStatus,
  useProjectRuns,
  useStartPreview,
  useStopPreview,
  type ChangeRequestRect,
  type PreviewStatusResponse,
} from '@/api/queries';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { StatusPill, type StatusPillTone } from '@/components/ui/status-pill';
import { toast } from '@/components/ui/use-toast';
import { ApiError } from '@/api/client';
import type { TFunction } from 'i18next';
import { INSPECTOR_SCRIPT } from './preview-inspector';
import { PendingChangesPanel } from './PendingChangesPanel';

/**
 * Turn a failed preview-start request into a plain-language message a
 * non-developer can act on, instead of the opaque "Request failed: 400". The
 * server's actionable `hint`/`detail` live in ApiError.body, which the old
 * `err.message`-only path discarded.
 */
function friendlyStartError(err: unknown, t: TFunction): { title: string; detail?: string } {
  if (err instanceof ApiError) {
    const body = (err.body ?? {}) as { error?: string; hint?: string; detail?: string };
    const code = body.error;
    const known = new Set(['no_dev_cmd', 'worktree_setup_failed', 'repo_not_initialized']);
    if (code && known.has(code)) {
      // The i18n message is a self-contained, plain-language instruction — we
      // deliberately drop the server's technical hint to avoid dev jargon.
      return { title: t(`preview.errors.${code}`) };
    }
    return { title: body.hint ?? body.error ?? err.message, detail: body.detail };
  }
  return { title: (err as Error).message };
}

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

interface SelectedElement {
  selector: string;
  rect: ChangeRequestRect;
  html: string;
}

/**
 * Per-project preview tab. Spawns the project's dev server inside the
 * harness, then frames it via the reverse-proxy at `/preview/:projectId/`.
 *
 * v1.12 adds visual-edit mode: a toggle that injects an inspector script
 * into the same-origin iframe; clicking an element captures its selector +
 * bounding rect and surfaces a side-panel where the user can author a
 * change-request that is appended to the project's queue.
 */
export function PreviewFrame({ projectId }: PreviewFrameProps) {
  const { t } = useTranslation();
  const status = usePreviewStatus(projectId);
  const start = useStartPreview(projectId);
  const stop = useStopPreview(projectId);
  const createChangeRequest = useCreateChangeRequest(projectId);
  const [viewport, setViewport] = useState<Viewport>('desktop');
  const [editMode, setEditMode] = useState(false);
  const [selectedElement, setSelectedElement] = useState<SelectedElement | null>(null);
  const [pendingPrompt, setPendingPrompt] = useState('');
  // A failed start REQUEST (400/500) — distinct from a dev-server runtime
  // error surfaced by the status poll. Rendered as a guided alert.
  const [startError, setStartError] = useState<{ title: string; detail?: string } | null>(null);
  const iframeRef = useRef<HTMLIFrameElement | null>(null);

  const state = resolveStatus(status.data);
  const tone = STATUS_TONE[state];
  const startedAt = status.data?.startedAt;
  const [now, setNow] = useState<number>(() => Date.now());

  // Tick a 1s clock only while we're in "starting". The counter sits under
  // the status pill so the user can see the spinner isn't frozen — useful
  // when the dev server takes the better part of the 30s ready window.
  useEffect(() => {
    if (state !== 'starting' || !startedAt) return;
    const id = setInterval(() => setNow(Date.now()), 1000);
    setNow(Date.now());
    return () => clearInterval(id);
  }, [state, startedAt]);

  const startingSeconds =
    state === 'starting' && startedAt ? Math.max(0, Math.floor((now - startedAt) / 1000)) : 0;
  const errorMessage = state === 'error' ? (status.data?.error ?? '') : '';

  // Listen for `harness:pick` messages from the inspector inside the iframe.
  useEffect(() => {
    const onMessage = (e: MessageEvent) => {
      // Strict origin check: the iframe is served by the dashboard via the
      // reverse proxy at /preview/<projectId>/, so it shares this window's
      // origin. Any message from a different origin is either a spoofing
      // attempt (a malicious iframe nested inside the user's preview) or a
      // bug — drop it either way. Without this guard, an arbitrary script
      // can send a crafted `harness:pick` with attacker-controlled
      // selector/html into the change-request flow.
      if (e.origin !== window.location.origin) return;
      const data = e.data as
        | { kind?: string; selector?: string; rect?: ChangeRequestRect; html?: string }
        | undefined;
      if (!data || data.kind !== 'harness:pick') return;
      if (!data.selector || !data.rect) return;
      setSelectedElement({
        selector: data.selector,
        rect: data.rect,
        html: data.html ?? '',
      });
    };
    window.addEventListener('message', onMessage);
    return () => window.removeEventListener('message', onMessage);
  }, []);

  // Tell the inspector to enable / disable edit mode and clear selection
  // when the user toggles off.
  useEffect(() => {
    const iframe = iframeRef.current;
    if (iframe?.contentWindow) {
      try {
        iframe.contentWindow.postMessage(
          { kind: 'harness:set-edit-mode', value: editMode },
          window.location.origin,
        );
      } catch {
        /* ignore — iframe may not be ready yet */
      }
    }
    if (!editMode) {
      setSelectedElement(null);
      setPendingPrompt('');
    }
  }, [editMode]);

  // Manual + auto-refresh path for the proxied preview iframe. Vite HMR's
  // WebSocket upgrade is not bridged through the dashboard's reverse-proxy
  // (yet), so the iframe never auto-reloads when source files change.
  // Cheapest replacement: a button + an effect that watches the most recent
  // run and reloads the iframe when an iteration finishes successfully.
  const reloadIframe = (): void => {
    const iframe = iframeRef.current;
    if (!iframe) return;
    try {
      // Re-assigning `src` is the most reliable way to force a reload of a
      // same-origin iframe across browsers (contentWindow.location.reload()
      // throws SecurityError if the doc isn't yet committed).
      // eslint-disable-next-line no-self-assign
      iframe.src = iframe.src;
    } catch {
      /* ignore — best-effort */
    }
  };

  const handleRefresh = (): void => {
    reloadIframe();
  };

  // Auto-refresh: when the most recent run for this project transitions from
  // 'running' → 'completed' with outcome 'success', reload the preview so the
  // user sees the iteration's output without manual intervention.
  const runsQuery = useProjectRuns(projectId);
  const previousRunStatusRef = useRef<string | null>(null);
  useEffect(() => {
    const rows = runsQuery.data;
    if (!rows || rows.length === 0) return;
    // Most-recent run is index 0 (server returns DESC by startedAt).
    const latest = rows[0];
    if (!latest) return;
    const prevStatus = previousRunStatusRef.current;
    previousRunStatusRef.current = latest.status;
    if (
      prevStatus === 'running' &&
      latest.status === 'completed' &&
      latest.outcome === 'success' &&
      state === 'running'
    ) {
      reloadIframe();
      toast({ title: t('preview.toasts.autoRefreshed'), duration: 3000 });
    }
  }, [runsQuery.data, state, t]);

  const handleStart = async (): Promise<void> => {
    setStartError(null);
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
      // Surface the server's actionable hint as a guided alert + toast, not the
      // opaque "Request failed: 400".
      const friendly = friendlyStartError(err, t);
      setStartError(friendly);
      toast({
        title: t('preview.toasts.startFailed'),
        description: friendly.title,
        variant: 'destructive',
      });
    }
  };

  const handleStop = async (): Promise<void> => {
    setStartError(null);
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

  const handleIframeLoad = (): void => {
    const iframe = iframeRef.current;
    const doc = iframe?.contentDocument;
    if (!doc || !doc.body) return;
    // Same-origin via the reverse-proxy: injecting a script tag into the
    // iframe body just works. The inspector script idempotently early-exits
    // on a re-injection.
    try {
      const script = doc.createElement('script');
      script.textContent = INSPECTOR_SCRIPT;
      doc.body.appendChild(script);
      // Re-broadcast the current edit-mode flag to a freshly-loaded frame.
      iframe?.contentWindow?.postMessage(
        { kind: 'harness:set-edit-mode', value: editMode },
        window.location.origin,
      );
    } catch {
      /* ignore — likely cross-origin in some edge configuration */
    }
  };

  const handleAddToQueue = async (): Promise<void> => {
    if (!selectedElement || pendingPrompt.trim().length === 0) return;
    try {
      await createChangeRequest.mutateAsync({
        source: 'visual',
        selector: selectedElement.selector,
        rectJson: selectedElement.rect,
        userPrompt: pendingPrompt.trim(),
      });
      toast({ title: t('preview.toasts.added') });
      setSelectedElement(null);
      setPendingPrompt('');
    } catch (err) {
      toast({
        title: t('preview.toasts.addFailed'),
        description: (err as Error).message,
        variant: 'destructive',
      });
    }
  };

  const running = state === 'running';
  const port = status.data?.port;

  return (
    <div className="flex flex-col gap-4">
      <Card data-testid="preview-frame">
        <CardHeader className="flex flex-row flex-wrap items-start justify-between gap-2 space-y-0 pb-3">
          <div className="flex flex-col gap-1">
            <CardTitle className="flex items-center gap-2 text-sm font-medium">
              <Eye className="h-4 w-4 text-muted-foreground" />
              {t('preview.title')}
              <StatusPill tone={tone} live={state === 'starting'}>
                <span data-testid="preview-status">{t(`preview.status.${state}`)}</span>
              </StatusPill>
              {state === 'starting' && startedAt ? (
                <span
                  data-testid="preview-starting-elapsed"
                  className="text-xs font-normal text-muted-foreground"
                >
                  {t('preview.startingFor', { seconds: startingSeconds })}
                </span>
              ) : null}
            </CardTitle>
            <CardDescription className="text-xs">{t('preview.description')}</CardDescription>
          </div>
          <div className="flex flex-wrap items-center justify-end gap-2">
            <Button
              type="button"
              size="sm"
              variant={editMode ? 'default' : 'outline'}
              onClick={() => setEditMode((v) => !v)}
              disabled={!running}
              data-testid="preview-edit-toggle"
              data-active={editMode}
              title={t('preview.edit.toggle')}
            >
              <Edit3 className="mr-1 h-3 w-3" />
              {t('preview.edit.toggle')}
            </Button>
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
              variant="outline"
              onClick={handleRefresh}
              disabled={!running}
              data-testid="preview-refresh"
              title={t('preview.refresh')}
            >
              <RefreshCcw className="mr-1 h-3 w-3" />
              {t('preview.refresh')}
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
          <div className="flex flex-col gap-4 lg:flex-row">
            <div className="flex flex-1 flex-col items-center justify-center gap-3 bg-muted/40 p-3">
              {running && port ? (
                <iframe
                  key={port}
                  ref={iframeRef}
                  data-testid="preview-iframe"
                  src={`/preview/${projectId}/`}
                  title={t('preview.title')}
                  sandbox="allow-scripts allow-forms allow-same-origin"
                  style={{ width: VIEWPORT_WIDTH[viewport], height: '600px' }}
                  className="rounded border border-border bg-background"
                  onLoad={handleIframeLoad}
                />
              ) : (
                <p
                  className="py-12 text-center text-sm text-muted-foreground"
                  data-testid="preview-empty"
                >
                  {t('preview.empty')}
                </p>
              )}
              {startError ? (
                <div
                  role="alert"
                  data-testid="preview-error-alert"
                  className="w-full max-w-2xl rounded-md border border-destructive/40 bg-destructive/10 px-3 py-2 text-xs text-destructive"
                >
                  <div className="font-medium">{startError.title}</div>
                  {startError.detail ? (
                    <div
                      data-testid="preview-error-message"
                      className="mt-0.5 break-words opacity-90"
                    >
                      {startError.detail}
                    </div>
                  ) : null}
                </div>
              ) : state === 'error' && errorMessage ? (
                <div
                  role="alert"
                  data-testid="preview-error-alert"
                  className="w-full max-w-2xl rounded-md border border-destructive/40 bg-destructive/10 px-3 py-2 text-xs text-destructive"
                >
                  <div className="font-medium">{t('preview.toasts.startFailed')}</div>
                  <div
                    data-testid="preview-error-message"
                    className="mt-0.5 break-words font-mono text-xs opacity-90"
                  >
                    {errorMessage}
                  </div>
                </div>
              ) : null}
            </div>
            {editMode && selectedElement ? (
              <aside
                data-testid="preview-selection"
                className="flex w-full max-w-sm flex-col gap-2 rounded-md border border-border bg-background p-3 text-xs lg:w-80"
              >
                <div className="flex items-center gap-2 text-muted-foreground">
                  <MousePointerSquareDashed className="h-3 w-3" />
                  <span>{t('preview.edit.selected')}</span>
                </div>
                <code
                  className="block truncate rounded bg-muted px-2 py-1 font-mono text-xs"
                  title={selectedElement.selector}
                >
                  {selectedElement.selector}
                </code>
                <span className="text-muted-foreground">
                  {Math.round(selectedElement.rect.width)}×{Math.round(selectedElement.rect.height)}
                  px
                </span>
                <textarea
                  data-testid="preview-prompt-textarea"
                  value={pendingPrompt}
                  onChange={(e) => setPendingPrompt(e.target.value)}
                  placeholder={t('preview.edit.promptPlaceholder') ?? ''}
                  rows={4}
                  className="w-full resize-none rounded border border-border bg-background p-2 text-xs"
                />
                <Button
                  type="button"
                  size="sm"
                  onClick={() => void handleAddToQueue()}
                  disabled={pendingPrompt.trim().length === 0 || createChangeRequest.isPending}
                  data-testid="preview-add-to-queue"
                >
                  {createChangeRequest.isPending
                    ? t('preview.edit.adding')
                    : t('preview.edit.addToQueue')}
                </Button>
              </aside>
            ) : null}
          </div>
        </CardContent>
      </Card>
      <PendingChangesPanel projectId={projectId} />
    </div>
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
