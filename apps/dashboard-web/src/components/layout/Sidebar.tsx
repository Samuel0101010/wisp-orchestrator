import { useEffect, useMemo, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { useTranslation } from 'react-i18next';
import { Link, useLocation, useNavigate, useParams } from 'react-router-dom';
import {
  Activity,
  Bot,
  ChevronDown,
  ChevronLeft,
  ChevronRight,
  Database,
  GitBranch,
  LayoutGrid,
  MessagesSquare,
  MoreHorizontal,
  Plus,
  Settings,
  Sparkles,
  Star,
  Trash2,
  Wrench,
} from 'lucide-react';
import { Button } from '@/components/ui/button';
import { IconButton } from '@/components/ui/icon-button';
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip';
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
import { TemplatePicker } from '@/components/TemplatePicker';
import {
  useCreateProject,
  useDailyRunCount,
  useDeleteProject,
  useGeneratedPlan,
  useProjectRuns,
  useProjects,
  useTemplates,
} from '@/api/queries';
import { ApiError, apiFetch } from '@/api/client';
import { useUiStore } from '@/store/ui';
import { cn } from '@/lib/utils';

/* ----- Wisp project tones for the project list dots ------------------ */
const PROJECT_TONES = ['coral', 'sky', 'violet', 'amber', 'mint', 'rose'] as const;
function projectTone(id: string): (typeof PROJECT_TONES)[number] {
  let h = 0;
  for (let i = 0; i < id.length; i++) h = (h * 31 + id.charCodeAt(i)) | 0;
  return PROJECT_TONES[Math.abs(h) % PROJECT_TONES.length]!;
}

interface NavItem {
  to: string;
  label: string;
  icon: React.ReactNode;
  testId: string;
  matchPath: (pathname: string, hasProject: boolean) => boolean;
}

export function Sidebar() {
  const { t } = useTranslation();
  const params = useParams<{ projectId?: string }>();
  const location = useLocation();
  const navigate = useNavigate();
  const { data: projects = [], isLoading } = useProjects();
  const { data: templates = [] } = useTemplates();
  const createProject = useCreateProject();
  const activePlan = useGeneratedPlan(params.projectId);
  const dailyCounts = useDailyRunCount();
  const collapsed = useUiStore((s) => s.sidebarCollapsed);
  const toggleSidebar = useUiStore((s) => s.toggleSidebar);
  const favoriteProjectIds = useUiStore((s) => s.favoriteProjectIds);
  const toggleFavorite = useUiStore((s) => s.toggleFavorite);
  const deleteProject = useDeleteProject();

  // Favorites first, original order otherwise. `indexOf` against the original
  // list keeps the inner ordering stable when nothing is favorited.
  const sortedProjects = useMemo(() => {
    const favSet = new Set(favoriteProjectIds);
    return [...projects].sort((a, b) => {
      const af = favSet.has(a.id) ? 1 : 0;
      const bf = favSet.has(b.id) ? 1 : 0;
      if (af !== bf) return bf - af;
      return projects.indexOf(a) - projects.indexOf(b);
    });
  }, [projects, favoriteProjectIds]);

  const [open, setOpen] = useState(false);
  const [projectsOpen, setProjectsOpen] = useState(true);
  const [name, setName] = useState('');
  const [goal, setGoal] = useState('');
  const [repoPath, setRepoPath] = useState('');
  const [templateId, setTemplateId] = useState<string | null>(null);

  useEffect(() => {
    if (!templateId) return;
    const template = templates.find((tpl) => tpl.id === templateId);
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
        const template = templates.find((tpl) => tpl.id === templateId);
        if (template) {
          try {
            await apiFetch(`/api/projects/${project.id}/team`, {
              method: 'PUT',
              body: JSON.stringify(template.team),
            });
          } catch (err) {
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

  const hasProject = Boolean(params.projectId);
  const onHomeOrProject = (p: string) => p === '/' || p.startsWith('/projects');

  const navItems: NavItem[] = useMemo(
    () => [
      {
        to: '/',
        label: t('topBar.missionControl'),
        icon: <LayoutGrid className="h-4 w-4" />,
        testId: 'sidebar-mission-control',
        matchPath: (p) => p === '/' && !hasProject,
      },
      {
        to: '/chat',
        label: t('navigation.teamChat'),
        icon: <MessagesSquare className="h-4 w-4" />,
        testId: 'sidebar-chat',
        matchPath: (p) => p.startsWith('/chat'),
      },
      {
        to: '/agents',
        label: t('navigation.agents'),
        icon: <Bot className="h-4 w-4" />,
        testId: 'sidebar-agents',
        matchPath: (p) => p.startsWith('/agents'),
      },
      {
        to: '/skills',
        label: t('navigation.skills'),
        icon: <Wrench className="h-4 w-4" />,
        testId: 'sidebar-skills',
        matchPath: (p) => p.startsWith('/skills'),
      },
      {
        to: '/workers',
        label: t('navigation.workers'),
        icon: <Activity className="h-4 w-4" />,
        testId: 'sidebar-workers',
        matchPath: (p) => p.startsWith('/workers'),
      },
      {
        to: '/insights',
        label: t('navigation.insights'),
        icon: <Sparkles className="h-4 w-4" />,
        testId: 'sidebar-insights',
        matchPath: (p) => p.startsWith('/insights'),
      },
      {
        to: '/goap',
        label: t('navigation.goapPlanner'),
        icon: <GitBranch className="h-4 w-4" />,
        testId: 'sidebar-goap',
        matchPath: (p) => p.startsWith('/goap'),
      },
      {
        to: '/prompt-bundles',
        label: t('navigation.promptBundles'),
        icon: <Database className="h-4 w-4" />,
        testId: 'sidebar-prompt-bundles',
        matchPath: (p) => p.startsWith('/prompt-bundles'),
      },
    ],
    [t, hasProject],
  );

  const dailyTotal = useMemo(() => {
    if (!dailyCounts.data) return 0;
    return Object.values(dailyCounts.data.byProject).reduce((s, n) => s + n, 0);
  }, [dailyCounts.data]);
  void onHomeOrProject;

  if (collapsed) {
    return (
      <aside className="wisp-aurora-scope relative z-[2] flex h-full w-16 shrink-0 flex-col items-center gap-2 border-r border-[color:var(--wisp-hairline)] bg-[color:var(--wisp-sidebar-bg)] px-2.5 py-4 backdrop-blur-[30px]">
        <WispLogo small />
        <div className="mt-4 flex w-full flex-col gap-1">
          {navItems.map((item) => {
            const active = item.matchPath(location.pathname, hasProject);
            return (
              <Tooltip key={item.to}>
                <TooltipTrigger asChild>
                  <Link
                    to={item.to}
                    data-testid={item.testId}
                    className={cn(
                      'wisp-nav-item justify-center px-0',
                      active && 'on',
                      'h-9 w-9 self-center',
                    )}
                    style={{ padding: 8 }}
                  >
                    <span
                      style={{
                        color: active ? 'var(--coral)' : 'var(--wisp-ink-3)',
                      }}
                    >
                      {item.icon}
                    </span>
                  </Link>
                </TooltipTrigger>
                <TooltipContent side="right">{item.label}</TooltipContent>
              </Tooltip>
            );
          })}
        </div>
        <button
          type="button"
          className="wisp-btn icon ghost mt-auto"
          onClick={toggleSidebar}
          aria-label={t('navigation.expandSidebar', 'Expand sidebar')}
          title={t('navigation.expandSidebar', 'Expand sidebar')}
        >
          <ChevronRight className="h-3.5 w-3.5" />
        </button>
      </aside>
    );
  }

  return (
    <aside
      className="wisp-aurora-scope relative z-[2] flex h-full w-[248px] shrink-0 flex-col border-r border-[color:var(--wisp-hairline)] bg-[color:var(--wisp-sidebar-bg)] px-3.5 pt-4 pb-3.5 backdrop-blur-[30px]"
      data-testid="sidebar"
    >
      <div className="mb-3 flex items-center justify-between px-1">
        <WispLogo />
        <button
          type="button"
          className="wisp-btn icon ghost"
          onClick={toggleSidebar}
          aria-label={t('navigation.collapseSidebar', 'Collapse sidebar')}
          title={t('navigation.collapseSidebar', 'Collapse sidebar')}
        >
          <ChevronLeft className="h-3.5 w-3.5" />
        </button>
      </div>

      <nav className="flex shrink-0 flex-col gap-1" aria-label="primary">
        {navItems.map((item) => {
          const active = item.matchPath(location.pathname, hasProject);
          return (
            <Link
              key={item.to}
              to={item.to}
              className={cn('wisp-nav-item', active && 'on')}
              data-testid={item.testId}
            >
              <span style={{ color: active ? 'var(--coral)' : 'var(--wisp-ink-3)' }}>
                {item.icon}
              </span>
              <span className="flex-1 text-left">{item.label}</span>
            </Link>
          );
        })}
      </nav>

      {/* Projects section grows to fill the remaining space and scrolls its
          list internally, so the plan-budget footer below stays anchored to
          the bottom of the viewport even with 20+ projects. */}
      <div className="mt-5 flex min-h-0 flex-1 flex-col">
        <div className="flex shrink-0 items-center gap-1.5 px-1 pt-1 pb-2 text-[color:var(--wisp-ink-3)]">
          <button
            type="button"
            onClick={() => setProjectsOpen((o) => !o)}
            className="flex flex-1 cursor-pointer items-center gap-1.5 border-none bg-transparent p-0 text-left text-[color:var(--wisp-ink-3)]"
            aria-expanded={projectsOpen}
          >
            <ChevronDown
              className={cn('h-3 w-3 transition-transform', !projectsOpen && '-rotate-90')}
            />
            <span className="t-eyebrow">
              {t('navigation.projects')} · {projects.length}
            </span>
          </button>
          <Dialog
            open={open}
            onOpenChange={(o) => {
              setOpen(o);
              if (!o) reset();
            }}
          >
            <DialogTrigger asChild>
              <IconButton
                icon={<Plus className="h-3.5 w-3.5" />}
                label={t('tooltips.newProject')}
              />
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

        {projectsOpen && (
          <nav
            className="flex min-h-0 flex-1 flex-col gap-1 overflow-y-auto pr-1"
            aria-label="projects"
          >
            {isLoading && (
              <span className="px-2.5 py-2 text-xs text-[color:var(--wisp-ink-4)]">
                {t('buttons.loading')}
              </span>
            )}
            {!isLoading && projects.length === 0 && (
              <span className="px-2.5 py-2 text-xs text-[color:var(--wisp-ink-4)]">
                {t('navigation.noProjectsYet')}
              </span>
            )}
            {sortedProjects.map((p) => {
              const active = params.projectId === p.id;
              const tone = projectTone(p.id);
              const status = active ? activePlan.data?.status : undefined;
              const count = dailyCounts.data?.byProject[p.id] ?? 0;
              const hot = count > 0 || status === 'running';
              const warn = status === 'failed';
              const isFavorite = favoriteProjectIds.includes(p.id);
              return (
                <div key={p.id} className="flex flex-col">
                  <ProjectRow
                    id={p.id}
                    name={p.name}
                    tone={tone}
                    active={active}
                    hot={hot}
                    warn={warn}
                    isFavorite={isFavorite}
                    onToggleFavorite={() => toggleFavorite(p.id)}
                    onDelete={async () => {
                      try {
                        await deleteProject.mutateAsync(p.id);
                        toast({ title: t('projectMenu.deleted'), description: p.name });
                      } catch (err) {
                        toast({
                          title: t('projectMenu.deleteFailed'),
                          description: (err as Error).message,
                          variant: 'destructive',
                        });
                      }
                    }}
                  />
                  {active && <RecentRuns projectId={p.id} />}
                </div>
              );
            })}
          </nav>
        )}
      </div>

      {/* Plan budget block — design parity. Uses dailyTotal as today's-runs
          stand-in until a real budget API exists. `shrink-0` keeps the
          footer fully visible even when the projects list overflows. */}
      <div className="flex shrink-0 flex-col gap-2 pt-4">
        <div className="wisp-surface" style={{ padding: 12 }}>
          <div className="t-eyebrow mb-1.5">{t('navigation.todayRuns', 'Runs · today')}</div>
          <div className="mb-1.5 flex items-baseline justify-between">
            <span style={{ fontFamily: 'var(--f-display)', fontSize: 24 }}>{dailyTotal}</span>
            <span className="t-mono t-faint" style={{ fontSize: 11 }}>
              {t('navigation.runsLabel', 'runs')}
            </span>
          </div>
          <div className="wisp-bar mint" aria-hidden>
            <i
              style={
                {
                  ['--w' as never]: Math.min(1, dailyTotal / 20),
                  transform: `scaleX(${Math.min(1, dailyTotal / 20)})`,
                } as React.CSSProperties
              }
            />
          </div>
        </div>
        <div className="flex items-center justify-between px-1">
          <Link to="/settings" className="wisp-btn ghost sm" data-testid="sidebar-settings">
            <Settings className="h-3.5 w-3.5" />
            {t('navigation.settings', 'Settings')}
          </Link>
          <span className="wisp-kbd">⌘K</span>
        </div>
      </div>
    </aside>
  );
}

function WispLogo({ small = false }: { small?: boolean }) {
  const size = small ? 32 : 40;
  return (
    <div className="flex items-center gap-2.5">
      <img
        src="/wisp-mascot.png"
        alt="Wisp mascot"
        style={{ display: 'block', height: size, width: 'auto' }}
      />
      {!small && (
        <div className="flex items-baseline gap-2">
          <img
            src="/wisp-wordmark.png"
            alt="Wisp"
            style={{ display: 'block', height: 22, width: 'auto' }}
          />
          <span className="t-mono t-faint" style={{ fontSize: 10 }}>
            v{__APP_VERSION__}
          </span>
        </div>
      )}
    </div>
  );
}

interface ProjectRowProps {
  id: string;
  name: string;
  tone: (typeof PROJECT_TONES)[number];
  active: boolean;
  hot: boolean;
  warn: boolean;
  isFavorite: boolean;
  onToggleFavorite: () => void;
  onDelete: () => Promise<void> | void;
}

function ProjectRow({
  id,
  name,
  tone,
  active,
  hot,
  warn,
  isFavorite,
  onToggleFavorite,
  onDelete,
}: ProjectRowProps) {
  const { t } = useTranslation();
  const [menuOpen, setMenuOpen] = useState(false);
  const [menuPos, setMenuPos] = useState<{ top: number; left: number } | null>(null);
  const [deleteOpen, setDeleteOpen] = useState(false);
  const [deleting, setDeleting] = useState(false);
  const triggerRef = useRef<HTMLButtonElement | null>(null);
  const menuRef = useRef<HTMLDivElement | null>(null);

  // Anchor the portal-rendered menu to the trigger button on each open. The
  // menu drops below-and-right-aligned; subtracting the menu's min-width keeps
  // its right edge flush with the trigger.
  useEffect(() => {
    if (!menuOpen) {
      setMenuPos(null);
      return;
    }
    if (!triggerRef.current) return;
    const r = triggerRef.current.getBoundingClientRect();
    const MENU_MIN_W = 180;
    setMenuPos({ top: r.bottom + 4, left: r.right - MENU_MIN_W });
  }, [menuOpen]);

  useEffect(() => {
    if (!menuOpen) return;
    const onDocClick = (e: MouseEvent) => {
      const tgt = e.target as Node;
      const inMenu = menuRef.current?.contains(tgt) ?? false;
      const inTrigger = triggerRef.current?.contains(tgt) ?? false;
      if (!inMenu && !inTrigger) setMenuOpen(false);
    };
    const onEsc = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setMenuOpen(false);
    };
    document.addEventListener('mousedown', onDocClick);
    document.addEventListener('keydown', onEsc);
    return () => {
      document.removeEventListener('mousedown', onDocClick);
      document.removeEventListener('keydown', onEsc);
    };
  }, [menuOpen]);

  const handleConfirmDelete = async (): Promise<void> => {
    setDeleting(true);
    try {
      await onDelete();
      setDeleteOpen(false);
    } finally {
      setDeleting(false);
    }
  };

  return (
    <div className="group relative flex items-center" data-testid={`project-row-${id}`}>
      <Tooltip>
        <TooltipTrigger asChild>
          <Link
            to={`/projects/${id}`}
            className={cn('wisp-nav-item flex-1 pl-2.5 pr-8', active && 'on')}
          >
            <span
              className={cn('wisp-dot', tone, hot && 'pulse')}
              style={{ width: 6, height: 6 }}
            />
            <span className="flex-1 truncate text-left" style={{ fontSize: 12.5 }}>
              {name}
            </span>
            {isFavorite && (
              <Star
                className="h-3 w-3 shrink-0"
                style={{ color: 'var(--amber)', fill: 'var(--amber)' }}
                aria-hidden
              />
            )}
            {hot && (
              <span className="wisp-chip coral" style={{ padding: '0 6px', fontSize: 10 }}>
                live
              </span>
            )}
            {warn && (
              <span className="wisp-chip amber" style={{ padding: '0 6px', fontSize: 10 }}>
                paused
              </span>
            )}
          </Link>
        </TooltipTrigger>
        <TooltipContent side="right">{name}</TooltipContent>
      </Tooltip>
      <div className="absolute right-1 top-1/2 -translate-y-1/2">
        <button
          ref={triggerRef}
          type="button"
          aria-label={t('projectMenu.trigger', 'Project options')}
          aria-haspopup="menu"
          aria-expanded={menuOpen}
          data-testid={`project-menu-trigger-${id}`}
          className={cn(
            'flex h-6 w-6 items-center justify-center rounded-md text-[color:var(--wisp-ink-3)] opacity-0 transition-opacity hover:bg-[color:var(--wisp-glass-hover)] hover:text-[color:var(--wisp-ink)] group-hover:opacity-100 focus:opacity-100 focus:outline-none focus:ring-1 focus:ring-[color:var(--coral)]',
            menuOpen && 'opacity-100',
          )}
          onClick={(e) => {
            e.preventDefault();
            e.stopPropagation();
            setMenuOpen((o) => !o);
          }}
        >
          <MoreHorizontal className="h-3.5 w-3.5" />
        </button>
      </div>
      {menuOpen &&
        menuPos &&
        createPortal(
          <div
            ref={menuRef}
            role="menu"
            data-testid={`project-menu-${id}`}
            className="fixed z-[1000] min-w-[180px] overflow-hidden rounded-md border border-[color:var(--wisp-hairline-strong)] bg-[color:var(--wisp-bg-2)] py-1 shadow-xl"
            style={{ top: menuPos.top, left: menuPos.left }}
            onClick={(e) => e.stopPropagation()}
          >
            <button
              type="button"
              role="menuitem"
              data-testid={`project-menu-favorite-${id}`}
              className="flex w-full items-center gap-2 px-3 py-1.5 text-left text-xs text-[color:var(--wisp-ink)] hover:bg-[color:var(--wisp-glass-hover)]"
              onClick={() => {
                onToggleFavorite();
                setMenuOpen(false);
              }}
            >
              <Star className="h-3.5 w-3.5" />
              {isFavorite
                ? t('projectMenu.unfavorite', 'Remove favorite')
                : t('projectMenu.favorite', 'Mark as favorite')}
            </button>
            <button
              type="button"
              role="menuitem"
              data-testid={`project-menu-delete-${id}`}
              className="flex w-full items-center gap-2 px-3 py-1.5 text-left text-xs text-[color:var(--rose)] hover:bg-[color:var(--wisp-glass-hover)]"
              onClick={() => {
                setMenuOpen(false);
                setDeleteOpen(true);
              }}
            >
              <Trash2 className="h-3.5 w-3.5" />
              {t('projectMenu.delete', 'Delete')}
            </button>
          </div>,
          document.body,
        )}
      <Dialog open={deleteOpen} onOpenChange={(o) => !deleting && setDeleteOpen(o)}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>{t('projectMenu.deleteConfirmTitle', 'Delete project?')}</DialogTitle>
            <DialogDescription>
              {t('projectMenu.deleteConfirmBody', {
                name,
                defaultValue:
                  '{{name}} will be permanently removed — runs, plans, and team configuration will be lost.',
              })}
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button variant="outline" onClick={() => setDeleteOpen(false)} disabled={deleting}>
              {t('projectMenu.deleteCancel', 'Cancel')}
            </Button>
            <Button
              variant="destructive"
              onClick={handleConfirmDelete}
              disabled={deleting}
              data-testid={`project-delete-confirm-${id}`}
            >
              {t('projectMenu.deleteConfirm', 'Delete')}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}

function RecentRuns({ projectId }: { projectId: string }) {
  const { t } = useTranslation();
  const runs = useProjectRuns(projectId);
  if (!runs.data || runs.data.length === 0) return null;
  const top = runs.data.slice(0, 3);
  return (
    <div className="ml-7 mr-2 flex flex-col gap-0.5 py-1" data-testid={`recent-runs-${projectId}`}>
      <span className="t-eyebrow px-2 py-1" style={{ fontSize: 10 }}>
        {t('navigation.recentRuns')}
      </span>
      {top.map((r) => (
        <Link
          key={r.id}
          to={`/projects/${projectId}/run/${r.id}`}
          className="flex items-center gap-2 rounded-md px-2 py-1 text-xs text-[color:var(--wisp-ink-3)] hover:bg-[color:var(--wisp-glass-hover)] hover:text-[color:var(--wisp-ink)]"
          data-testid={`recent-run-${r.id}`}
        >
          <span className="font-mono">{r.id.slice(0, 8)}</span>
          <span
            className={cn(
              'wisp-dot ml-auto',
              r.status === 'running' && 'coral pulse',
              r.status === 'paused' && 'amber',
              r.status === 'completed' && 'mint',
              r.status === 'failed' && 'rose',
              !['running', 'paused', 'completed', 'failed'].includes(r.status) && 'dim',
            )}
            style={{ width: 6, height: 6 }}
          />
        </Link>
      ))}
    </div>
  );
}
