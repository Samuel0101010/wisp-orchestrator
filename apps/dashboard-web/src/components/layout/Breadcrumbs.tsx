import { Fragment } from 'react';
import { Link, useMatch } from 'react-router-dom';
import { ChevronRight, LayoutGrid } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { useProject } from '@/api/queries';
import { cn } from '@/lib/utils';

interface Crumb {
  to?: string;
  label: React.ReactNode;
  icon?: React.ReactNode;
}

/**
 * URL-pattern-based breadcrumbs. Resolves project id → name via React Query
 * so the project page reads "Mission Control / <project name>" rather than
 * exposing the raw uuid.
 */
export function Breadcrumbs({ className }: { className?: string }) {
  const { t } = useTranslation();
  const projectMatch = useMatch('/projects/:projectId/*');
  const teamMatch = useMatch('/projects/:projectId/teams');
  const planMatch = useMatch('/projects/:projectId/plan');
  const runMatch = useMatch('/projects/:projectId/run/:runId');
  const projectId = projectMatch?.params.projectId;
  const project = useProject(projectId);

  const crumbs: Crumb[] = [
    {
      to: '/',
      label: t('topBar.missionControl'),
      icon: <LayoutGrid className="h-3.5 w-3.5" />,
    },
  ];

  if (projectId) {
    crumbs.push({
      to: `/projects/${projectId}`,
      label: project.data?.name ?? t('breadcrumbs.project', 'Project'),
    });
  }
  if (teamMatch) crumbs.push({ label: t('breadcrumbs.teamBuilder', 'Team Builder') });
  if (planMatch) crumbs.push({ label: t('breadcrumbs.planEditor', 'Plan Editor') });
  if (runMatch)
    crumbs.push({
      label: (
        <span className="font-mono text-xs">
          {t('breadcrumbs.run', 'Run')} {runMatch.params.runId?.slice(0, 8)}
        </span>
      ),
    });

  return (
    <nav
      aria-label="breadcrumb"
      className={cn('flex items-center gap-1.5 text-sm', className)}
      data-testid="breadcrumbs"
    >
      {crumbs.map((c, i) => {
        const isLast = i === crumbs.length - 1;
        return (
          <Fragment key={i}>
            {i > 0 && <ChevronRight className="h-3.5 w-3.5 text-muted-foreground/50" aria-hidden />}
            {c.to && !isLast ? (
              <Link
                to={c.to}
                className="inline-flex items-center gap-1.5 text-muted-foreground hover:text-foreground"
              >
                {c.icon}
                {c.label}
              </Link>
            ) : (
              <span
                className={cn(
                  'inline-flex items-center gap-1.5',
                  isLast ? 'font-medium text-foreground' : 'text-muted-foreground',
                )}
              >
                {c.icon}
                {c.label}
              </span>
            )}
          </Fragment>
        );
      })}
    </nav>
  );
}
