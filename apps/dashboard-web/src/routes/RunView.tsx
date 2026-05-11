import { useEffect, useMemo, useRef, useState } from 'react';
import { Link, useNavigate, useParams } from 'react-router-dom';
import { Pause, Play, Square, Activity, FileText, AlertTriangle, Coins } from 'lucide-react';
import type { HarnessEvent, RunPausedReason, TaskRole } from '@agent-harness/schemas';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { toast } from '@/components/ui/use-toast';
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip';
import { useRunEvents } from '@/api/ws';
import { useTranslation } from 'react-i18next';
import { BackToProject } from '@/components/BackToProject';
import {
  useCancelRun,
  usePauseRun,
  useResumeRun,
  useRun,
  useStartRun,
  type RunSnapshotResponse,
} from '@/api/queries';
import {
  columnFor,
  computeAggregates,
  useRunStore,
  type TaskCardModel,
  type TaskColumn,
} from '@/store/run';
import { PlanVersionBadge } from '@/components/PlanVersionBadge';
import { AutopilotToggle } from '@/components/AutopilotToggle';
import type { TFunction } from 'i18next';
import { statusLabel } from '@/lib/status-labels';

const COLUMN_ORDER: TaskColumn[] = ['pending', 'running', 'verifying', 'done', 'failed'];

const ROLE_STRIPE: Record<TaskRole, string> = {
  architect: 'bg-violet-500',
  developer: 'bg-sky-500',
  qa: 'bg-emerald-500',
};

function formatCompactNumber(n: number): string {
  if (n < 1000) return String(n);
  if (n < 10_000) return `${(n / 1000).toFixed(1)}k`;
  if (n < 1_000_000) return `${Math.round(n / 1000)}k`;
  return `${(n / 1_000_000).toFixed(1)}M`;
}

function formatDuration(ms: number): string {
  const totalSec = Math.floor(ms / 1000);
  const h = Math.floor(totalSec / 3600);
  const m = Math.floor((totalSec % 3600) / 60);
  const s = totalSec % 60;
  if (h > 0) return `${h}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`;
  return `${m}:${String(s).padStart(2, '0')}`;
}

function progressColor(percent: number): string {
  if (percent >= 100) return 'bg-destructive';
  if (percent >= 80) return 'bg-amber-500';
  return 'bg-primary';
}

interface ResourceBarProps {
  percentTime: number;
  percentTurns: number;
  elapsedMs: number;
  budgetMs: number;
  turnsTotal: number;
  budgetTurns: number;
  runningCount: number;
  maxParallel: number;
  tokensIn: number;
  tokensOut: number;
}

function ResourceBar(props: ResourceBarProps) {
  const {
    percentTime,
    percentTurns,
    elapsedMs,
    budgetMs,
    turnsTotal,
    budgetTurns,
    runningCount,
    maxParallel,
    tokensIn,
    tokensOut,
  } = props;
  const { t } = useTranslation();
  return (
    <div
      className="grid grid-cols-1 gap-3 rounded-md border bg-card p-3 md:grid-cols-4"
      data-testid="resource-bar"
    >
      <div className="flex flex-col gap-1">
        <div className="flex items-center justify-between text-xs">
          <span className="text-muted-foreground">{t('runView.resourceBar.time')}</span>
          <span
            className="tabular-nums text-foreground"
            data-testid="resource-time"
          >{`${formatDuration(elapsedMs)} / ${formatDuration(budgetMs)}`}</span>
        </div>
        <div className="relative h-2 w-full overflow-hidden rounded-full bg-secondary">
          <div
            className={`h-full transition-all ${progressColor(percentTime)}`}
            style={{ width: `${Math.min(100, percentTime)}%` }}
          />
        </div>
      </div>
      <div className="flex flex-col gap-1">
        <div className="flex items-center justify-between text-xs">
          <span className="text-muted-foreground">{t('runView.resourceBar.turns')}</span>
          <span
            className="tabular-nums text-foreground"
            data-testid="resource-turns"
          >{`${turnsTotal} / ${budgetTurns}`}</span>
        </div>
        <div className="relative h-2 w-full overflow-hidden rounded-full bg-secondary">
          <div
            className={`h-full transition-all ${progressColor(percentTurns)}`}
            style={{ width: `${Math.min(100, percentTurns)}%` }}
          />
        </div>
      </div>
      <div className="flex flex-col gap-1">
        <div className="flex items-center justify-between text-xs">
          <span className="text-muted-foreground">{t('runView.resourceBar.pool')}</span>
          <span className="tabular-nums">{`${runningCount} / ${maxParallel}`}</span>
        </div>
        <div className="flex gap-1" aria-label="pool-meter">
          {Array.from({ length: Math.max(maxParallel, 1) }).map((_, i) => (
            <span
              key={i}
              className={
                'h-2 flex-1 rounded-full ' + (i < runningCount ? 'bg-primary' : 'bg-secondary')
              }
            />
          ))}
        </div>
      </div>
      <div className="flex items-center justify-end gap-2 text-xs text-muted-foreground">
        <Coins className="h-3 w-3" />
        <span className="tabular-nums" data-testid="resource-tokens">
          {t('runView.resourceBar.tokensInOut', {
            in: formatCompactNumber(tokensIn),
            out: formatCompactNumber(tokensOut),
          })}
        </span>
      </div>
    </div>
  );
}

interface CountdownProps {
  resumeAt: number | null;
  nowMs: number;
}

function Countdown({ resumeAt, nowMs }: CountdownProps) {
  const { t } = useTranslation();
  if (resumeAt == null) return <span>—</span>;
  const remainingMs = Math.max(0, resumeAt - nowMs);
  if (remainingMs <= 0)
    return (
      <span data-testid="countdown-elapsed" className="font-mono">
        {t('runView.controls.probingResume')}
      </span>
    );
  const totalSec = Math.floor(remainingMs / 1000);
  const h = Math.floor(totalSec / 3600);
  const m = Math.floor((totalSec % 3600) / 60);
  const s = totalSec % 60;
  return (
    <span data-testid="countdown" className="font-mono tabular-nums">
      {String(h).padStart(2, '0')}:{String(m).padStart(2, '0')}:{String(s).padStart(2, '0')}
    </span>
  );
}

interface TaskCardProps {
  task: TaskCardModel;
  budgetTurns: number;
  nowMs: number;
  onOpenTail: () => void;
}

function TaskCard({ task, budgetTurns, nowMs, onOpenTail }: TaskCardProps) {
  const { t } = useTranslation();
  const liveDuration = task.liveRunning && task.startedAtMs ? nowMs - task.startedAtMs : 0;
  const duration = Math.max(task.durationMs, liveDuration);
  return (
    <div
      className="relative flex flex-col gap-2 overflow-hidden rounded-md border bg-card p-3"
      data-testid={`task-card-${task.id}`}
      data-status={task.status}
    >
      <div className={`absolute left-0 top-0 h-full w-1 ${ROLE_STRIPE[task.role]}`} aria-hidden />
      <div className="flex items-center justify-between pl-2">
        <div className="flex flex-col">
          <span className="text-sm font-medium">{task.title}</span>
          <span className="text-xs text-muted-foreground">{task.id}</span>
        </div>
        <Badge variant="outline" className="text-[10px] uppercase">
          {task.role}
        </Badge>
      </div>
      <div className="grid grid-cols-3 gap-2 pl-2 text-xs text-muted-foreground tabular-nums">
        <div>
          <div className="text-[10px] uppercase">{t('runView.task.tokens')}</div>
          <div data-testid={`task-tokens-${task.id}`}>
            {formatCompactNumber(task.tokensIn)} / {formatCompactNumber(task.tokensOut)}
          </div>
        </div>
        <div>
          <div className="text-[10px] uppercase">{t('runView.task.turns')}</div>
          <div data-testid={`task-turns-${task.id}`}>
            {task.turnsUsed}
            {budgetTurns > 0 ? ` / ${budgetTurns}` : ''}
          </div>
        </div>
        <div>
          <div className="text-[10px] uppercase">{t('runView.task.duration')}</div>
          <div data-testid={`task-duration-${task.id}`}>{formatDuration(duration)}</div>
        </div>
      </div>
      {task.error && (
        <div className="rounded-sm border border-destructive/40 bg-destructive/10 p-2 pl-3 text-xs text-destructive">
          <div className="font-semibold">{t('runView.task.failed')}</div>
          <div className="line-clamp-3">{task.error}</div>
          {task.worktreePath && (
            <div className="mt-1 text-[10px] text-destructive/80">
              {t('runView.task.forensics', { path: task.worktreePath })}
            </div>
          )}
        </div>
      )}
      <div className="flex items-center justify-between pl-2">
        <Button
          variant="ghost"
          size="sm"
          className="h-7 px-2 text-xs"
          onClick={onOpenTail}
          data-testid={`task-tail-button-${task.id}`}
        >
          <FileText className="mr-1 h-3 w-3" />
          {t('runView.task.liveTail')}
        </Button>
      </div>
    </div>
  );
}

interface LiveTailSheetProps {
  task: TaskCardModel | null;
  onClose: () => void;
}

function LiveTailSheet({ task, onClose }: LiveTailSheetProps) {
  const { t } = useTranslation();
  const [pinTop, setPinTop] = useState(false);
  const scrollerRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    if (!task || pinTop) return;
    const el = scrollerRef.current;
    if (!el) return;
    el.scrollTop = el.scrollHeight;
  }, [task, task?.deltas.length, pinTop]);

  return (
    <Dialog open={!!task} onOpenChange={(open) => (!open ? onClose() : undefined)}>
      <DialogContent
        className="max-w-2xl"
        data-testid={task ? `task-tail-${task.id}` : 'task-tail'}
      >
        <DialogHeader>
          <DialogTitle>{t('runView.task.liveTailFor', { title: task?.title ?? '' })}</DialogTitle>
          <DialogDescription>
            {t('runView.task.tailHint', { count: task?.deltas.length ?? 0 })}
          </DialogDescription>
        </DialogHeader>
        <div className="flex items-center justify-end gap-2">
          <label className="flex items-center gap-1 text-xs">
            <input type="checkbox" checked={pinTop} onChange={(e) => setPinTop(e.target.checked)} />
            {t('runView.task.pinScroll')}
          </label>
        </div>
        <div
          ref={scrollerRef}
          className="h-72 overflow-auto rounded-md border bg-muted p-2 font-mono text-xs"
          data-testid="task-tail-scroller"
        >
          {task?.deltas.length === 0 ? (
            <div className="text-muted-foreground">{t('runView.task.noOutput')}</div>
          ) : (
            task?.deltas.map((d, i) => (
              <div key={i} className="whitespace-pre-wrap">
                {d}
              </div>
            ))
          )}
        </div>
      </DialogContent>
    </Dialog>
  );
}

interface RunHeaderActionsProps {
  runId: string;
  planId: string;
  projectId: string;
  status: string;
  pausedReason: string | null;
  resumeAt: number | null;
  nowMs: number;
  onAfterAction: () => void;
}

function RunHeaderActions({
  runId,
  planId,
  projectId,
  status,
  pausedReason,
  resumeAt,
  nowMs,
  onAfterAction,
}: RunHeaderActionsProps) {
  const { t } = useTranslation();
  const pause = usePauseRun(runId);
  const resume = useResumeRun(runId);
  const cancel = useCancelRun(runId);
  const startRun = useStartRun();
  const navigate = useNavigate();
  const [confirmCancel, setConfirmCancel] = useState(false);

  const isTerminal = status === 'completed' || status === 'failed' || status === 'cancelled';

  const handleRunAgain = async (): Promise<void> => {
    try {
      const result = await startRun.mutateAsync({ planId });
      toast({
        title: t('projectDetail.toasts.runStarted'),
        description: result.runId.slice(0, 8),
      });
      navigate(`/projects/${projectId}/run/${result.runId}`);
    } catch (err) {
      toast({
        title: t('projectDetail.toasts.runStartFailed'),
        description: (err as Error).message,
        variant: 'destructive',
      });
    }
  };

  const resumeBlocked = pausedReason === 'rate-limit' && resumeAt != null && resumeAt > nowMs;

  const handlePause = async (): Promise<void> => {
    try {
      await pause.mutateAsync();
      toast({ title: t('runView.toasts.paused') });
      onAfterAction();
    } catch (err) {
      toast({
        title: t('runView.toasts.pauseFailed'),
        description: (err as Error).message,
        variant: 'destructive',
      });
    }
  };

  const handleResume = async (): Promise<void> => {
    try {
      await resume.mutateAsync();
      toast({ title: t('runView.toasts.resumed') });
      onAfterAction();
    } catch (err) {
      toast({
        title: t('runView.toasts.resumeFailed'),
        description: (err as Error).message,
        variant: 'destructive',
      });
    }
  };

  const handleCancel = async (): Promise<void> => {
    setConfirmCancel(false);
    try {
      await cancel.mutateAsync();
      toast({ title: t('runView.toasts.cancelled') });
      onAfterAction();
    } catch (err) {
      toast({
        title: t('runView.toasts.cancelFailed'),
        description: (err as Error).message,
        variant: 'destructive',
      });
    }
  };

  return (
    <div className="flex items-center gap-2">
      {isTerminal && (
        <Button
          size="sm"
          variant="default"
          onClick={() => void handleRunAgain()}
          disabled={startRun.isPending}
          data-testid="run-again-button"
        >
          <Play className="mr-2 h-4 w-4" />
          {startRun.isPending
            ? t('projectDetail.actions.starting')
            : t('projectDetail.actions.newRun')}
        </Button>
      )}
      {status === 'running' && (
        <Tooltip>
          <TooltipTrigger asChild>
            <Button
              size="sm"
              variant="outline"
              onClick={() => void handlePause()}
              disabled={pause.isPending}
              data-testid="run-pause-button"
            >
              <Pause className="mr-2 h-4 w-4" />
              {t('runView.controls.pause')}
            </Button>
          </TooltipTrigger>
          <TooltipContent>{t('tooltips.pauseRun')}</TooltipContent>
        </Tooltip>
      )}
      {status === 'paused' && (
        <Tooltip>
          <TooltipTrigger asChild>
            <Button
              size="sm"
              variant="default"
              onClick={() => void handleResume()}
              disabled={resume.isPending || resumeBlocked}
              data-testid="run-resume-button"
            >
              <Play className="mr-2 h-4 w-4" />
              {t('runView.controls.resume')}
            </Button>
          </TooltipTrigger>
          <TooltipContent>{t('tooltips.resumeRun')}</TooltipContent>
        </Tooltip>
      )}
      <Tooltip>
        <TooltipTrigger asChild>
          <Button
            size="sm"
            variant="destructive"
            onClick={() => setConfirmCancel(true)}
            disabled={status === 'completed' || status === 'cancelled' || status === 'failed'}
            data-testid="run-cancel-button"
          >
            <Square className="mr-2 h-4 w-4" />
            {t('runView.controls.cancel')}
          </Button>
        </TooltipTrigger>
        <TooltipContent>{t('tooltips.cancelRun')}</TooltipContent>
      </Tooltip>
      <Dialog open={confirmCancel} onOpenChange={setConfirmCancel}>
        <DialogContent data-testid="run-cancel-dialog">
          <DialogHeader>
            <DialogTitle>{t('runView.cancelDialog.title')}</DialogTitle>
            <DialogDescription>
              {t('runView.cancelDialog.description')}
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button variant="outline" onClick={() => setConfirmCancel(false)}>
              {t('runView.cancelDialog.keepRunning')}
            </Button>
            <Button variant="destructive" onClick={() => void handleCancel()}>
              {t('runView.cancelDialog.cancelRun')}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}

interface RunPausedBannerProps {
  runId: string;
  pausedReason: RunPausedReason;
  resumeAt: number | null;
  nowMs: number;
}

function RunPausedBanner({ runId, pausedReason, resumeAt, nowMs }: RunPausedBannerProps) {
  const { t } = useTranslation();
  const resume = useResumeRun(runId);
  const handleResumeNow = async (): Promise<void> => {
    try {
      await resume.mutateAsync();
      toast({ title: t('runView.toasts.resumed') });
    } catch (err) {
      toast({
        title: t('runView.toasts.resumeFailed'),
        description: (err as Error).message,
        variant: 'destructive',
      });
    }
  };
  if (pausedReason === 'rate-limit') {
    return (
      <div
        className="flex items-center justify-between gap-3 rounded-md border border-amber-500/40 bg-amber-500/10 p-3 text-sm text-amber-700 dark:text-amber-300"
        data-testid="rate-limit-banner"
      >
        <div className="flex items-center gap-2">
          <AlertTriangle className="h-4 w-4" />
          <span>
            {t('runView.controls.quotaExhaustedPrefix')}{' '}
            <Countdown resumeAt={resumeAt} nowMs={nowMs} />
          </span>
        </div>
        <Tooltip>
          <TooltipTrigger asChild>
            <Button
              size="sm"
              variant="outline"
              onClick={() => void handleResumeNow()}
              disabled={resume.isPending}
              data-testid="rate-limit-resume-now"
            >
              {t('runView.controls.resumeNow')}
            </Button>
          </TooltipTrigger>
          <TooltipContent>{t('tooltips.resumeRun')}</TooltipContent>
        </Tooltip>
      </div>
    );
  }
  return (
    <div
      className="flex items-center justify-between gap-3 rounded-md border bg-muted p-3 text-sm"
      data-testid="user-paused-banner"
    >
      <div className="flex items-center gap-2">
        <Pause className="h-4 w-4" />
        <span>{t('runView.controls.pausedByUser')}</span>
      </div>
      <Tooltip>
        <TooltipTrigger asChild>
          <Button
            size="sm"
            variant="outline"
            onClick={() => void handleResumeNow()}
            disabled={resume.isPending}
            data-testid="user-paused-resume"
          >
            {t('runView.controls.resume')}
          </Button>
        </TooltipTrigger>
        <TooltipContent>{t('tooltips.resumeRun')}</TooltipContent>
      </Tooltip>
    </div>
  );
}

interface KanbanProps {
  tasks: TaskCardModel[];
  budgetTurns: number;
  nowMs: number;
  onOpenTail: (taskId: string) => void;
}

function Kanban({ tasks, budgetTurns, nowMs, onOpenTail }: KanbanProps) {
  const { t } = useTranslation();
  const columns = useMemo(() => {
    const buckets: Record<TaskColumn, TaskCardModel[]> = {
      pending: [],
      running: [],
      verifying: [],
      done: [],
      failed: [],
    };
    for (const task of tasks) buckets[columnFor(task)].push(task);
    return buckets;
  }, [tasks]);

  return (
    <div className="grid flex-1 grid-cols-1 gap-3 overflow-hidden md:grid-cols-5">
      {COLUMN_ORDER.map((col) => (
        <div
          key={col}
          className="flex h-full flex-col overflow-hidden rounded-md border bg-card"
          data-testid={`kanban-column-${col}`}
        >
          <div className="flex items-center justify-between border-b px-3 py-2">
            <span className="text-xs font-semibold uppercase tracking-wide">
              {t(`runView.kanban.${col}`)}
            </span>
            <Badge variant="secondary" className="text-[10px]">
              {columns[col].length}
            </Badge>
          </div>
          <div className="flex flex-col gap-2 overflow-y-auto p-2">
            {columns[col].map((task) => (
              <TaskCard
                key={task.id}
                task={task}
                budgetTurns={budgetTurns}
                nowMs={nowMs}
                onOpenTail={() => onOpenTail(task.id)}
              />
            ))}
            {columns[col].length === 0 && (
              <div className="px-2 py-3 text-center text-xs text-muted-foreground">
                {t('runView.kanban.empty')}
              </div>
            )}
          </div>
        </div>
      ))}
    </div>
  );
}

function statusBadgeVariant(status: string): 'default' | 'secondary' | 'destructive' | 'outline' {
  switch (status) {
    case 'running':
      return 'default';
    case 'paused':
      return 'secondary';
    case 'completed':
      return 'outline';
    case 'failed':
    case 'cancelled':
      return 'destructive';
    default:
      return 'secondary';
  }
}

interface RunViewBodyProps {
  runId: string;
  projectId: string | undefined;
  snapshot: RunSnapshotResponse;
  refetch: () => void;
}

function RunViewBody({ runId, projectId, snapshot, refetch }: RunViewBodyProps) {
  const { t } = useTranslation();
  const hydrate = useRunStore((s) => s.hydrate);
  const applyEvent = useRunStore((s) => s.applyEvent);
  const tickClock = useRunStore((s) => s.tickClock);
  const reset = useRunStore((s) => s.reset);
  const run = useRunStore((s) => s.run);
  const tasks = useRunStore((s) => s.tasks);
  const taskOrder = useRunStore((s) => s.taskOrder);
  const nowMs = useRunStore((s) => s.nowMs);
  const aggregates = useMemo(() => computeAggregates({ tasks, run, nowMs }), [tasks, run, nowMs]);
  const { events, status: wsStatus } = useRunEvents(runId);
  const lastAppliedRef = useRef(0);
  const [tailTaskId, setTailTaskId] = useState<string | null>(null);

  // Hydrate from the snapshot whenever it changes (initial + 5s refetch fallback).
  useEffect(() => {
    hydrate({ run: snapshot.run, tasks: snapshot.tasks });
    lastAppliedRef.current = 0;
    return () => {
      reset(null);
    };
  }, [snapshot.run.id, snapshot.run, snapshot.tasks, hydrate, reset]);

  // Apply newly-arrived events incrementally.
  useEffect(() => {
    if (events.length <= lastAppliedRef.current) return;
    for (let i = lastAppliedRef.current; i < events.length; i += 1) {
      const ev = events[i];
      if (ev) {
        applyEvent(ev);
        toastForEvent(ev, t);
      }
    }
    lastAppliedRef.current = events.length;
  }, [events, applyEvent, t]);

  // Tick once per second so durations and the rate-limit countdown advance.
  useEffect(() => {
    const id = setInterval(() => tickClock(), 1000);
    return () => clearInterval(id);
  }, [tickClock]);

  const orderedTasks = useMemo(
    () => taskOrder.map((id) => tasks[id]).filter((t): t is TaskCardModel => Boolean(t)),
    [taskOrder, tasks],
  );

  const tailTask = tailTaskId ? (tasks[tailTaskId] ?? null) : null;

  if (!run) return null;

  const budgetMs = run.budgetMinutes * 60_000;

  return (
    <div className="flex h-[calc(100vh-7rem)] flex-col gap-3" data-testid="run-view">
      <BackToProject />
      <div className="flex items-center justify-between gap-3 rounded-md border bg-card p-3">
        <div className="flex items-center gap-3">
          {projectId && (
            <Link
              to={`/projects/${projectId}/plan`}
              className="text-xs text-muted-foreground hover:underline"
            >
              {t('runView.backToPlan')}
            </Link>
          )}
          <h1 className="text-lg font-semibold">{t('runView.runPrefix', { id: run.id.slice(0, 8) })}</h1>
          <Badge variant={statusBadgeVariant(run.status)} data-testid="run-status">
            {statusLabel(run.status, t)}
            {run.outcome ? ` (${statusLabel(run.outcome, t)})` : ''}
          </Badge>
          {snapshot.run.errorReason === 'max_turns' && (
            <span
              className="rounded bg-amber-500/20 px-2 py-0.5 text-xs font-medium text-amber-700 dark:text-amber-400"
              data-testid="max-turns-badge"
            >
              {t('runView.maxTurnsRetry', {
                count: snapshot.run.retryCount,
                next: snapshot.run.nextRetryAt
                  ? t('runView.maxTurnsNext', {
                      time: new Date(snapshot.run.nextRetryAt).toLocaleTimeString(),
                    })
                  : '',
              })}
            </span>
          )}
          <PlanVersionBadge planId={run.planId} />
          {wsStatus !== 'open' && (
            <Badge
              variant="outline"
              className="flex items-center gap-1 text-[10px]"
              data-testid="ws-status-pill"
            >
              <Activity className="h-3 w-3" />
              {wsStatus === 'closed' || wsStatus === 'error'
                ? t('runView.reconnecting')
                : wsStatus}
            </Badge>
          )}
        </div>
        <RunHeaderActions
          runId={run.id}
          planId={run.planId}
          projectId={projectId ?? ''}
          status={run.status}
          pausedReason={run.pausedReason}
          resumeAt={run.resumeAt}
          nowMs={nowMs}
          onAfterAction={refetch}
        />
      </div>

      <ResourceBar
        percentTime={aggregates.percentTime}
        percentTurns={aggregates.percentTurns}
        elapsedMs={aggregates.elapsedMs}
        budgetMs={budgetMs}
        turnsTotal={aggregates.turnsTotal}
        budgetTurns={run.budgetTurns}
        runningCount={aggregates.runningCount}
        maxParallel={run.maxParallel}
        tokensIn={aggregates.tokensInTotal}
        tokensOut={aggregates.tokensOutTotal}
      />

      {run.status === 'paused' && run.pausedReason && (
        <RunPausedBanner
          runId={run.id}
          pausedReason={run.pausedReason}
          resumeAt={run.resumeAt}
          nowMs={nowMs}
        />
      )}

      <AutopilotToggle
        runId={run.id}
        initialEnabled={Boolean(snapshot.run.autopilotMode)}
        initialBudgetMinutes={snapshot.run.autopilotBudgetMinutes ?? null}
        initialBudgetTokens={snapshot.run.autopilotBudgetTokens ?? null}
      />

      <Kanban
        tasks={orderedTasks}
        budgetTurns={run.budgetTurns}
        nowMs={nowMs}
        onOpenTail={(id) => setTailTaskId(id)}
      />

      <LiveTailSheet task={tailTask} onClose={() => setTailTaskId(null)} />
    </div>
  );
}

function toastForEvent(ev: HarnessEvent, t: TFunction): void {
  if (ev.type === 'resource.warning') {
    toast({
      title: t('runView.toasts.budgetWarning', {
        percent: Math.round(ev.payload.percent),
        kind: ev.payload.kind,
      }),
      description: t('runView.toasts.budgetWarningDesc'),
    });
  } else if (ev.type === 'resource.exceeded') {
    toast({
      title: t('runView.toasts.budgetExceeded', { kind: ev.payload.kind }),
      description: t('runView.toasts.budgetExceededDesc'),
      variant: 'destructive',
    });
  } else if (ev.type === 'rate-limit.hit') {
    toast({
      title: t('runView.toasts.rateLimitHit'),
      description: ev.payload.source,
      variant: 'destructive',
    });
  }
}

export function RunView() {
  const { runId, projectId } = useParams<{ runId?: string; projectId?: string }>();
  const navigate = useNavigate();
  const { t } = useTranslation();
  const runQuery = useRun(runId);

  if (!runId) {
    return (
      <Card>
        <CardHeader>
          <CardTitle>{t('runView.title')}</CardTitle>
          <CardDescription>{t('runView.noRunId')}</CardDescription>
        </CardHeader>
      </Card>
    );
  }

  if (runQuery.isLoading) {
    return (
      <div className="flex h-[calc(100vh-7rem)] flex-col gap-3">
        <div className="rounded-md border bg-card p-3">
          <div className="h-5 w-40 animate-pulse rounded bg-muted" />
        </div>
        <div className="flex-1 animate-pulse rounded-md border bg-card" data-testid="run-loading" />
      </div>
    );
  }

  if (runQuery.isError) {
    const message =
      runQuery.error instanceof Error ? runQuery.error.message : String(runQuery.error);
    return (
      <Card data-testid="run-error">
        <CardHeader>
          <CardTitle>{t('runView.loadFailed')}</CardTitle>
          <CardDescription>{t('runView.loadFailedBody')}</CardDescription>
        </CardHeader>
        <CardContent className="flex flex-col gap-3">
          <pre className="overflow-x-auto rounded-md bg-muted p-3 text-xs">{message}</pre>
          <div className="flex gap-2">
            <Button onClick={() => void runQuery.refetch()}>{t('buttons.retry')}</Button>
            <Button variant="outline" onClick={() => navigate(-1)}>
              {t('buttons.back')}
            </Button>
          </div>
        </CardContent>
      </Card>
    );
  }

  if (!runQuery.data) {
    return (
      <Card data-testid="run-not-found">
        <CardHeader>
          <CardTitle>{t('runView.notFound')}</CardTitle>
          <CardDescription>{t('runView.notFoundDesc')}</CardDescription>
        </CardHeader>
        <CardContent>
          <Button variant="outline" onClick={() => navigate(-1)}>
            {t('buttons.back')}
          </Button>
        </CardContent>
      </Card>
    );
  }

  return (
    <RunViewBody
      runId={runId}
      projectId={projectId}
      snapshot={runQuery.data}
      refetch={() => void runQuery.refetch()}
    />
  );
}
