import { useState } from 'react';
import { Link, useNavigate, useParams } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import {
  ArrowRight,
  Check,
  ClipboardList,
  ExternalLink,
  FolderGit2,
  GitMerge,
  Network,
  Pencil,
  Play,
  RefreshCcw,
  ShieldCheck,
  Target,
  Users,
  X,
} from 'lucide-react';
import { Input } from '@/components/ui/input';
import {
  useGeneratedPlan,
  useInterview,
  useProject,
  useProjectRuns,
  useProjectState,
  useStartRun,
  useTeam,
  useUpdateProject,
  type ProjectRunRow,
} from '@/api/queries';
import { Textarea } from '@/components/ui/textarea';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Separator } from '@/components/ui/separator';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { StatusDotBadge } from '@/components/StatusDotBadge';
import { ApiError } from '@/api/client';
import { toast } from '@/components/ui/use-toast';
import { DefinitionOfDoneCard } from '@/components/DefinitionOfDoneCard';
import { BriefCard } from '@/components/BriefCard';
import { ProjectStateCard } from '@/components/ProjectStateCard';
import { LeadNotesCard } from '@/components/LeadNotesCard';
import { PreviewFrame } from '@/components/PreviewFrame';
import { OrgChartView } from '@/components/OrgChartView';
import { BuildAppCard } from '@/components/BuildAppCard';
import { BuildTargetSelect } from '@/components/BuildTargetSelect';

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
                <Badge variant="secondary" className="text-2xs">
                  {t('projectDetail.summary.rolesCount', { count: roleCount })}
                </Badge>
                {team.data?.roles.slice(0, 5).map((role) => (
                  <Badge key={role.role} variant="outline" className="text-2xs">
                    {role.role}
                  </Badge>
                ))}
              </div>
            )}
          </CardContent>
        </Card>
      </div>

      <ProjectTabs
        projectId={p.id}
        project={p}
        runList={runList}
        successfulCount={successfulCount}
        totalTokens={totalTokens}
        planLocked={isLockedPlan}
        planStatus={plan.data?.status}
        startingRun={startRun.isPending}
        onNewRun={handleNewRun}
      />
    </div>
  );
}

interface ProjectTabsProps {
  projectId: string;
  project: NonNullable<ReturnType<typeof useProject>['data']>;
  runList: ProjectRunRow[];
  successfulCount: number;
  totalTokens: number;
  planLocked: boolean;
  planStatus: string | undefined;
  startingRun: boolean;
  onNewRun: () => Promise<void>;
}

function ProjectTabs({
  projectId,
  project: p,
  runList,
  successfulCount,
  totalTokens,
  planLocked,
  planStatus,
  startingRun,
  onNewRun,
}: ProjectTabsProps) {
  const { t } = useTranslation();
  const interview = useInterview(projectId);
  const stateQ = useProjectState(projectId);

  // Compute the initial tab once on first render and freeze it. Later
  // changes to the brief/state queries shouldn't yank the user off whatever
  // tab they're currently looking at — useState's lazy initializer is the
  // idiomatic way to derive a frozen mount-time value.
  const [initialTab] = useState<'brief' | 'preview'>(() => {
    const briefReady = interview.data?.brief?.briefReady === true;
    const hasState = !!stateQ.data?.state;
    return briefReady && hasState ? 'preview' : 'brief';
  });

  return (
    <Tabs defaultValue={initialTab} className="flex flex-col gap-6">
      <TabsList className="self-start">
        <TabsTrigger value="brief" data-testid="project-tabs-trigger-brief">
          {t('projectTabs.brief')}
        </TabsTrigger>
        <TabsTrigger value="plan" data-testid="project-tabs-trigger-plan">
          {t('projectTabs.plan')}
        </TabsTrigger>
        <TabsTrigger value="org" data-testid="project-tabs-trigger-org">
          <Network className="mr-1 h-3.5 w-3.5" />
          {t('projectTabs.org')}
        </TabsTrigger>
        <TabsTrigger value="runs" data-testid="project-tabs-trigger-runs">
          {t('projectTabs.runs')}
        </TabsTrigger>
        <TabsTrigger value="preview" data-testid="project-tabs-trigger-preview">
          {t('projectTabs.preview')}
        </TabsTrigger>
        <TabsTrigger value="settings" data-testid="project-tabs-trigger-settings">
          {t('projectTabs.settings')}
        </TabsTrigger>
      </TabsList>

      <TabsContent value="brief" className="flex flex-col gap-6">
        <BriefCard projectId={projectId} />
        <ProjectStateCard projectId={projectId} />
        <LeadNotesCard projectId={projectId} />
      </TabsContent>

      <TabsContent value="plan" className="flex flex-col gap-6">
        <PlanSummaryCard
          projectId={projectId}
          planStatus={planStatus}
          planLocked={planLocked}
          startingRun={startingRun}
          onNewRun={onNewRun}
        />
        <DefinitionOfDoneCard projectId={projectId} />
      </TabsContent>

      <TabsContent value="org" className="flex flex-col gap-6">
        <OrgChartView projectId={projectId} />
      </TabsContent>

      <TabsContent value="runs" className="flex flex-col gap-6">
        <RunsCard
          projectId={projectId}
          runList={runList}
          successfulCount={successfulCount}
          totalTokens={totalTokens}
        />
      </TabsContent>

      <TabsContent value="preview" className="flex flex-col gap-6">
        <PreviewFrame projectId={projectId} />
      </TabsContent>

      <TabsContent value="settings" className="flex flex-col gap-6">
        <ProductionModeCard
          projectId={projectId}
          autoMergeOnSuccess={p.autoMergeOnSuccess}
          selfHealingEnabled={p.selfHealingEnabled}
          maxChainIterations={p.maxChainIterations}
          defaultAutopilotMode={p.defaultAutopilotMode}
          defaultAutopilotBudgetMinutes={p.defaultAutopilotBudgetMinutes}
          defaultAutopilotBudgetTokens={p.defaultAutopilotBudgetTokens}
        />
        <BuildTargetSelect projectId={projectId} packageTarget={p.packageTarget ?? 'web'} />
        <BuildAppCard projectId={projectId} packageTarget={p.packageTarget ?? 'web'} />
      </TabsContent>
    </Tabs>
  );
}

interface PlanSummaryCardProps {
  projectId: string;
  planStatus: string | undefined;
  planLocked: boolean;
  startingRun: boolean;
  onNewRun: () => Promise<void>;
}

function PlanSummaryCard({
  projectId,
  planStatus,
  planLocked,
  startingRun,
  onNewRun,
}: PlanSummaryCardProps) {
  const { t } = useTranslation();
  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex items-center gap-2 text-sm font-medium">
          <ClipboardList className="h-4 w-4 text-muted-foreground" />
          {t('projectDetail.summary.plan')}
        </CardTitle>
        <CardDescription>
          {planStatus
            ? planStatus === 'locked'
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
          onClick={() => void onNewRun()}
          disabled={!planLocked || startingRun}
          title={planLocked ? undefined : t('projectDetail.actions.newRunDisabled')}
          data-testid="project-detail-new-run"
        >
          <Play className="mr-2 h-4 w-4" />
          {startingRun ? t('projectDetail.actions.starting') : t('projectDetail.actions.newRun')}
        </Button>
      </CardContent>
    </Card>
  );
}

interface RunsCardProps {
  projectId: string;
  runList: ProjectRunRow[];
  successfulCount: number;
  totalTokens: number;
}

function RunsCard({ projectId, runList, successfulCount, totalTokens }: RunsCardProps) {
  const { t } = useTranslation();
  return (
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
              <thead className="border-b text-left text-2xs uppercase tracking-wide text-muted-foreground">
                <tr>
                  <th className="px-2 py-2 font-medium">{t('projectDetail.runs.table.id')}</th>
                  <th className="px-2 py-2 font-medium">{t('projectDetail.runs.table.status')}</th>
                  <th className="px-2 py-2 font-medium">{t('projectDetail.runs.table.outcome')}</th>
                  <th className="px-2 py-2 font-medium">{t('projectDetail.runs.table.started')}</th>
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
                  const iter = r.chainIteration ?? 0;
                  return (
                    <tr
                      key={r.id}
                      className="border-b transition-colors hover:bg-muted/40"
                      data-testid={`project-run-row-${r.id}`}
                    >
                      <td className="px-2 py-2 font-mono">
                        <span className="inline-flex items-center gap-1.5">
                          {iter > 0 && (
                            <span
                              className="rounded-full bg-indigo-500/15 px-1.5 py-0.5 text-2xs font-medium text-indigo-700 dark:text-indigo-300"
                              title={
                                r.parentRunId
                                  ? `Parent: ${r.parentRunId.slice(0, 8)}`
                                  : 'Härtungs-Iteration'
                              }
                              data-testid={`run-chain-badge-${r.id}`}
                            >
                              ↳ Iter {iter}
                            </span>
                          )}
                          {r.id.slice(0, 8)}
                        </span>
                      </td>
                      <td className="px-2 py-2">
                        <StatusDotBadge status={r.status} pulse={r.status === 'running'} />
                      </td>
                      <td className="px-2 py-2 text-muted-foreground">
                        {r.outcome ?? t('projectDetail.runs.running')}
                      </td>
                      <td className="px-2 py-2 text-muted-foreground">{formatDate(r.startedAt)}</td>
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
            <p className="text-2xs text-muted-foreground">{t('projectDetail.goalEdit.hint')}</p>
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

interface ProductionModeCardProps {
  projectId: string;
  autoMergeOnSuccess: boolean;
  selfHealingEnabled: boolean;
  maxChainIterations: number;
  defaultAutopilotMode: boolean;
  defaultAutopilotBudgetMinutes: number | null;
  defaultAutopilotBudgetTokens: number | null;
}

/**
 * Production-Modus card on the project detail page.
 *
 * Three knobs that together turn a one-shot run into an auto-iterating
 * "make me a production-ready app" pipeline:
 *
 *   1. autoMergeOnSuccess — fast-forward the result branch into main after
 *      every successful run, so the user's working tree picks up the
 *      finished code without a manual `git merge`.
 *   2. selfHealingEnabled — scan the result branch for HIGH/CRITICAL
 *      findings after every successful run; if any remain AND
 *      chainIteration < maxChainIterations, auto-spawn a follow-up
 *      hardening run with those findings baked into its goal.
 *   3. maxChainIterations — hard ceiling on the chain depth (1–10).
 *
 * Behaves like AutopilotToggle: local form state, dirty/saved indicator,
 * resync from server only when not dirty.
 */
function ProductionModeCard({
  projectId,
  autoMergeOnSuccess,
  selfHealingEnabled,
  maxChainIterations,
  defaultAutopilotMode,
  defaultAutopilotBudgetMinutes,
  defaultAutopilotBudgetTokens,
}: ProductionModeCardProps) {
  const { t } = useTranslation();
  const update = useUpdateProject();
  const [autoMerge, setAutoMerge] = useState(autoMergeOnSuccess);
  const [selfHeal, setSelfHeal] = useState(selfHealingEnabled);
  const [maxIter, setMaxIter] = useState<string>(String(maxChainIterations));
  const [autoPilot, setAutoPilot] = useState(defaultAutopilotMode);
  const [budgetMin, setBudgetMin] = useState<string>(
    defaultAutopilotBudgetMinutes != null ? String(defaultAutopilotBudgetMinutes) : '',
  );
  const [budgetTok, setBudgetTok] = useState<string>(
    defaultAutopilotBudgetTokens != null ? String(defaultAutopilotBudgetTokens) : '',
  );
  const [saved, setSaved] = useState({
    autoMerge: autoMergeOnSuccess,
    selfHeal: selfHealingEnabled,
    maxIter: String(maxChainIterations),
    autoPilot: defaultAutopilotMode,
    budgetMin: defaultAutopilotBudgetMinutes != null ? String(defaultAutopilotBudgetMinutes) : '',
    budgetTok: defaultAutopilotBudgetTokens != null ? String(defaultAutopilotBudgetTokens) : '',
  });

  const validMaxIter = /^\d+$/.test(maxIter) && Number(maxIter) >= 1 && Number(maxIter) <= 10;
  const validBudgetMin = budgetMin === '' || (/^\d+$/.test(budgetMin) && Number(budgetMin) >= 1);
  const validBudgetTok = budgetTok === '' || (/^\d+$/.test(budgetTok) && Number(budgetTok) >= 1);
  const valid = validMaxIter && validBudgetMin && validBudgetTok;
  const dirty =
    autoMerge !== saved.autoMerge ||
    selfHeal !== saved.selfHeal ||
    maxIter !== saved.maxIter ||
    autoPilot !== saved.autoPilot ||
    budgetMin !== saved.budgetMin ||
    budgetTok !== saved.budgetTok;

  const handleSave = async (): Promise<void> => {
    if (!valid) return;
    try {
      await update.mutateAsync({
        id: projectId,
        autoMergeOnSuccess: autoMerge,
        selfHealingEnabled: selfHeal,
        maxChainIterations: Number(maxIter),
        defaultAutopilotMode: autoPilot,
        defaultAutopilotBudgetMinutes: budgetMin === '' ? null : Number(budgetMin),
        defaultAutopilotBudgetTokens: budgetTok === '' ? null : Number(budgetTok),
      });
      setSaved({ autoMerge, selfHeal, maxIter, autoPilot, budgetMin, budgetTok });
      toast({ title: t('projectDetail.productionMode.saved') });
    } catch (err) {
      toast({
        title: t('projectDetail.productionMode.saveFailed'),
        description: (err as Error).message,
        variant: 'destructive',
      });
    }
  };

  return (
    <Card data-testid="production-mode-card">
      <CardHeader className="flex flex-row items-center justify-between space-y-0 pb-2">
        <div className="flex flex-col gap-0.5">
          <CardTitle className="flex items-center gap-2 text-sm font-medium">
            <ShieldCheck className="h-4 w-4 text-muted-foreground" />
            {t('projectDetail.productionMode.title')}
          </CardTitle>
          <CardDescription className="text-2xs">
            {t('projectDetail.productionMode.description')}
          </CardDescription>
        </div>
        <Button
          type="button"
          size="sm"
          onClick={() => void handleSave()}
          disabled={update.isPending || !dirty || !valid}
          data-testid="production-mode-save"
          data-dirty={dirty}
        >
          {!update.isPending && !dirty && <Check className="mr-1 h-3 w-3" />}
          {update.isPending
            ? t('buttons.saving')
            : dirty
              ? t('buttons.save')
              : t('runView.autopilot.saved')}
        </Button>
      </CardHeader>
      <CardContent className="flex flex-col gap-3">
        <label className="flex items-center gap-3">
          <input
            type="checkbox"
            checked={autoMerge}
            onChange={(e) => setAutoMerge(e.target.checked)}
            data-testid="production-mode-automerge"
          />
          <span className="flex items-center gap-1.5 text-sm font-medium">
            <GitMerge className="h-3.5 w-3.5 text-muted-foreground" />
            {t('projectDetail.productionMode.autoMerge')}
          </span>
          <span className="text-xs text-muted-foreground">
            {t('projectDetail.productionMode.autoMergeDescription')}
          </span>
        </label>

        <label className="flex items-center gap-3">
          <input
            type="checkbox"
            checked={selfHeal}
            onChange={(e) => setSelfHeal(e.target.checked)}
            data-testid="production-mode-selfheal"
          />
          <span className="flex items-center gap-1.5 text-sm font-medium">
            <RefreshCcw className="h-3.5 w-3.5 text-muted-foreground" />
            {t('projectDetail.productionMode.selfHealing')}
          </span>
          <span className="text-xs text-muted-foreground">
            {t('projectDetail.productionMode.selfHealingDescription')}
          </span>
        </label>

        <div className="flex items-center gap-3">
          <Input
            type="number"
            min={1}
            max={10}
            className="w-20"
            value={maxIter}
            onChange={(e) => setMaxIter(e.target.value)}
            disabled={!selfHeal}
            data-testid="production-mode-maxiter"
            aria-label={t('projectDetail.productionMode.maxIterations')}
          />
          <span className="text-sm">{t('projectDetail.productionMode.maxIterations')}</span>
          <span className="text-xs text-muted-foreground">
            {t('projectDetail.productionMode.maxIterationsDescription')}
          </span>
        </div>

        <div className="my-1 border-t border-border" />
        <p className="text-xs font-medium text-muted-foreground">
          {t('projectDetail.productionMode.autopilotDefaults')}
        </p>

        <label className="flex items-center gap-3">
          <input
            type="checkbox"
            checked={autoPilot}
            onChange={(e) => setAutoPilot(e.target.checked)}
            data-testid="production-mode-autopilot"
          />
          <span className="text-sm font-medium">
            {t('projectDetail.productionMode.autopilotDefault')}
          </span>
          <span className="text-xs text-muted-foreground">
            {t('projectDetail.productionMode.autopilotDefaultDescription')}
          </span>
        </label>

        <div className="flex flex-wrap items-center gap-3">
          <Input
            type="number"
            min={1}
            className="w-28"
            placeholder={t('runView.autopilot.budgetMinPlaceholder')}
            value={budgetMin}
            onChange={(e) => setBudgetMin(e.target.value)}
            disabled={!autoPilot}
            data-testid="production-mode-budgetmin"
            aria-label={t('runView.autopilot.budgetMinPlaceholder')}
          />
          <Input
            type="number"
            min={1}
            className="w-32"
            placeholder={t('runView.autopilot.budgetTokensPlaceholder')}
            value={budgetTok}
            onChange={(e) => setBudgetTok(e.target.value)}
            disabled={!autoPilot}
            data-testid="production-mode-budgettok"
            aria-label={t('runView.autopilot.budgetTokensPlaceholder')}
          />
          <span className="text-xs text-muted-foreground">
            {t('projectDetail.productionMode.budgetDescription')}
          </span>
        </div>
      </CardContent>
    </Card>
  );
}
