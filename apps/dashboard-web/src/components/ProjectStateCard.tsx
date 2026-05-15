import { useTranslation } from 'react-i18next';
import { AlertTriangle, CheckCheck, History, ListTodo } from 'lucide-react';
import { useProjectState } from '@/api/queries';
import { Badge } from '@/components/ui/badge';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';

interface ProjectStateCardProps {
  projectId: string;
}

/**
 * Renders the latest `project_states` row for this project. Shows nothing
 * when the project has never produced one (first run hasn't run yet, or
 * the runtime-verifier didn't emit `docs/project-state.md`). The card is
 * the planner's eye-level view of "where the project stands today" — it
 * matches the data the iteration planner consumes.
 */
export function ProjectStateCard({ projectId }: ProjectStateCardProps) {
  const { t } = useTranslation();
  const q = useProjectState(projectId);
  const state = q.data?.state;
  if (!state) return null;

  return (
    <Card data-testid="project-state-card">
      <CardHeader className="pb-2">
        <CardTitle className="flex items-center gap-2 text-sm font-medium">
          <History className="h-4 w-4 text-muted-foreground" />
          {t('projectState.title')}
          <Badge variant="secondary" className="text-2xs">
            {new Date(state.createdAt).toLocaleString()}
          </Badge>
        </CardTitle>
        <CardDescription className="text-xs">{t('projectState.description')}</CardDescription>
      </CardHeader>
      <CardContent className="grid gap-3 md:grid-cols-3">
        <Column
          icon={<CheckCheck className="h-3.5 w-3.5 text-emerald-500" />}
          label={t('projectState.implementedFeatures')}
          items={state.completedFeatures}
          testid="project-state-implemented"
          emptyKey="projectState.empty.implemented"
        />
        <Column
          icon={<ListTodo className="h-3.5 w-3.5 text-amber-500" />}
          label={t('projectState.openTodos')}
          items={state.openTodos}
          testid="project-state-todos"
          emptyKey="projectState.empty.todos"
        />
        <Column
          icon={<AlertTriangle className="h-3.5 w-3.5 text-red-500" />}
          label={t('projectState.knownIssues')}
          items={state.knownIssues}
          testid="project-state-issues"
          emptyKey="projectState.empty.issues"
        />
      </CardContent>
    </Card>
  );
}

interface ColumnProps {
  icon: React.ReactNode;
  label: string;
  items: string[];
  testid: string;
  emptyKey: string;
}

function Column({ icon, label, items, testid, emptyKey }: ColumnProps) {
  const { t } = useTranslation();
  return (
    <div className="flex flex-col gap-1.5" data-testid={testid}>
      <p className="flex items-center gap-1.5 text-2xs font-medium uppercase tracking-wide text-muted-foreground">
        {icon}
        {label}
        <span className="font-mono text-muted-foreground/70">({items.length})</span>
      </p>
      {items.length === 0 ? (
        <p className="text-xs italic text-muted-foreground/70">{t(emptyKey)}</p>
      ) : (
        <ul className="flex list-disc flex-col gap-0.5 pl-4 text-xs leading-snug">
          {items.slice(0, 8).map((it, i) => (
            <li key={`${testid}-${i}`}>{it}</li>
          ))}
          {items.length > 8 ? (
            <li className="list-none text-2xs text-muted-foreground">
              {t('projectState.more', { count: items.length - 8 })}
            </li>
          ) : null}
        </ul>
      )}
    </div>
  );
}
