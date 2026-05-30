import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { Link, useNavigate, useParams } from 'react-router-dom';
import {
  Pause,
  Play,
  Square,
  Activity,
  FileText,
  AlertTriangle,
  Clock,
  ShieldCheck,
  CheckCircle2,
  XCircle,
  Ban,
} from 'lucide-react';
import { clsx } from 'clsx';
import type { HarnessEvent, RunPausedReason } from '@wisp/schemas';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { StatusPill, type StatusPillTone } from '@/components/ui/status-pill';
import { StatusDotBadge } from '@/components/StatusDotBadge';
import { EmptyState } from '@/components/ui/empty-state';
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
import { ReleaseGateCard } from '@/components/ReleaseGateCard';
import type { TFunction } from 'i18next';
import { statusLabel } from '@/lib/status-labels';
import { roleHsl } from '@/lib/role-color';

const COLUMN_ORDER: TaskColumn[] = [
  'pending',
  'running',
  'verifying',
  'done',
  'failed',
  'cancelled',
];

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

type ResourceTone = 'info' | 'warning' | 'success' | 'destructive';

function pickTone(percent: number, base: ResourceTone): ResourceTone {
  if (percent >= 100) return 'destructive';
  if (percent >= 80) return 'warning';
  return base;
}

interface ResourceSegmentProps {
  label: string;
  value: string;
  of: string;
  pct: number;
  tone: ResourceTone;
  testId?: string;
}

function ResourceSegment({ label, value, of, pct, tone, testId }: ResourceSegmentProps) {
  const fillTone =
    tone === 'destructive'
      ? 'bg-destructive'
      : tone === 'warning'
        ? 'bg-warning'
        : tone === 'success'
          ? 'bg-success'
          : 'bg-info';
  return (
    <div className="flex flex-col gap-1 px-4 py-2" data-testid={testId}>
      <span className="text-2xs uppercase tracking-widest text-muted-foreground">{label}</span>
      <div className="flex items-baseline gap-1.5">
        <span className="font-mono text-sm font-semibold tabular-nums">{value}</span>
        <span className="text-2xs text-muted-foreground tabular-nums">{`/ ${of}`}</span>
      </div>
      <div className="h-1 overflow-hidden rounded-full bg-muted/60">
        <div
          className={clsx('h-full rounded-full transition-all', fillTone)}
          style={{ width: `${Math.min(100, Math.max(0, pct * 100))}%` }}
        />
      </div>
    </div>
  );
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
  const poolPct = maxParallel > 0 ? runningCount / maxParallel : 0;
  return (
    <div data-testid="resource-bar">
      <div className="grid grid-cols-3 divide-x rounded-md border bg-card">
        <ResourceSegment
          label={t('runView.resourceBar.time')}
          value={formatDuration(elapsedMs)}
          of={formatDuration(budgetMs)}
          pct={percentTime / 100}
          tone={pickTone(percentTime, 'info')}
          testId="resource-time"
        />
        <ResourceSegment
          label={t('runView.resourceBar.turns')}
          value={String(turnsTotal)}
          of={String(budgetTurns)}
          pct={percentTurns / 100}
          tone={pickTone(percentTurns, 'info')}
          testId="resource-turns"
        />
        <ResourceSegment
          label={t('runView.resourceBar.pool')}
          value={String(runningCount)}
          of={String(maxParallel)}
          pct={poolPct}
          tone="success"
          testId="resource-pool"
        />
      </div>
      <div
        className="mt-1 flex justify-end gap-2 text-2xs text-muted-foreground"
        data-testid="resource-tokens"
      >
        <span className="font-mono tabular-nums">
          {t('runView.resourceBar.tokensIn', { in: formatCompactNumber(tokensIn) })}
        </span>
        <span aria-hidden>·</span>
        <span className="font-mono tabular-nums">
          {t('runView.resourceBar.tokensOut', { out: formatCompactNumber(tokensOut) })}
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
  const live = task.status === 'running';
  return (
    <div
      className={clsx(
        'group relative flex flex-col gap-2 overflow-hidden rounded-md border bg-card p-3',
        task.status === 'running' && 'ring-1 ring-info/40',
        task.status === 'failed' && 'ring-1 ring-destructive/40',
      )}
      data-testid={`task-card-${task.id}`}
      data-status={task.status}
    >
      <div className="flex items-center justify-between gap-2">
        <span className="inline-flex min-w-0 items-center gap-1.5">
          <span
            className="size-1.5 shrink-0 rounded-full"
            style={{ background: roleHsl(task.role) }}
            aria-hidden
          />
          <span className="truncate text-2xs font-medium uppercase tracking-wider text-muted-foreground">
            {task.role}
          </span>
        </span>
        {/* Inside a kanban column (~120 px content width), a full status pill
            with a translated label like "FEHLGESCHLAGEN" overflows and gets
            clipped to garbage like "FEHLGESC". The column header already
            carries the status name; here we just need an at-a-glance dot. */}
        <StatusDotBadge
          status={task.status}
          pulse={live}
          iconOnly
          aria-label={statusLabel(task.status, t)}
          className="shrink-0"
        />
      </div>
      <div className="flex flex-col">
        <span className="text-sm font-medium">{task.title}</span>
        <span className="text-xs text-muted-foreground">{task.id}</span>
      </div>
      {/* Metric rows. Stacked label-value pairs so they read cleanly in
          narrow kanban columns (~125px content width on 1440px viewports)
          where the earlier 3-column grid overlapped tags + values. */}
      <dl className="flex flex-col gap-0.5 text-xs text-muted-foreground tabular-nums">
        <div className="flex items-baseline justify-between gap-2">
          <dt className="text-2xs uppercase">{t('runView.task.tokens')}</dt>
          <dd className="font-mono" data-testid={`task-tokens-${task.id}`}>
            {formatCompactNumber(task.tokensIn)} / {formatCompactNumber(task.tokensOut)}
          </dd>
        </div>
        <div className="flex items-baseline justify-between gap-2">
          <dt className="text-2xs uppercase">{t('runView.task.turns')}</dt>
          <dd className="font-mono" data-testid={`task-turns-${task.id}`}>
            {task.turnsUsed}
            {budgetTurns > 0 ? ` / ${budgetTurns}` : ''}
          </dd>
        </div>
        <div className="flex items-baseline justify-between gap-2">
          <dt className="text-2xs uppercase">{t('runView.task.duration')}</dt>
          <dd className="font-mono" data-testid={`task-duration-${task.id}`}>
            {formatDuration(duration)}
          </dd>
        </div>
      </dl>
      {task.error && (
        <div className="rounded-sm border border-destructive/40 bg-destructive/10 p-2 text-xs text-destructive">
          <div className="font-semibold">{t('runView.task.failed')}</div>
          <div className="line-clamp-3">{task.error}</div>
          {task.worktreePath && (
            <div className="mt-1 text-2xs text-destructive/80">
              {t('runView.task.forensics', { path: task.worktreePath })}
            </div>
          )}
        </div>
      )}
      <div className="flex items-center justify-between">
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
            <DialogDescription>{t('runView.cancelDialog.description')}</DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button
              variant="outline"
              onClick={() => setConfirmCancel(false)}
              data-testid="run-cancel-cancel"
            >
              {t('runView.cancelDialog.keepRunning')}
            </Button>
            <Button
              variant="destructive"
              onClick={() => void handleCancel()}
              data-testid="run-cancel-confirm"
            >
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
  const isShutdown = pausedReason === 'shutdown';
  return (
    <div
      className="flex items-center justify-between gap-3 rounded-md border bg-muted p-3 text-sm"
      data-testid={isShutdown ? 'shutdown-paused-banner' : 'user-paused-banner'}
    >
      <div className="flex items-center gap-2">
        <Pause className="h-4 w-4" />
        <span>
          {isShutdown ? t('runView.controls.pausedByShutdown') : t('runView.controls.pausedByUser')}
        </span>
      </div>
      <Tooltip>
        <TooltipTrigger asChild>
          <Button
            size="sm"
            variant="outline"
            onClick={() => void handleResumeNow()}
            disabled={resume.isPending}
            data-testid={isShutdown ? 'shutdown-paused-resume' : 'user-paused-resume'}
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

const COLUMN_EMPTY_ICON: Record<TaskColumn, ReactNode> = {
  pending: <Clock />,
  running: <Activity />,
  verifying: <ShieldCheck />,
  done: <CheckCircle2 />,
  failed: <XCircle />,
  cancelled: <Ban />,
};

function Kanban({ tasks, budgetTurns, nowMs, onOpenTail }: KanbanProps) {
  const { t } = useTranslation();
  const columns = useMemo(() => {
    const buckets: Record<TaskColumn, TaskCardModel[]> = {
      pending: [],
      running: [],
      verifying: [],
      done: [],
      failed: [],
      cancelled: [],
    };
    for (const task of tasks) buckets[columnFor(task)].push(task);
    return buckets;
  }, [tasks]);

  return (
    <div className="grid flex-1 grid-cols-1 gap-3 overflow-hidden md:grid-cols-3 lg:grid-cols-6">
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
            <Badge variant="secondary" className="text-2xs">
              {columns[col].length}
            </Badge>
          </div>
          <div className="flex min-h-0 flex-1 flex-col gap-2 overflow-y-auto p-2">
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
              <EmptyState
                size="column"
                icon={COLUMN_EMPTY_ICON[col]}
                title={t(`runView.kanban.empty.${col}`)}
              />
            )}
          </div>
        </div>
      ))}
    </div>
  );
}

function runStatusTone(status: string): StatusPillTone {
  switch (status) {
    case 'running':
    case 'verifying':
      return 'info';
    case 'completed':
    case 'done':
    case 'success':
      return 'success';
    case 'failed':
      return 'destructive';
    case 'paused':
      return 'warning';
    case 'cancelled':
    case 'pending':
    case 'draft':
      return 'neutral';
    default:
      return 'neutral';
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

  // Initial hydrate — fires once per runId change. Without this guard the
  // 5s REST poll would re-hydrate over the WS-applied state on every tick,
  // causing visible flicker when an event lands between poll cycles.
  useEffect(() => {
    hydrate({ run: snapshot.run, tasks: snapshot.tasks });
    lastAppliedRef.current = 0;
    return () => {
      reset(null);
    };
    // Intentionally only re-firing on runId so the initial paint hydrates
    // once. The fallback re-hydrate below covers WS disconnects.
  }, [snapshot.run.id, hydrate, reset]);

  // Fallback: re-hydrate from the REST snapshot only while the WebSocket
  // is NOT open. Once WS is healthy the incremental event stream is the
  // source of truth and the 5s poll mustn't clobber it (F22 race).
  useEffect(() => {
    if (wsStatus === 'open') return;
    hydrate({ run: snapshot.run, tasks: snapshot.tasks });
    lastAppliedRef.current = 0;
  }, [snapshot.run, snapshot.tasks, hydrate, wsStatus]);

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
    <div className="flex min-h-[calc(100vh-7rem)] flex-col gap-3 pb-6" data-testid="run-view">
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
          <h1 className="text-lg font-semibold">
            {t('runView.runPrefix', { id: run.id.slice(0, 8) })}
          </h1>
          <span data-testid="run-status" className="inline-flex">
            <StatusPill
              variant="solid"
              tone={runStatusTone(run.status)}
              live={run.status === 'running'}
            >
              {statusLabel(run.status, t)}
              {/* Outcome echoes status verbatim for cancelled/failed runs.
                  Only show it when it adds new information. */}
              {run.outcome && run.outcome !== run.status ? ` (${statusLabel(run.outcome, t)})` : ''}
            </StatusPill>
          </span>
          {(snapshot.run.chainIteration ?? 0) > 0 && (
            <Link
              to={
                snapshot.run.parentRunId
                  ? `/projects/${projectId}/run/${snapshot.run.parentRunId}`
                  : '#'
              }
              className="inline-flex items-center gap-1 rounded-full border border-indigo-500/40 bg-indigo-500/10 px-2 py-0.5 text-xs font-medium text-indigo-700 hover:bg-indigo-500/20 dark:text-indigo-300"
              data-testid="chain-iteration-badge"
              title={t('projectDetail.productionMode.chainParent')}
            >
              <ShieldCheck className="h-3 w-3" />
              {t('projectDetail.productionMode.chainIterationShort', {
                current: snapshot.run.chainIteration,
              })}
            </Link>
          )}
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
              className="flex items-center gap-1 text-2xs"
              data-testid="ws-status-pill"
            >
              <Activity className="h-3 w-3" />
              {wsStatus === 'closed' || wsStatus === 'error' ? t('runView.reconnecting') : wsStatus}
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

      <ReleaseGateCard runId={run.id} runStatus={run.status} />

      {/* Indicator: autopilot is active AND the run is paused with an
          auto-resumable reason. Tells the user "the harness is watching
          this for you" so they don't have to click Resume themselves. */}
      {snapshot.run.autopilotMode &&
        run.status === 'paused' &&
        (run.pausedReason === 'rate-limit' || run.pausedReason === 'shutdown') && (
          <div
            className="flex items-center gap-2 rounded border border-emerald-500/40 bg-emerald-500/10 p-2 text-xs text-emerald-700 dark:text-emerald-300"
            data-testid="autopilot-watching"
          >
            <Activity className="h-3.5 w-3.5" />
            <span>
              {run.pausedReason === 'rate-limit' && run.resumeAt
                ? t('runView.autopilot.watching', {
                    at: new Date(run.resumeAt as unknown as string | number).toLocaleTimeString(),
                  })
                : t('runView.autopilot.watchingNoCountdown')}
            </span>
          </div>
        )}

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
