import { useEffect, useMemo, useState, type ReactElement } from 'react';
import { useNavigate, useParams } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import { Pause, Play, Square, ChevronRight, MessageSquare } from 'lucide-react';
import {
  useCancelRun,
  usePauseRun,
  useProject,
  useProjectRuns,
  useProjects,
  useResumeRun,
  useRun,
  type ProjectRunRow,
} from '@/api/queries';
import { Button } from '@/components/ui/button';
import { PreviewFrame } from '@/components/PreviewFrame';
import { AgentChat } from '@/components/AgentChat';
import { useFocusStore } from '@/store/focus';

function fmtDuration(ms: number): string {
  if (!ms || !Number.isFinite(ms) || ms < 0) return '—';
  const mins = Math.floor(ms / 60_000);
  const secs = Math.floor((ms % 60_000) / 1000);
  if (mins === 0) return `${secs}s`;
  if (mins < 60) return `${mins}m ${secs}s`;
  return `${Math.floor(mins / 60)}h ${mins % 60}m`;
}

function fmtCompact(n: number | undefined | null): string {
  if (n == null || !Number.isFinite(n)) return '—';
  if (n < 1000) return String(n);
  if (n < 10_000) return `${(n / 1000).toFixed(1)}k`;
  if (n < 1_000_000) return `${Math.round(n / 1000)}k`;
  return `${(n / 1_000_000).toFixed(1)}M`;
}

interface KpiProps {
  label: string;
  value: string;
}

function Kpi({ label, value }: KpiProps): ReactElement {
  return (
    <div className="flex flex-col rounded-lg border bg-card/60 px-3 py-2">
      <div className="text-3xs uppercase tracking-wider text-muted-foreground">{label}</div>
      <div className="mt-1 text-lg font-semibold tabular-nums">{value}</div>
    </div>
  );
}

function runStatusTone(status: string | null | undefined): {
  bg: string;
  fg: string;
  label: string;
} {
  switch (status) {
    case 'running':
      return { bg: 'bg-emerald-500/10', fg: 'text-emerald-400', label: 'läuft' };
    case 'paused':
      return { bg: 'bg-amber-500/10', fg: 'text-amber-400', label: 'pausiert' };
    case 'failed':
      return { bg: 'bg-rose-500/10', fg: 'text-rose-400', label: 'fehlgeschlagen' };
    case 'completed':
      return { bg: 'bg-sky-500/10', fg: 'text-sky-400', label: 'fertig' };
    case 'cancelled':
      return { bg: 'bg-muted', fg: 'text-muted-foreground', label: 'abgebrochen' };
    default:
      return { bg: 'bg-muted', fg: 'text-muted-foreground', label: 'kein Run' };
  }
}

export function Focusboard(): ReactElement {
  const { t } = useTranslation();
  const params = useParams<{ projectId?: string }>();
  const navigate = useNavigate();
  const lastFocused = useFocusStore((s) => s.lastFocusedProjectId);
  const setLastFocused = useFocusStore((s) => s.setLastFocusedProjectId);

  const projects = useProjects();
  const projectId = params.projectId ?? lastFocused ?? projects.data?.[0]?.id ?? null;

  // Bounce to the resolved project so the URL becomes shareable.
  useEffect(() => {
    if (!params.projectId && projectId) {
      navigate(`/focus/${projectId}`, { replace: true });
    }
  }, [params.projectId, projectId, navigate]);

  // Persist the focused project for next session.
  useEffect(() => {
    if (projectId) setLastFocused(projectId);
  }, [projectId, setLastFocused]);

  const project = useProject(projectId ?? undefined);
  const runs = useProjectRuns(projectId ?? undefined);

  // The "active" run is the most-recent running or paused one; if none, the
  // most-recent completed run for context.
  const activeRun = useMemo<ProjectRunRow | null>(() => {
    const list = runs.data ?? [];
    return (
      list.find((r) => r.status === 'running') ??
      list.find((r) => r.status === 'paused') ??
      list[0] ??
      null
    );
  }, [runs.data]);

  const runDetail = useRun(activeRun?.id);
  const pauseRun = usePauseRun(activeRun?.id);
  const resumeRun = useResumeRun(activeRun?.id);
  const cancelRun = useCancelRun(activeRun?.id);

  const status = activeRun?.status ?? null;
  const tone = runStatusTone(status);

  // Live elapsed for running runs.
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (status !== 'running') return;
    // Sync the initial sample so the first paint isn't stuck on whatever
    // Date.now() returned at mount (for tabs left open across a status
    // transition, this could be hours ago).
    setNow(Date.now());
    const id = window.setInterval(() => setNow(Date.now()), 1000);
    return () => window.clearInterval(id);
  }, [status]);

  const startedAtMs = activeRun?.startedAt ? new Date(activeRun.startedAt).getTime() : null;
  const endedAtMs = activeRun?.endedAt ? new Date(activeRun.endedAt).getTime() : null;
  const elapsed =
    status === 'running' && startedAtMs
      ? now - startedAtMs
      : startedAtMs && endedAtMs
        ? endedAtMs - startedAtMs
        : 0;

  const tokensIn = runDetail.data?.run.tokensInTotal ?? activeRun?.tokensInTotal ?? 0;
  const tokensOut = runDetail.data?.run.tokensOutTotal ?? activeRun?.tokensOutTotal ?? 0;
  const turns = runDetail.data?.run.turnsTotal ?? activeRun?.turnsTotal ?? 0;
  const tasks = runDetail.data?.tasks ?? [];
  const tasksDone = tasks.filter((t) => t.status === 'done').length;
  const tasksFailed = tasks.filter((t) => t.status === 'failed').length;
  const tasksRunning = tasks.filter((t) => t.status === 'running').length;
  const tasksPending = tasks.length - tasksDone - tasksFailed - tasksRunning;

  if (!projects.data || projects.data.length === 0) {
    return (
      <div className="-m-6 flex h-[calc(100vh-4rem)] items-center justify-center p-12">
        <div className="max-w-md text-center">
          <div className="text-3xs uppercase tracking-wider text-muted-foreground">
            {t('focus.title', 'Focusboard')}
          </div>
          <div className="mt-2 text-xl font-semibold">
            {t('focus.noProjects', 'Noch keine Projekte')}
          </div>
          <div className="mt-2 text-sm text-muted-foreground">
            {t(
              'focus.noProjectsHint',
              'Erstelle ein Projekt über die Seitenleiste, dann kannst du es hier scharfschalten.',
            )}
          </div>
        </div>
      </div>
    );
  }

  if (!projectId || !project.data) {
    return (
      <div className="-m-6 flex h-[calc(100vh-4rem)] items-center justify-center p-12">
        <div className="text-sm text-muted-foreground">
          {project.isError
            ? t('focus.projectNotFound', 'Projekt nicht gefunden.')
            : t('focus.pickProject', 'Projekt wählen…')}
        </div>
      </div>
    );
  }

  return (
    <div className="-m-6 flex h-[calc(100vh-4rem)] flex-col">
      {/* Header bar */}
      <header className="flex shrink-0 items-center gap-3 border-b bg-card/40 px-4 py-2.5">
        <span className="text-3xs uppercase tracking-wider text-muted-foreground">
          {t('focus.title', 'Focusboard')}
        </span>
        <ChevronRight className="h-3.5 w-3.5 text-muted-foreground" />
        <select
          id="focus-project-select"
          name="focus-project-select"
          aria-label={t('focus.pickProject', 'Projekt wählen')}
          className="rounded-md border bg-card px-2 py-1 text-sm font-medium outline-none focus-visible:ring-2 focus-visible:ring-ring"
          value={projectId}
          onChange={(e) => navigate(`/focus/${e.target.value}`)}
        >
          {projects.data.map((p) => (
            <option key={p.id} value={p.id}>
              {p.name}
            </option>
          ))}
        </select>
        <span
          className={`inline-flex items-center gap-1.5 rounded-full px-2.5 py-0.5 text-3xs font-medium uppercase tracking-wider ${tone.bg} ${tone.fg}`}
        >
          <span className={`h-1.5 w-1.5 rounded-full ${tone.fg.replace('text-', 'bg-')}`} />
          {tone.label}
        </span>
        <span className="text-3xs tabular-nums text-muted-foreground">{fmtDuration(elapsed)}</span>
        <div className="flex-1" />
        <div className="flex items-center gap-1.5">
          {status === 'running' && (
            <Button
              size="sm"
              variant="secondary"
              onClick={() => pauseRun.mutate()}
              disabled={pauseRun.isPending}
            >
              <Pause className="mr-1.5 h-3.5 w-3.5" />
              {t('focus.actions.pause', 'Pausieren')}
            </Button>
          )}
          {status === 'paused' && (
            <Button size="sm" onClick={() => resumeRun.mutate()} disabled={resumeRun.isPending}>
              <Play className="mr-1.5 h-3.5 w-3.5" />
              {t('focus.actions.resume', 'Fortsetzen')}
            </Button>
          )}
          {(status === 'running' || status === 'paused') && (
            <Button
              size="sm"
              variant="ghost"
              onClick={() => cancelRun.mutate()}
              disabled={cancelRun.isPending}
            >
              <Square className="mr-1.5 h-3.5 w-3.5" />
              {t('focus.actions.cancel', 'Abbrechen')}
            </Button>
          )}
          <Button size="sm" variant="ghost" onClick={() => navigate(`/projects/${projectId}`)}>
            {t('focus.actions.openFullView', 'Volle Ansicht')}
          </Button>
        </div>
      </header>

      {/* Body */}
      <div className="flex min-h-0 flex-1">
        {/* Live run column */}
        <section className="flex w-[440px] shrink-0 flex-col gap-3 border-r p-4">
          <div className="grid grid-cols-2 gap-2">
            <Kpi label="Tokens-In" value={fmtCompact(tokensIn)} />
            <Kpi label="Tokens-Out" value={fmtCompact(tokensOut)} />
            <Kpi label="Turns" value={fmtCompact(turns)} />
            <Kpi label="Aufgaben" value={tasks.length ? `${tasksDone}/${tasks.length}` : '—'} />
          </div>
          <div className="text-3xs uppercase tracking-wider text-muted-foreground">
            {t('focus.kanban.title', 'Aufgaben')}
          </div>
          <div className="flex min-h-0 flex-1 flex-col gap-1.5 overflow-y-auto">
            {tasks.length === 0 ? (
              <div className="rounded-md border border-dashed p-4 text-center text-xs text-muted-foreground">
                {t('focus.kanban.empty', 'Noch keine Aufgaben.')}
              </div>
            ) : (
              tasks.map((task) => {
                const color =
                  task.status === 'done'
                    ? 'border-l-emerald-500'
                    : task.status === 'failed'
                      ? 'border-l-rose-500'
                      : task.status === 'running'
                        ? 'border-l-sky-500'
                        : 'border-l-muted';
                return (
                  <div
                    key={task.id}
                    className={`rounded-md border border-l-4 ${color} bg-card/60 px-2.5 py-1.5 text-xs`}
                  >
                    <div className="flex items-center justify-between">
                      <span className="truncate font-medium">{task.title ?? task.id}</span>
                      <span className="ml-2 shrink-0 text-3xs uppercase text-muted-foreground">
                        {task.status}
                      </span>
                    </div>
                  </div>
                );
              })
            )}
          </div>
          {(tasksRunning > 0 || tasksFailed > 0 || tasksPending > 0) && (
            <div className="flex gap-3 text-3xs text-muted-foreground">
              <span>läuft: {tasksRunning}</span>
              <span>offen: {tasksPending}</span>
              <span>fehler: {tasksFailed}</span>
            </div>
          )}
        </section>

        {/* Preview pane */}
        <section className="flex min-w-0 flex-1 flex-col">
          <PreviewFrame projectId={projectId} />
        </section>

        {/* Chat rail */}
        <aside className="flex w-[300px] shrink-0 flex-col border-l">
          <div className="flex shrink-0 items-center gap-2 border-b px-3 py-2">
            <MessageSquare className="h-3.5 w-3.5 text-muted-foreground" />
            <span className="text-3xs uppercase tracking-wider text-muted-foreground">
              {t('focus.chat.title', 'Team-Chat')}
            </span>
          </div>
          <div className="min-h-0 flex-1 overflow-hidden">
            <AgentChat projectId={projectId} compact={true} />
          </div>
        </aside>
      </div>
    </div>
  );
}
