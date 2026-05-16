import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import {
  Bot,
  Database,
  FileEdit,
  History,
  Layers,
  ListChecks,
  MessageSquare,
  Moon,
  Sparkles,
  Sun,
  Folder,
} from 'lucide-react';
import { ApiError, apiFetch } from '@/api/client';
import {
  useDeleteProject,
  useProjects,
  usePromptBundles,
  type AgentOverrideRow,
  type ChangeRequestRow,
  type DodCriterion,
  type ProjectRunRow,
  type PromptBundleRow,
} from '@/api/queries';
import type { Agent, AgentThread, Project } from '@wisp/schemas';
import { Button } from '@/components/ui/button';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { LanguageToggle } from '@/components/LanguageToggle';
import { toast } from '@/components/ui/use-toast';
import { useUiStore } from '@/store/ui';
import { cn } from '@/lib/utils';

/* Bounded concurrency runner — caps parallel deletes at MAX so the local
   server doesn't choke when clearing categories with 100+ entries. */
async function runPool<T>(items: T[], max: number, fn: (item: T) => Promise<void>): Promise<void> {
  let i = 0;
  const workers = Array.from({ length: Math.min(max, items.length) }, async () => {
    while (i < items.length) {
      const idx = i++;
      const item = items[idx];
      if (item !== undefined) await fn(item);
    }
  });
  await Promise.all(workers);
}

type CategoryKey =
  | 'projects'
  | 'chats'
  | 'agents'
  | 'bundles'
  | 'overrides'
  | 'changeRequests'
  | 'dod'
  | 'insights'
  | 'runs';

interface CategoryRowProps {
  category: CategoryKey;
  icon: React.ReactNode;
  count: number | null;
  isLoading: boolean;
  onClear: () => Promise<void>;
  /** When true, the action button is hidden and `note` is shown instead. */
  readOnly?: boolean;
  note?: string;
}

function CategoryRow({
  category,
  icon,
  count,
  isLoading,
  onClear,
  readOnly,
  note,
}: CategoryRowProps): React.ReactElement {
  const { t } = useTranslation();
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const categoryLabel = t(`settings.data.categories.${category}`);
  const display = isLoading ? '—' : (count ?? 0);
  const disabled = readOnly || isLoading || (count ?? 0) === 0;
  const emptyTitle = t('settings.data.toasts.alreadyEmpty', { category: categoryLabel });

  const handleConfirm = async (): Promise<void> => {
    setBusy(true);
    try {
      await onClear();
      toast({ title: t('settings.data.toasts.cleared', { category: categoryLabel }) });
      setOpen(false);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      toast({
        title: t('settings.data.toasts.clearFailed', { category: categoryLabel }),
        description: message,
        variant: 'destructive',
      });
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="flex items-center gap-3 py-2.5" data-testid={`settings-category-${category}`}>
      <div
        className="flex shrink-0 items-center justify-center"
        style={{
          width: 32,
          height: 32,
          borderRadius: 10,
          background: 'var(--wisp-glass-strong)',
          border: '1px solid var(--wisp-hairline-strong)',
          color: 'var(--wisp-ink-2)',
        }}
        aria-hidden
      >
        {icon}
      </div>
      <div className="min-w-0 flex-1">
        <div className="flex items-baseline gap-2">
          <span style={{ fontFamily: 'var(--f-head)', fontSize: 14, fontWeight: 500 }}>
            {categoryLabel}
          </span>
          <span className="t-mono t-faint" style={{ fontSize: 11 }}>
            {display}
          </span>
        </div>
        {readOnly && note && (
          <div className="t-faint mt-0.5" style={{ fontSize: 11 }}>
            {note}
          </div>
        )}
      </div>
      {!readOnly && (
        <Button
          variant="destructive"
          size="sm"
          disabled={disabled}
          onClick={() => setOpen(true)}
          aria-label={disabled ? emptyTitle : t('settings.data.actions.clearAll')}
          title={disabled ? emptyTitle : t('settings.data.actions.clearAll')}
          data-testid={`settings-clear-${category}`}
        >
          {t('settings.data.actions.clearAll')}
        </Button>
      )}
      <Dialog open={open} onOpenChange={(o) => !busy && setOpen(o)}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>
              {t('settings.data.confirm.title', { category: categoryLabel })}
            </DialogTitle>
            <DialogDescription>
              {t('settings.data.confirm.body', {
                category: categoryLabel,
                count: count ?? 0,
              })}
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button variant="outline" onClick={() => setOpen(false)} disabled={busy}>
              {t('settings.data.confirm.cancel')}
            </Button>
            <Button
              variant="destructive"
              onClick={handleConfirm}
              disabled={busy}
              data-testid={`settings-confirm-${category}`}
            >
              {busy ? t('settings.data.actions.clearing') : t('settings.data.confirm.confirm')}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}

interface SwitchRowProps {
  label: string;
  checked: boolean;
  onChange: (next: boolean) => void;
  testId?: string;
}

/* Inline switch — matches the design system's segment/toggle visual rather
   than introducing a new shadcn dep. Uses tokens only (no inline hex). */
function SwitchRow({ label, checked, onChange, testId }: SwitchRowProps): React.ReactElement {
  return (
    <div className="flex items-center justify-between py-2">
      <span style={{ fontFamily: 'var(--f-head)', fontSize: 14 }}>{label}</span>
      <button
        type="button"
        role="switch"
        aria-checked={checked}
        onClick={() => onChange(!checked)}
        data-testid={testId}
        className="relative inline-flex items-center transition-colors"
        style={{
          width: 36,
          height: 20,
          borderRadius: 999,
          border: '1px solid var(--wisp-hairline-strong)',
          background: checked ? 'var(--coral)' : 'var(--wisp-glass)',
          cursor: 'pointer',
        }}
      >
        <span
          className="block transition-transform"
          style={{
            width: 14,
            height: 14,
            borderRadius: '50%',
            background: 'var(--wisp-ink)',
            transform: checked ? 'translateX(18px)' : 'translateX(3px)',
          }}
        />
      </button>
    </div>
  );
}

/* ---------- count queries -------------------------------------------------- */
/* These mirror the queries.ts pattern but stay inline because nothing else in
   the app needs an aggregate "count" view — keeping them here matches the
   "don't expand queries.ts for a single call site" rule. */

function useAgentsAll() {
  return useQuery<Agent[]>({
    queryKey: ['settings-count', 'agents-all'],
    queryFn: async () => {
      try {
        return await apiFetch<Agent[]>('/api/agents');
      } catch {
        return [];
      }
    },
  });
}

function useAllAgentOverrides(projects: Project[]) {
  return useQuery<AgentOverrideRow[]>({
    queryKey: ['settings-count', 'overrides', projects.map((p) => p.id)],
    enabled: projects.length > 0,
    queryFn: async () => {
      const lists = await Promise.all(
        projects.map(async (p) => {
          try {
            return await apiFetch<AgentOverrideRow[]>(`/api/projects/${p.id}/agent-overrides`);
          } catch {
            return [] as AgentOverrideRow[];
          }
        }),
      );
      return lists.flat();
    },
  });
}

function useAllChangeRequests(projects: Project[]) {
  return useQuery<Array<{ projectId: string; id: string }>>({
    queryKey: ['settings-count', 'change-requests', projects.map((p) => p.id)],
    enabled: projects.length > 0,
    queryFn: async () => {
      const lists = await Promise.all(
        projects.map(async (p) => {
          try {
            const rows = await apiFetch<ChangeRequestRow[]>(
              `/api/projects/${p.id}/change-requests`,
            );
            return rows.map((r) => ({ projectId: p.id, id: r.id }));
          } catch {
            return [];
          }
        }),
      );
      return lists.flat();
    },
  });
}

function useAllDod(projects: Project[]) {
  return useQuery<Array<{ projectId: string; id: string }>>({
    queryKey: ['settings-count', 'dod', projects.map((p) => p.id)],
    enabled: projects.length > 0,
    queryFn: async () => {
      const lists = await Promise.all(
        projects.map(async (p) => {
          try {
            const rows = await apiFetch<DodCriterion[]>(`/api/projects/${p.id}/dod`);
            return rows.map((r) => ({ projectId: p.id, id: r.id }));
          } catch {
            return [];
          }
        }),
      );
      return lists.flat();
    },
  });
}

/* Trajectories are the only Insights category with a DELETE endpoint server-side.
   Run-summaries and router-priors are GET-only — so the count and clear scope
   stay on trajectories. */
interface TrajectoryRow {
  id: string;
}
function useTrajectories() {
  return useQuery<TrajectoryRow[]>({
    queryKey: ['settings-count', 'insights-trajectories'],
    queryFn: async () => {
      try {
        return await apiFetch<TrajectoryRow[]>('/api/insights/trajectories');
      } catch {
        return [];
      }
    },
  });
}

function useAllChatThreads(agents: Agent[]) {
  return useQuery<AgentThread[]>({
    queryKey: ['settings-count', 'chat-threads', agents.map((a) => a.id)],
    enabled: agents.length > 0,
    queryFn: async () => {
      const lists = await Promise.all(
        agents.map(async (a) => {
          try {
            return await apiFetch<AgentThread[]>(`/api/agents/${a.id}/threads`);
          } catch {
            return [] as AgentThread[];
          }
        }),
      );
      return lists.flat();
    },
  });
}

function useAllRuns(projects: Project[]) {
  return useQuery<ProjectRunRow[]>({
    queryKey: ['settings-count', 'runs', projects.map((p) => p.id)],
    enabled: projects.length > 0,
    queryFn: async () => {
      const lists = await Promise.all(
        projects.map(async (p) => {
          try {
            return await apiFetch<ProjectRunRow[]>(`/api/projects/${p.id}/runs`);
          } catch {
            return [] as ProjectRunRow[];
          }
        }),
      );
      return lists.flat();
    },
  });
}

/* ---------- page ----------------------------------------------------------- */

export function SettingsRoute(): React.ReactElement {
  const { t } = useTranslation();
  const qc = useQueryClient();

  const theme = useUiStore((s) => s.theme);
  const setTheme = useUiStore((s) => s.setTheme);
  const sidebarCollapsed = useUiStore((s) => s.sidebarCollapsed);
  const setSidebarCollapsed = useUiStore((s) => s.setSidebarCollapsed);

  const projectsQ = useProjects();
  const projects = projectsQ.data ?? [];

  const agentsAllQ = useAgentsAll();
  const allAgents = agentsAllQ.data ?? [];
  /* "Custom" = agents the user created (no seedKey). Seed agents are the
     built-in dev team and must never be cleared from here. */
  const customAgents = allAgents.filter((a) => !a.seedKey);

  const bundlesQ = usePromptBundles();
  const bundles = bundlesQ.data ?? [];

  const overridesQ = useAllAgentOverrides(projects);
  const changeRequestsQ = useAllChangeRequests(projects);
  const dodQ = useAllDod(projects);
  const trajectoriesQ = useTrajectories();
  const threadsQ = useAllChatThreads(allAgents);
  const runsQ = useAllRuns(projects);

  const deleteProject = useDeleteProject();

  /* clear handlers — each invalidates only the queries it just nuked so the
     count drops to 0 immediately after the toast fires. */
  const clearProjects = async (): Promise<void> => {
    await runPool(projects, 5, (p) => deleteProject.mutateAsync(p.id));
    await qc.invalidateQueries({ queryKey: ['projects'] });
    await qc.invalidateQueries({ queryKey: ['settings-count'] });
  };

  const clearChats = async (): Promise<void> => {
    const threads = threadsQ.data ?? [];
    await runPool(threads, 5, async (th) => {
      await apiFetch<void>(`/api/threads/${th.id}`, { method: 'DELETE' });
    });
    await qc.invalidateQueries({ queryKey: ['settings-count', 'chat-threads'] });
  };

  const clearAgents = async (): Promise<void> => {
    await runPool(customAgents, 5, async (a) => {
      try {
        await apiFetch<void>(`/api/agents/${a.id}?force=1`, { method: 'DELETE' });
      } catch (err) {
        if (err instanceof ApiError && err.status === 404) return;
        throw err;
      }
    });
    await qc.invalidateQueries({ queryKey: ['agents'] });
    await qc.invalidateQueries({ queryKey: ['settings-count', 'agents-all'] });
  };

  const clearBundles = async (): Promise<void> => {
    await runPool(bundles, 5, async (b: PromptBundleRow) => {
      await apiFetch<void>(`/api/prompt-bundles/${encodeURIComponent(b.bundleKey)}`, {
        method: 'DELETE',
      });
    });
    await qc.invalidateQueries({ queryKey: ['prompt-bundles'] });
  };

  const clearOverrides = async (): Promise<void> => {
    const rows = overridesQ.data ?? [];
    await runPool(rows, 5, async (r) => {
      await apiFetch<void>(
        `/api/projects/${r.projectId}/agent-overrides/${encodeURIComponent(r.role)}`,
        { method: 'DELETE' },
      );
    });
    await qc.invalidateQueries({ queryKey: ['settings-count', 'overrides'] });
    await qc.invalidateQueries({ queryKey: ['agent-overrides'] });
  };

  const clearChangeRequests = async (): Promise<void> => {
    const rows = changeRequestsQ.data ?? [];
    await runPool(rows, 5, async (r) => {
      await apiFetch<void>(`/api/projects/${r.projectId}/change-requests/${r.id}`, {
        method: 'DELETE',
      });
    });
    await qc.invalidateQueries({ queryKey: ['settings-count', 'change-requests'] });
    await qc.invalidateQueries({ queryKey: ['change-requests'] });
  };

  const clearDod = async (): Promise<void> => {
    const rows = dodQ.data ?? [];
    await runPool(rows, 5, async (r) => {
      await apiFetch<void>(`/api/projects/${r.projectId}/dod/${r.id}`, { method: 'DELETE' });
    });
    await qc.invalidateQueries({ queryKey: ['settings-count', 'dod'] });
    await qc.invalidateQueries({ queryKey: ['dod'] });
  };

  const clearInsights = async (): Promise<void> => {
    const rows = trajectoriesQ.data ?? [];
    await runPool(rows, 5, async (r) => {
      await apiFetch<void>(`/api/insights/trajectories/${r.id}`, { method: 'DELETE' });
    });
    await qc.invalidateQueries({ queryKey: ['settings-count', 'insights-trajectories'] });
  };

  const noop = async (): Promise<void> => {
    /* runs are read-only — no DELETE endpoint exists. */
  };

  return (
    <div className="wisp-fade-up flex flex-col gap-5" data-testid="settings-route">
      <header className="min-w-0">
        <div className="t-eyebrow mb-1">{t('navigation.settings')}</div>
        <h1
          className="m-0"
          style={{
            fontFamily: 'var(--f-display)',
            fontSize: 44,
            fontWeight: 400,
            letterSpacing: '-0.02em',
            lineHeight: 1.08,
          }}
        >
          {t('settings.title')}
        </h1>
        <div className="mt-1.5 max-w-2xl text-sm text-[color:var(--wisp-ink-3)]">
          {t('settings.subtitle')}
        </div>
      </header>

      {/* --- A. Appearance ------------------------------------------------ */}
      <section className="wisp-card" data-testid="settings-appearance">
        <div className="t-eyebrow mb-3">{t('settings.appearance.title')}</div>
        <div className="flex items-center justify-between py-2">
          <span style={{ fontFamily: 'var(--f-head)', fontSize: 14 }}>
            {t('settings.appearance.theme')}
          </span>
          <div className="wisp-segment" role="group" aria-label={t('settings.appearance.theme')}>
            <button
              type="button"
              className={cn(theme === 'dark' && 'on')}
              onClick={() => setTheme('dark')}
              data-testid="settings-theme-dark"
            >
              <Moon className="h-3.5 w-3.5" />
              {t('settings.appearance.themeDark')}
            </button>
            <button
              type="button"
              className={cn(theme === 'light' && 'on')}
              onClick={() => setTheme('light')}
              data-testid="settings-theme-light"
            >
              <Sun className="h-3.5 w-3.5" />
              {t('settings.appearance.themeLight')}
            </button>
          </div>
        </div>
        <div className="flex items-center justify-between py-2">
          <span style={{ fontFamily: 'var(--f-head)', fontSize: 14 }}>
            {t('settings.appearance.language')}
          </span>
          <LanguageToggle />
        </div>
      </section>

      {/* --- B. Sidebar --------------------------------------------------- */}
      <section className="wisp-card" data-testid="settings-sidebar">
        <div className="t-eyebrow mb-3">{t('settings.sidebar.title')}</div>
        <SwitchRow
          label={t('settings.sidebar.collapsed')}
          checked={sidebarCollapsed}
          onChange={setSidebarCollapsed}
          testId="settings-sidebar-collapsed"
        />
      </section>

      {/* --- C. Manage data ---------------------------------------------- */}
      <section className="wisp-card" data-testid="settings-data">
        <div className="t-eyebrow mb-1.5">{t('settings.data.title')}</div>
        <div className="t-dim mb-3 max-w-2xl" style={{ fontSize: 13 }}>
          {t('settings.data.explanation')}
        </div>
        <div className="flex flex-col divide-y divide-[color:var(--wisp-hairline)]">
          <CategoryRow
            category="projects"
            icon={<Folder className="h-4 w-4" />}
            count={projects.length}
            isLoading={projectsQ.isLoading}
            onClear={clearProjects}
          />
          <CategoryRow
            category="chats"
            icon={<MessageSquare className="h-4 w-4" />}
            count={threadsQ.data?.length ?? null}
            isLoading={threadsQ.isLoading || agentsAllQ.isLoading}
            onClear={clearChats}
          />
          <CategoryRow
            category="agents"
            icon={<Bot className="h-4 w-4" />}
            count={customAgents.length}
            isLoading={agentsAllQ.isLoading}
            onClear={clearAgents}
          />
          <CategoryRow
            category="bundles"
            icon={<Database className="h-4 w-4" />}
            count={bundles.length}
            isLoading={bundlesQ.isLoading}
            onClear={clearBundles}
          />
          <CategoryRow
            category="overrides"
            icon={<FileEdit className="h-4 w-4" />}
            count={overridesQ.data?.length ?? null}
            isLoading={overridesQ.isLoading || projectsQ.isLoading}
            onClear={clearOverrides}
          />
          <CategoryRow
            category="changeRequests"
            icon={<Layers className="h-4 w-4" />}
            count={changeRequestsQ.data?.length ?? null}
            isLoading={changeRequestsQ.isLoading || projectsQ.isLoading}
            onClear={clearChangeRequests}
          />
          <CategoryRow
            category="dod"
            icon={<ListChecks className="h-4 w-4" />}
            count={dodQ.data?.length ?? null}
            isLoading={dodQ.isLoading || projectsQ.isLoading}
            onClear={clearDod}
          />
          <CategoryRow
            category="insights"
            icon={<Sparkles className="h-4 w-4" />}
            count={trajectoriesQ.data?.length ?? null}
            isLoading={trajectoriesQ.isLoading}
            onClear={clearInsights}
          />
          <CategoryRow
            category="runs"
            icon={<History className="h-4 w-4" />}
            count={runsQ.data?.length ?? null}
            isLoading={runsQ.isLoading || projectsQ.isLoading}
            onClear={noop}
            readOnly
            note={t('settings.data.notes.runs')}
          />
        </div>
      </section>
    </div>
  );
}
