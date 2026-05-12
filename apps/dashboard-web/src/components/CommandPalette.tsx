import { useEffect, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { Command } from 'cmdk';
import {
  Activity,
  ArrowRight,
  FolderOpen,
  LayoutGrid,
  Moon,
  Play,
  Search,
  Sun,
} from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { useGlobalRuns, useProjects } from '@/api/queries';
import { useUiStore } from '@/store/ui';
import { StatusDotBadge } from '@/components/StatusDotBadge';
import { cn } from '@/lib/utils';

/**
 * Linear-style command palette. Open with ⌘K (Cmd on macOS, Ctrl elsewhere)
 * or via the topbar trigger. Filters across projects, recent runs, and
 * quick actions in one fuzzy list.
 */
export function CommandPalette() {
  const { t } = useTranslation();
  const navigate = useNavigate();
  const [open, setOpen] = useState(false);
  const [search, setSearch] = useState('');
  const projects = useProjects();
  const recentRuns = useGlobalRuns(50);
  const theme = useUiStore((s) => s.theme);
  const setTheme = useUiStore((s) => s.setTheme);

  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'k') {
        e.preventDefault();
        setOpen((o) => !o);
      }
      if (e.key === 'Escape') setOpen(false);
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);

  const close = (): void => {
    setOpen(false);
    setSearch('');
  };

  const go = (path: string): void => {
    close();
    navigate(path);
  };

  if (!open) return null;

  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-label={t('topBar.openCommandPalette')}
      className="fixed inset-0 z-50 flex items-start justify-center bg-background/60 px-4 pt-[18vh] backdrop-blur-sm animate-in fade-in"
      onClick={close}
      data-testid="command-palette-backdrop"
    >
      <Command
        className="w-full max-w-xl overflow-hidden rounded-xl border bg-popover text-popover-foreground shadow-2xl"
        loop
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-center gap-2 border-b px-3">
          <Search className="h-4 w-4 text-muted-foreground" />
          <Command.Input
            value={search}
            onValueChange={setSearch}
            placeholder={t('commandPalette.placeholder', 'Search projects, runs, actions…')}
            className={cn(
              'h-12 flex-1 bg-transparent text-sm outline-none placeholder:text-muted-foreground',
            )}
            data-testid="command-palette-input"
            autoFocus
          />
          <kbd className="hidden rounded border bg-muted px-1.5 py-0.5 text-2xs text-muted-foreground sm:inline">
            ESC
          </kbd>
        </div>

        <Command.List className="max-h-80 overflow-y-auto p-2">
          <Command.Empty className="py-6 text-center text-sm text-muted-foreground">
            {t('commandPalette.empty', 'No matches.')}
          </Command.Empty>

          <Command.Group
            heading={t('commandPalette.actions', 'Actions')}
            className="text-xs uppercase tracking-wide text-muted-foreground"
          >
            <PaletteItem
              onSelect={() => go('/')}
              icon={<LayoutGrid className="h-4 w-4" />}
              label={t('commandPalette.gotoMissionControl', 'Go to Mission Control')}
              shortcut="G H"
            />
            <PaletteItem
              onSelect={() => {
                close();
                setTheme(theme === 'dark' ? 'light' : 'dark');
              }}
              icon={theme === 'dark' ? <Sun className="h-4 w-4" /> : <Moon className="h-4 w-4" />}
              label={theme === 'dark' ? t('topBar.themeLight') : t('topBar.themeDark')}
            />
          </Command.Group>

          {(projects.data ?? []).length > 0 && (
            <Command.Group
              heading={t('commandPalette.projects', 'Projects')}
              className="mt-2 text-xs uppercase tracking-wide text-muted-foreground"
            >
              {(projects.data ?? []).map((p) => (
                <PaletteItem
                  key={p.id}
                  onSelect={() => go(`/projects/${p.id}`)}
                  icon={<FolderOpen className="h-4 w-4" />}
                  label={p.name}
                  description={p.goal}
                  value={`project ${p.name} ${p.goal}`}
                />
              ))}
            </Command.Group>
          )}

          {(recentRuns.data ?? []).length > 0 && (
            <Command.Group
              heading={t('commandPalette.runs', 'Recent runs')}
              className="mt-2 text-xs uppercase tracking-wide text-muted-foreground"
            >
              {(recentRuns.data ?? []).slice(0, 15).map((r) => (
                <PaletteItem
                  key={r.id}
                  onSelect={() => go(`/projects/${r.projectId}/run/${r.id}`)}
                  icon={
                    r.status === 'running' ? (
                      <Activity className="h-4 w-4 text-info" />
                    ) : (
                      <Play className="h-4 w-4" />
                    )
                  }
                  label={
                    <span className="flex items-center gap-2">
                      <span>{r.projectName}</span>
                      <span className="font-mono text-xs text-muted-foreground">
                        / {r.id.slice(0, 8)}
                      </span>
                    </span>
                  }
                  trailing={<StatusDotBadge status={r.status} pulse={r.status === 'running'} />}
                  value={`run ${r.projectName} ${r.id} ${r.status}`}
                />
              ))}
            </Command.Group>
          )}
        </Command.List>

        <div className="flex items-center justify-between border-t bg-muted/30 px-3 py-1.5 text-2xs uppercase tracking-wider text-muted-foreground">
          <span className="inline-flex items-center gap-1">
            <kbd className="rounded border bg-background px-1">↑</kbd>
            <kbd className="rounded border bg-background px-1">↓</kbd>
            <span>navigate</span>
          </span>
          <span className="inline-flex items-center gap-1">
            <kbd className="rounded border bg-background px-1">↵</kbd>
            <span>open</span>
          </span>
        </div>
      </Command>
    </div>
  );
}

interface PaletteItemProps {
  onSelect: () => void;
  icon: React.ReactNode;
  label: React.ReactNode;
  description?: string;
  shortcut?: string;
  trailing?: React.ReactNode;
  /** Custom search value used by cmdk's fuzzy filter. Defaults to label string. */
  value?: string;
}

function PaletteItem({
  onSelect,
  icon,
  label,
  description,
  shortcut,
  trailing,
  value,
}: PaletteItemProps) {
  return (
    <Command.Item
      onSelect={onSelect}
      value={value}
      className="flex cursor-pointer select-none items-center gap-3 rounded-md px-2 py-2 text-sm aria-selected:bg-accent aria-selected:text-accent-foreground"
    >
      <span className="text-muted-foreground">{icon}</span>
      <div className="flex flex-1 flex-col">
        <span className="text-foreground">{label}</span>
        {description && (
          <span className="line-clamp-1 text-xs text-muted-foreground">{description}</span>
        )}
      </div>
      {trailing}
      {shortcut && (
        <kbd className="rounded border bg-muted px-1.5 py-0.5 text-2xs uppercase text-muted-foreground">
          {shortcut}
        </kbd>
      )}
      <ArrowRight className="h-3 w-3 opacity-0 group-aria-selected:opacity-100" aria-hidden />
    </Command.Item>
  );
}
