import { useState } from 'react';
import { Link, useNavigate, useParams } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import {
  ArrowRight,
  Check,
  ClipboardList,
  ExternalLink,
  FolderGit2,
  Pencil,
  Play,
  Target,
  Users,
  X,
} from 'lucide-react';
import {
  useGeneratedPlan,
  useProject,
  useProjectRuns,
  useStartRun,
  useTeam,
  useUpdateProject,
} from '@/api/queries';
import { Textarea } from '@/components/ui/textarea';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Separator } from '@/components/ui/separator';
import { StatusDotBadge } from '@/components/StatusDotBadge';
import { ApiError } from '@/api/client';
import { toast } from '@/components/ui/use-toast';

function formatDate(value: string | Date | null | undefined): string {
  if (!value) return '—';
  const d = typeof value === 'string' ? new Date(value) : value;
  if (Number.isNaN(d.getTime())) return '—';
  return d.toLocaleString();
}

function formatDuration(start: string | Date | null, end: string | Date | null): string {
  if (!start || !end) return '—';
  const a = typeof start === 'string' ? new Date(start) : start;
  const b = typeof end === 'string' ? new Date(end) : end;
  if (Number.isNaN(a.getTime()) || Number.isNaN(b.getTime())) return '—';
  const ms = b.getTime() - a.getTime();
  if (ms < 0) return '—';
  const mins = Math.floor(ms / 60_000);
  const secs = Math.floor((ms % 60_000) / 1000);
  if (mins === 0) return `${secs}s`;
  if (mins < 60) return `${mins}m ${secs}s`;
  return `${Math.floor(mins / 60)}h ${mins % 60}m`;
}

function formatTokens(n: number | undefined): string {
  if (!n) return '0';
  if (n < 1000) return String(n);
  if (n < 10_000) return `${(n / 1000).toFixed(1)}k`;
  if (n < 1_000_000) return `${Math.round(n / 1000)}k`;
  return `${(n / 1_000_000).toFixed(1)}M`;
}

export function ProjectDetail() {
  const { t } = useTranslation();
  const { projectId } = useParams<{ projectId: string }>();
  const navigate = useNavigate();
  const project = useProject(projectId);
  const team = useTeam(projectId);
  const plan = useGeneratedPlan(projectId);
  const runs = useProjectRuns(projectId);
  const startRun = useStartRun();

  const isLockedPlan = plan.data?.status === 'locked';
  const planId = plan.data?.id;

  const handleNewRun = async (): Promise<void> => {
    if (!planId) return;
    try {
      const result = await startRun.mutateAsync({ planId });
      toast({ title: t('projectDetail.toasts.runStarted'), description: result.runId.slice(0, 8) });
      navigate(`/projects/${projectId}/run/${result.runId}`);
    } catch (err) {
      const msg =
        err instanceof ApiError
          ? typeof err.body === 'object' && err.body && 'message' in err.body
            ? String((err.body as { message: unknown }).message)
            : err.message
          : (err as Error).message;
      toast({
        title: t('projectDetail.toasts.runStartFailed'),
        description: msg,
        variant: 'destructive',
      });
    }
  };

  if (project.isLoading) {
    return <p className="text-sm text-muted-foreground">{t('buttons.loading')}</p>;
  }
  if (!project.data) {
    return (
      <Card>
        <CardHeader>
          <CardTitle>{t('runView.notFound')}</CardTitle>
          <CardDescription>{t('runView.notFoundDesc')}</CardDescription>
        </CardHeader>
      </Card>
    );
  }

  const p = project.data;
  const runList = runs.data ?? [];
  const successfulCount = runList.filter((r) => r.outcome === 'success').length;
  const totalTokens = runList.reduce(
    (acc, r) => acc + (r.tokensInTotal ?? 0) + (r.tokensOutTotal ?? 0),
    0,
  );
  const roleCount = team.data?.roles.length ?? 0;

  return (
    <div className="flex flex-col gap-6">
      <div className="flex flex-col gap-1">
        <h1 className="text-2xl font-semibold">{p.name}</h1>
        <p className="text-sm text-muted-foreground">{t('projectDetail.subtitle')}</p>
      </div>

      <div className="grid gap-4 md:grid-cols-3">
        <GoalCard projectId={p.id} goal={p.goal} />

        <Card>
          <CardHeader className="pb-2">
            <CardTitle className="flex items-center gap-2 text-sm font-medium">
              <FolderGit2 className="h-4 w-4 text-muted-foreground" />
              {t('projectDetail.summary.repoPath')}
            </CardTitle>
          </CardHeader>
          <CardContent>
            <p className="break-all font-mono text-xs">{p.repoPath}</p>
          </CardContent>
        </Card>

        <Card>
          <CardHeader className="pb-2">
            <CardTitle className="flex items-center gap-2 text-sm font-medium">
              <Users className="h-4 w-4 text-muted-foreground" />
              {t('projectDetail.summary.team')}
            </CardTitle>
          </CardHeader>
          <CardContent>
            {roleCount === 0 ? (
              <p className="text-xs text-muted-foreground">{t('projectDetail.summary.noTeam')}</p>
            ) : (
              <div className="flex flex-wrap gap-1">
                <Badge variant="secondary" className="text-[10px]">
                  {t('projectDetail.summary.rolesCount', { count: roleCount })}
                </Badge>
                {team.data?.roles.slice(0, 5).map((role) => (
                  <Badge key={role.role} variant="outline" className="text-[10px]">
                    {role.role}
                  </Badge>
                ))}
              </div>
            )}
          </CardContent>
        </Card>
      </div>

      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2 text-sm font-medium">
            <ClipboardList className="h-4 w-4 text-muted-foreground" />
            {t('projectDetail.summary.plan')}
          </CardTitle>
          <CardDescription>
            {plan.data
              ? plan.data.status === 'locked'
                ? t('projectDetail.summary.planLocked')
                : t('projectDetail.summary.planDraft')
              : t('projectDetail.summary.noPlan')}
          </CardDescription>
        </CardHeader>
        <CardContent className="flex flex-wrap gap-2">
          <Button asChild variant="outline" size="sm">
            <Link to={`/projects/${projectId}/teams`}>
              <Users className="mr-2 h-4 w-4" />
              {t('projectDetail.actions.openTeam')}
            </Link>
          </Button>
          <Button asChild variant="outline" size="sm">
            <Link to={`/projects/${projectId}/plan`}>
              <ClipboardList className="mr-2 h-4 w-4" />
              {t('projectDetail.actions.openPlan')}
            </Link>
          </Button>
          <Button
            size="sm"
            onClick={handleNewRun}
            disabled={!isLockedPlan || startRun.isPending}
            title={isLockedPlan ? undefined : t('projectDetail.actions.newRunDisabled')}
            data-testid="project-detail-new-run"
          >
            <Play className="mr-2 h-4 w-4" />
            {startRun.isPending
              ? t('projectDetail.actions.starting')
              : t('projectDetail.actions.newRun')}
          </Button>
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle className="text-sm font-medium">{t('projectDetail.runs.title')}</CardTitle>
          <CardDescription className="flex flex-wrap gap-3 text-xs">
            <span>{t('projectDetail.runs.totalRuns', { count: runList.length })}</span>
            {runList.length > 0 && (
              <>
                <Separator orientation="vertical" className="h-4" />
                <span>{t('projectDetail.runs.successfulRuns', { count: successfulCount })}</span>
                <Separator orientation="vertical" className="h-4" />
                <span>
                  {t('projectDetail.runs.totalTokens', { tokens: formatTokens(totalTokens) })}
                </span>
              </>
            )}
          </CardDescription>
        </CardHeader>
        <CardContent>
          {runList.length === 0 ? (
            <p className="py-4 text-center text-sm text-muted-foreground">
              {t('projectDetail.runs.empty')}
            </p>
          ) : (
            <div className="overflow-x-auto">
              <table className="w-full text-xs">
                <thead className="border-b text-left text-[10px] uppercase tracking-wide text-muted-foreground">
                  <tr>
                    <th className="px-2 py-2 font-medium">{t('projectDetail.runs.table.id')}</th>
                    <th className="px-2 py-2 font-medium">
                      {t('projectDetail.runs.table.status')}
                    </th>
                    <th className="px-2 py-2 font-medium">
                      {t('projectDetail.runs.table.outcome')}
                    </th>
                    <th className="px-2 py-2 font-medium">
                      {t('projectDetail.runs.table.started')}
                    </th>
                    <th className="px-2 py-2 font-medium">
                      {t('projectDetail.runs.table.duration')}
                    </th>
                    <th className="px-2 py-2 text-right font-medium">
                      {t('projectDetail.runs.table.tokens')}
                    </th>
                    <th className="px-2 py-2 text-right font-medium">
                      {t('projectDetail.runs.table.actions')}
                    </th>
                  </tr>
                </thead>
                <tbody>
                  {runList.map((r) => {
                    const tokens = (r.tokensInTotal ?? 0) + (r.tokensOutTotal ?? 0);
                    return (
                      <tr
                        key={r.id}
                        className="border-b transition-colors hover:bg-muted/40"
                        data-testid={`project-run-row-${r.id}`}
                      >
                        <td className="px-2 py-2 font-mono">{r.id.slice(0, 8)}</td>
                        <td className="px-2 py-2">
                          <StatusDotBadge status={r.status} pulse={r.status === 'running'} />
                        </td>
                        <td className="px-2 py-2 text-muted-foreground">
                          {r.outcome ?? t('projectDetail.runs.running')}
                        </td>
                        <td className="px-2 py-2 text-muted-foreground">
                          {formatDate(r.startedAt)}
                        </td>
                        <td className="px-2 py-2 text-muted-foreground">
                          {formatDuration(r.startedAt, r.endedAt ?? null)}
                        </td>
                        <td className="px-2 py-2 text-right font-mono">{formatTokens(tokens)}</td>
                        <td className="px-2 py-2 text-right">
                          <Button asChild size="sm" variant="ghost">
                            <Link to={`/projects/${projectId}/run/${r.id}`}>
                              {t('projectDetail.runs.openRun')}
                              <ArrowRight className="ml-1 h-3 w-3" />
                              <ExternalLink className="hidden" aria-hidden="true" />
                            </Link>
                          </Button>
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          )}
        </CardContent>
      </Card>
    </div>
  );
}

interface GoalCardProps {
  projectId: string;
  goal: string;
}

function GoalCard({ projectId, goal }: GoalCardProps) {
  const { t } = useTranslation();
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(goal);
  const updateProject = useUpdateProject();

  const startEdit = (): void => {
    setDraft(goal);
    setEditing(true);
  };

  const cancelEdit = (): void => {
    setDraft(goal);
    setEditing(false);
  };

  const handleSave = async (): Promise<void> => {
    const next = draft.trim();
    if (!next || next === goal) {
      setEditing(false);
      return;
    }
    try {
      await updateProject.mutateAsync({ id: projectId, goal: next });
      toast({ title: t('projectDetail.toasts.goalUpdated') });
      setEditing(false);
    } catch (err) {
      toast({
        title: t('projectDetail.toasts.goalUpdateFailed'),
        description: (err as Error).message,
        variant: 'destructive',
      });
    }
  };

  return (
    <Card data-testid="project-summary-goal">
      <CardHeader className="flex flex-row items-center justify-between space-y-0 pb-2">
        <CardTitle className="flex items-center gap-2 text-sm font-medium">
          <Target className="h-4 w-4 text-muted-foreground" />
          {t('projectDetail.summary.goal')}
        </CardTitle>
        {!editing && (
          <Button
            type="button"
            size="sm"
            variant="ghost"
            onClick={startEdit}
            data-testid="goal-edit-button"
            className="h-7 px-2 text-xs"
          >
            <Pencil className="mr-1 h-3 w-3" />
            {t('projectDetail.goalEdit.editButton')}
          </Button>
        )}
      </CardHeader>
      <CardContent>
        {editing ? (
          <div className="flex flex-col gap-2">
            <Textarea
              rows={6}
              value={draft}
              onChange={(e) => setDraft(e.target.value)}
              placeholder={t('projectDetail.goalEdit.placeholder')}
              data-testid="goal-edit-textarea"
              autoFocus
            />
            <p className="text-[10px] text-muted-foreground">{t('projectDetail.goalEdit.hint')}</p>
            <div className="flex gap-2">
              <Button
                type="button"
                size="sm"
                onClick={() => void handleSave()}
                disabled={updateProject.isPending || draft.trim() === '' || draft.trim() === goal}
                data-testid="goal-save-button"
              >
                <Check className="mr-1 h-3 w-3" />
                {updateProject.isPending ? t('buttons.saving') : t('buttons.save')}
              </Button>
              <Button
                type="button"
                size="sm"
                variant="ghost"
                onClick={cancelEdit}
                disabled={updateProject.isPending}
                data-testid="goal-cancel-button"
              >
                <X className="mr-1 h-3 w-3" />
                {t('buttons.cancel')}
              </Button>
            </div>
          </div>
        ) : (
          <p className="text-sm leading-relaxed">{goal}</p>
        )}
      </CardContent>
    </Card>
  );
}
