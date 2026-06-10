import { useEffect, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import { Globe, ListChecks, MousePointerSquareDashed, Play, Trash2 } from 'lucide-react';
import {
  useChangeRequests,
  useCreateChangeRequest,
  useDeleteChangeRequest,
  useRunIteration,
  type ChangeRequestRow,
} from '@/api/queries';
import { ApiError } from '@/api/client';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { dismissToast, toast } from '@/components/ui/use-toast';

interface PendingChangesPanelProps {
  projectId: string;
}

/**
 * Renders the project's `pending` change-request queue plus the "Run
 * Iteration" CTA that consumes it. Visible regardless of preview-server
 * state so the user can curate the queue even when the dev server is
 * stopped. Free-form text entries live alongside visual picks; the source
 * icon discriminates them in the list.
 */
export function PendingChangesPanel({ projectId }: PendingChangesPanelProps) {
  const { t } = useTranslation();
  const navigate = useNavigate();
  const { data } = useChangeRequests(projectId, 'pending');
  const rows: ChangeRequestRow[] = data ?? [];
  const create = useCreateChangeRequest(projectId);
  const del = useDeleteChangeRequest(projectId);
  const runIteration = useRunIteration(projectId);
  const [textPrompt, setTextPrompt] = useState('');
  const [iterationStartedAt, setIterationStartedAt] = useState<number | null>(null);
  const [iterationElapsedSec, setIterationElapsedSec] = useState(0);

  // Tick a one-second timer while the iteration mutation is in flight so the
  // button label shows elapsed seconds (plan regeneration runs an LLM and can
  // take 1–3 minutes).
  useEffect(() => {
    if (iterationStartedAt === null) {
      setIterationElapsedSec(0);
      return;
    }
    setIterationElapsedSec(Math.floor((Date.now() - iterationStartedAt) / 1000));
    const handle = setInterval(() => {
      setIterationElapsedSec(Math.floor((Date.now() - iterationStartedAt) / 1000));
    }, 1000);
    return () => {
      clearInterval(handle);
    };
  }, [iterationStartedAt]);

  const handleAddText = async (): Promise<void> => {
    const trimmed = textPrompt.trim();
    if (trimmed.length === 0) return;
    try {
      await create.mutateAsync({ source: 'text', userPrompt: trimmed });
      setTextPrompt('');
      toast({ title: t('preview.toasts.added') });
    } catch (err) {
      toast({
        title: t('preview.toasts.addFailed'),
        description: (err as Error).message,
        variant: 'destructive',
      });
    }
  };

  const handleDelete = async (id: string): Promise<void> => {
    try {
      await del.mutateAsync(id);
      toast({ title: t('preview.toasts.deleted') });
    } catch (err) {
      toast({
        title: t('preview.toasts.deleteFailed'),
        description: (err as Error).message,
        variant: 'destructive',
      });
    }
  };

  const handleRunIteration = async (): Promise<void> => {
    if (rows.length === 0) return;
    const ids = rows.map((r) => r.id);
    // Fire the long-lived "preparing" toast IMMEDIATELY on click — the
    // plan-regeneration LLM call below blocks for 1–3 minutes without any
    // other UI feedback. The toast is dismissed when the mutation settles.
    const preparingToastId = toast({
      title: t('preview.toasts.iterationPreparing'),
      description: t('preview.toasts.iterationPreparingDescription'),
      duration: 180000,
    });
    setIterationStartedAt(Date.now());
    try {
      const result = await runIteration.mutateAsync({ changeRequestIds: ids });
      dismissToast(preparingToastId);
      toast({ title: t('preview.toasts.iterationStarted') });
      navigate(`/projects/${projectId}/run/${result.runId}`);
    } catch (err) {
      dismissToast(preparingToastId);
      // 502 run_start_failed: the plan was created but the run didn't start —
      // the change requests stay queued, so tell the user nothing was lost.
      // 409 run_already_active: another run is in flight for this project —
      // wait for it, then retry (the queue is preserved here too).
      const errorCode =
        err instanceof ApiError
          ? (err.body as { error?: string } | null | undefined)?.error
          : undefined;
      let description: string;
      if (errorCode === 'run_already_active') {
        description = t('preview.toasts.iterationRunAlreadyActive');
      } else if (errorCode === 'run_start_failed') {
        description = t('preview.toasts.iterationRunStartFailed');
      } else {
        description = (err as Error).message;
      }
      toast({
        title: t('preview.toasts.iterationFailed'),
        description,
        variant: 'destructive',
      });
    } finally {
      setIterationStartedAt(null);
    }
  };

  return (
    <Card data-testid="pending-changes-panel">
      <CardHeader className="pb-3">
        <CardTitle className="flex items-center gap-2 text-sm font-medium">
          <ListChecks className="h-4 w-4 text-muted-foreground" />
          {t('preview.changes.title')}
          <span
            className="rounded-full bg-muted px-2 py-0.5 text-xs text-muted-foreground"
            data-testid="pending-changes-count"
          >
            {rows.length}
          </span>
        </CardTitle>
        <CardDescription className="text-xs">{t('preview.changes.pending')}</CardDescription>
      </CardHeader>
      <CardContent className="flex flex-col gap-3">
        <div className="flex flex-col gap-2 rounded-md border border-dashed border-border p-2">
          <textarea
            data-testid="text-mode-textarea"
            value={textPrompt}
            onChange={(e) => setTextPrompt(e.target.value)}
            placeholder={t('preview.changes.textPlaceholder') ?? ''}
            rows={2}
            className="w-full resize-none rounded border border-border bg-background p-2 text-xs"
          />
          <div className="flex justify-end">
            <Button
              type="button"
              size="sm"
              variant="outline"
              onClick={() => void handleAddText()}
              disabled={textPrompt.trim().length === 0 || create.isPending}
              data-testid="text-mode-submit"
            >
              {t('preview.changes.textAdd')}
            </Button>
          </div>
        </div>
        {rows.length === 0 ? (
          <p
            className="py-4 text-center text-xs text-muted-foreground"
            data-testid="pending-changes-empty"
          >
            {t('preview.edit.queueEmpty')}
          </p>
        ) : (
          <ul className="flex flex-col divide-y divide-border rounded-md border border-border">
            {rows.map((row) => (
              <li
                key={row.id}
                data-testid={`pending-row-${row.id}`}
                className="flex items-start gap-2 p-2 text-xs"
              >
                <span className="mt-0.5 text-muted-foreground" title={row.source}>
                  {row.source === 'visual' ? (
                    <MousePointerSquareDashed className="h-3 w-3" />
                  ) : (
                    <Globe className="h-3 w-3" />
                  )}
                </span>
                <div className="flex min-w-0 flex-1 flex-col">
                  <span className="line-clamp-2 break-words text-foreground">{row.userPrompt}</span>
                  {row.selector ? (
                    <code
                      className="truncate font-mono text-xs text-muted-foreground"
                      title={row.selector}
                    >
                      {row.selector}
                    </code>
                  ) : null}
                </div>
                <Button
                  type="button"
                  size="sm"
                  variant="ghost"
                  onClick={() => void handleDelete(row.id)}
                  disabled={del.isPending}
                  data-testid={`pending-delete-${row.id}`}
                  aria-label={t('preview.changes.delete') ?? 'Delete'}
                >
                  <Trash2 className="h-3 w-3" />
                </Button>
              </li>
            ))}
          </ul>
        )}
        <div className="flex justify-end">
          <Button
            type="button"
            size="sm"
            onClick={() => void handleRunIteration()}
            disabled={rows.length === 0 || runIteration.isPending}
            data-testid="run-iteration-button"
          >
            <Play className="mr-1 h-3 w-3" />
            {runIteration.isPending
              ? t('preview.changes.runIterationStartingSeconds', {
                  seconds: iterationElapsedSec,
                })
              : t('preview.changes.runIteration')}
          </Button>
        </div>
      </CardContent>
    </Card>
  );
}
