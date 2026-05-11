import { useState, useEffect } from 'react';
import { useTranslation } from 'react-i18next';
import { Link, useLocation, useNavigate, useParams } from 'react-router-dom';
import {
  Plus,
  FolderOpen,
  LayoutGrid,
  Bot,
  MessagesSquare,
  Wrench,
  Activity,
  Sparkles,
  GitBranch,
  Database,
} from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { Separator } from '@/components/ui/separator';
import { StatusDotBadge } from '@/components/StatusDotBadge';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Textarea } from '@/components/ui/textarea';
import { toast } from '@/components/ui/use-toast';
import {
  useCreateProject,
  useDailyRunCount,
  useGeneratedPlan,
  useProjectRuns,
  useProjects,
  useTemplates,
} from '@/api/queries';
import { ApiError, apiFetch } from '@/api/client';
import { TemplatePicker } from '@/components/TemplatePicker';

export function Sidebar() {
  const { t } = useTranslation();
  const [open, setOpen] = useState(false);
  const [name, setName] = useState('');
  const [goal, setGoal] = useState('');
  const [repoPath, setRepoPath] = useState('');
  const [templateId, setTemplateId] = useState<string | null>(null);
  const params = useParams<{ projectId?: string }>();
  const location = useLocation();
  const navigate = useNavigate();
  const { data: projects = [], isLoading } = useProjects();
  const { data: templates = [] } = useTemplates();
  const createProject = useCreateProject();
  const activePlan = useGeneratedPlan(params.projectId);
  const dailyCounts = useDailyRunCount();

  useEffect(() => {
    if (!templateId) return;
    const template = templates.find((t) => t.id === templateId);
    if (template && goal.trim() === '') {
      setGoal(template.suggestedGoals[0] ?? '');
    }
  }, [templateId, templates, goal]);

  const reset = (): void => {
    setName('');
    setGoal('');
    setRepoPath('');
    setTemplateId(null);
  };

  const valid = name.trim() && goal.trim() && repoPath.trim();

  const handleCreate = async (): Promise<void> => {
    if (!valid) return;
    try {
      const project = await createProject.mutateAsync({
        name: name.trim(),
        goal: goal.trim(),
        repoPath: repoPath.trim(),
      });
      if (templateId) {
        const template = templates.find((t) => t.id === templateId);
        if (template) {
          try {
            await apiFetch(`/api/projects/${project.id}/team`, {
              method: 'PUT',
              body: JSON.stringify(template.team),
            });
          } catch (err) {
            // Non-fatal — the user lands on the team page where they can manually retry.
            console.warn('template team save failed', err);
          }
        }
      }
      toast({ title: t('newProject.toasts.created'), description: project.name });
      setOpen(false);
      reset();
      navigate(`/projects/${project.id}/teams`);
    } catch (err) {
      const msg =
        err instanceof ApiError
          ? typeof err.body === 'object' && err.body && 'message' in err.body
            ? String((err.body as { message: unknown }).message)
            : err.message
          : (err as Error).message;
      toast({
        title: t('newProject.toasts.createFailed'),
        description: msg,
        variant: 'destructive',
      });
    }
  };

  const isHomeActive = !params.projectId && location.pathname === '/';
  const isAgentsActive = location.pathname.startsWith('/agents');
  const isChatActive = location.pathname.startsWith('/chat');
  const isSkillsActive = location.pathname.startsWith('/skills');
  const isWorkersActive = location.pathname.startsWith('/workers');
  const isInsightsActive = location.pathname.startsWith('/insights');
  const isGoapActive = location.pathname.startsWith('/goap');
  const isPromptBundlesActive = location.pathname.startsWith('/prompt-bundles');

  return (
    <aside className="flex h-full w-60 shrink-0 flex-col border-r bg-card">
      <div className="flex items-center justify-between p-4">
        <div className="flex flex-col">
          <span className="text-sm font-semibold">{t('navigation.appName')}</span>
          <Badge variant="secondary" className="mt-1 w-fit text-[10px]">
            v{__APP_VERSION__}
          </Badge>
        </div>
      </div>
      <Separator />
      <nav className="px-2 pt-3" aria-label="primary">
        <Link
          to="/"
          className={
            'flex items-center gap-2 rounded-md px-3 py-2 text-sm transition-colors hover:bg-accent hover:text-accent-foreground ' +
            (isHomeActive ? 'bg-accent text-accent-foreground' : 'text-muted-foreground')
          }
          data-testid="sidebar-mission-control"
        >
          <LayoutGrid className="h-4 w-4" />
          <span>{t('topBar.missionControl')}</span>
        </Link>
        <Link
          to="/chat"
          className={
            'mt-0.5 flex items-center gap-2 rounded-md px-3 py-2 text-sm transition-colors hover:bg-accent hover:text-accent-foreground ' +
            (isChatActive ? 'bg-accent text-accent-foreground' : 'text-muted-foreground')
          }
          data-testid="sidebar-chat"
        >
          <MessagesSquare className="h-4 w-4" />
          <span>{t('navigation.teamChat')}</span>
        </Link>
        <Link
          to="/agents"
          className={
            'mt-0.5 flex items-center gap-2 rounded-md px-3 py-2 text-sm transition-colors hover:bg-accent hover:text-accent-foreground ' +
            (isAgentsActive ? 'bg-accent text-accent-foreground' : 'text-muted-foreground')
          }
          data-testid="sidebar-agents"
        >
          <Bot className="h-4 w-4" />
          <span>{t('navigation.agents')}</span>
        </Link>
        <Link
          to="/skills"
          className={
            'mt-0.5 flex items-center gap-2 rounded-md px-3 py-2 text-sm transition-colors hover:bg-accent hover:text-accent-foreground ' +
            (isSkillsActive ? 'bg-accent text-accent-foreground' : 'text-muted-foreground')
          }
          data-testid="sidebar-skills"
        >
          <Wrench className="h-4 w-4" />
          <span>{t('navigation.skills')}</span>
        </Link>
        <Link
          to="/workers"
          className={
            'mt-0.5 flex items-center gap-2 rounded-md px-3 py-2 text-sm transition-colors hover:bg-accent hover:text-accent-foreground ' +
            (isWorkersActive ? 'bg-accent text-accent-foreground' : 'text-muted-foreground')
          }
          data-testid="sidebar-workers"
        >
          <Activity className="h-4 w-4" />
          <span>{t('navigation.workers')}</span>
        </Link>
        <Link
          to="/insights"
          className={
            'mt-0.5 flex items-center gap-2 rounded-md px-3 py-2 text-sm transition-colors hover:bg-accent hover:text-accent-foreground ' +
            (isInsightsActive ? 'bg-accent text-accent-foreground' : 'text-muted-foreground')
          }
          data-testid="sidebar-insights"
        >
          <Sparkles className="h-4 w-4" />
          <span>{t('navigation.insights')}</span>
        </Link>
        <Link
          to="/goap"
          className={
            'mt-0.5 flex items-center gap-2 rounded-md px-3 py-2 text-sm transition-colors hover:bg-accent hover:text-accent-foreground ' +
            (isGoapActive ? 'bg-accent text-accent-foreground' : 'text-muted-foreground')
          }
          data-testid="sidebar-goap"
        >
          <GitBranch className="h-4 w-4" />
          <span>{t('navigation.goapPlanner')}</span>
        </Link>
        <Link
          to="/prompt-bundles"
          className={
            'mt-0.5 flex items-center gap-2 rounded-md px-3 py-2 text-sm transition-colors hover:bg-accent hover:text-accent-foreground ' +
            (isPromptBundlesActive ? 'bg-accent text-accent-foreground' : 'text-muted-foreground')
          }
          data-testid="sidebar-prompt-bundles"
        >
          <Database className="h-4 w-4" />
          <span>{t('navigation.promptBundles')}</span>
        </Link>
      </nav>
      <div className="flex items-center justify-between px-4 pt-4 pb-2">
        <span className="text-xs uppercase tracking-wide text-muted-foreground">
          {t('navigation.projects')}
        </span>
        <Dialog
          open={open}
          onOpenChange={(o) => {
            setOpen(o);
            if (!o) reset();
          }}
        >
          <DialogTrigger asChild>
            <Button size="icon" variant="ghost" aria-label={t('navigation.newProject')}>
              <Plus className="h-4 w-4" />
            </Button>
          </DialogTrigger>
          <DialogContent>
            <DialogHeader>
              <DialogTitle>{t('newProject.title')}</DialogTitle>
              <DialogDescription>{t('newProject.description')}</DialogDescription>
            </DialogHeader>
            <div className="flex flex-col gap-4">
              <div className="flex flex-col gap-1.5">
                <Label htmlFor="np-name">{t('newProject.fields.name')}</Label>
                <Input
                  id="np-name"
                  placeholder={t('newProject.fields.namePlaceholder')}
                  value={name}
                  onChange={(e) => setName(e.target.value)}
                />
              </div>
              <div className="flex flex-col gap-1.5">
                <Label>{t('newProject.fields.template')}</Label>
                <TemplatePicker selectedId={templateId} onSelect={setTemplateId} />
              </div>
              <div className="flex flex-col gap-1.5">
                <Label htmlFor="np-goal">{t('newProject.fields.goal')}</Label>
                <Textarea
                  id="np-goal"
                  rows={3}
                  placeholder={
                    templateId
                      ? (templates.find((tpl) => tpl.id === templateId)?.suggestedGoals[0] ??
                        t('newProject.fields.goalPlaceholder'))
                      : t('newProject.fields.goalPlaceholder')
                  }
                  value={goal}
                  onChange={(e) => setGoal(e.target.value)}
                />
              </div>
              <div className="flex flex-col gap-1.5">
                <Label htmlFor="np-repo">{t('newProject.fields.repoPath')}</Label>
                <Input
                  id="np-repo"
                  placeholder={t('newProject.fields.repoPathPlaceholder')}
                  value={repoPath}
                  onChange={(e) => setRepoPath(e.target.value)}
                />
              </div>
            </div>
            <DialogFooter>
              <Button onClick={handleCreate} disabled={!valid || createProject.isPending}>
                {createProject.isPending ? t('buttons.creating') : t('buttons.create')}
              </Button>
            </DialogFooter>
          </DialogContent>
        </Dialog>
      </div>
      <nav className="flex flex-1 flex-col gap-0.5 px-2 pb-4" aria-label="projects">
        {isLoading && (
          <span className="px-3 py-2 text-xs text-muted-foreground">{t('buttons.loading')}</span>
        )}
        {!isLoading && projects.length === 0 && (
          <span className="px-3 py-2 text-xs text-muted-foreground">
            {t('navigation.noProjectsYet')}
          </span>
        )}
        {projects.map((p) => {
          const active = params.projectId === p.id;
          const status = active ? activePlan.data?.status : undefined;
          return (
            <div key={p.id} className="flex flex-col">
              <Link
                to={`/projects/${p.id}`}
                className={
                  'flex items-center gap-2 rounded-md px-3 py-2 text-sm transition-colors hover:bg-accent hover:text-accent-foreground ' +
                  (active ? 'bg-accent text-accent-foreground' : 'text-muted-foreground')
                }
              >
                <FolderOpen className="h-4 w-4" />
                <span className="truncate">{p.name}</span>
                {status && (
                  <span className="ml-auto" data-testid={`sidebar-plan-status-${p.id}`}>
                    <StatusDotBadge status={status} />
                  </span>
                )}
                {(() => {
                  const count = dailyCounts.data?.byProject[p.id] ?? 0;
                  if (count === 0) return null;
                  return (
                    <Badge
                      variant={count >= 5 ? 'destructive' : 'secondary'}
                      className={status ? 'ml-1 text-[9px]' : 'ml-auto text-[9px]'}
                      data-testid={`sidebar-daily-count-${p.id}`}
                    >
                      {t('navigation.today', { count })}
                    </Badge>
                  );
                })()}
              </Link>
              {active && <RecentRuns projectId={p.id} />}
            </div>
          );
        })}
      </nav>
    </aside>
  );
}

function RecentRuns({ projectId }: { projectId: string }) {
  const { t } = useTranslation();
  const runs = useProjectRuns(projectId);
  if (!runs.data || runs.data.length === 0) return null;
  const top = runs.data.slice(0, 3);
  return (
    <div className="ml-7 mr-2 flex flex-col gap-0.5 py-1" data-testid={`recent-runs-${projectId}`}>
      <span className="px-2 py-1 text-[10px] uppercase text-muted-foreground">
        {t('navigation.recentRuns')}
      </span>
      {top.map((r) => (
        <Link
          key={r.id}
          to={`/projects/${projectId}/run/${r.id}`}
          className="flex items-center gap-2 rounded-md px-2 py-1 text-xs text-muted-foreground hover:bg-accent hover:text-accent-foreground"
          data-testid={`recent-run-${r.id}`}
        >
          <span className="font-mono">{r.id.slice(0, 8)}</span>
          <span className="ml-auto">
            <StatusDotBadge status={r.status} pulse={r.status === 'running'} />
          </span>
        </Link>
      ))}
    </div>
  );
}
