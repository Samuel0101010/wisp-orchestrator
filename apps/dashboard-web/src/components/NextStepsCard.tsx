import { useTranslation } from 'react-i18next';
import { useNavigate } from 'react-router-dom';
import { ArrowRight, Check } from 'lucide-react';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { useInterview, useTeam } from '@/api/queries';

interface NextStepsCardProps {
  projectId: string;
  planStatus: string | undefined;
  /** Switch the ProjectDetail tab (brief / plan). Team Builder is a route. */
  onGoToTab: (tab: string) => void;
}

/**
 * A small guided checklist shown above the project tabs while the project is
 * still being set up: finish the brief → configure the team → generate the
 * plan. Each incomplete step has a button that jumps straight to the right
 * place. Disappears once all three are done, so it never clutters an active
 * project. This is the "what do I do next" affordance a first-timer needs.
 */
export function NextStepsCard({ projectId, planStatus, onGoToTab }: NextStepsCardProps) {
  const { t } = useTranslation();
  const navigate = useNavigate();
  const interview = useInterview(projectId);
  const team = useTeam(projectId);

  const briefReady = interview.data?.brief?.briefReady ?? false;
  const teamReady = (team.data?.roles?.length ?? 0) > 0;
  const hasPlan = Boolean(planStatus);

  // Setup complete — get out of the way.
  if (briefReady && teamReady && hasPlan) return null;

  const steps = [
    {
      key: 'brief',
      done: briefReady,
      label: t('nextSteps.brief'),
      desc: t('nextSteps.briefDesc'),
      go: () => onGoToTab('brief'),
    },
    {
      key: 'team',
      done: teamReady,
      label: t('nextSteps.team'),
      desc: t('nextSteps.teamDesc'),
      go: () => navigate(`/projects/${projectId}/teams`),
    },
    {
      key: 'plan',
      done: hasPlan,
      label: t('nextSteps.plan'),
      desc: t('nextSteps.planDesc'),
      go: () => onGoToTab('plan'),
    },
  ];

  return (
    <Card data-testid="next-steps-card">
      <CardHeader className="pb-2">
        <CardTitle className="text-sm font-medium">{t('nextSteps.title')}</CardTitle>
        <p className="text-xs text-muted-foreground">{t('nextSteps.subtitle')}</p>
      </CardHeader>
      <CardContent className="flex flex-col gap-2">
        {steps.map((s, i) => (
          <div
            key={s.key}
            className="flex items-center gap-3 rounded-md border p-2"
            data-testid={`next-step-${s.key}`}
          >
            <div
              className={
                'flex h-6 w-6 shrink-0 items-center justify-center rounded-full text-2xs font-medium ' +
                (s.done
                  ? 'bg-emerald-500/15 text-emerald-600 dark:text-emerald-400'
                  : 'bg-muted text-muted-foreground')
              }
            >
              {s.done ? <Check className="h-3.5 w-3.5" /> : i + 1}
            </div>
            <div className="min-w-0 flex-1">
              <p
                className={
                  'text-xs font-medium ' + (s.done ? 'text-muted-foreground line-through' : '')
                }
              >
                {s.label}
              </p>
              {!s.done && <p className="text-2xs text-muted-foreground">{s.desc}</p>}
            </div>
            {s.done ? (
              <span className="shrink-0 text-2xs text-emerald-600 dark:text-emerald-400">
                {t('nextSteps.done')}
              </span>
            ) : (
              <Button
                type="button"
                size="sm"
                variant="outline"
                className="h-7 shrink-0 px-2 text-xs"
                onClick={s.go}
                aria-label={t('nextSteps.openAria', { step: s.label })}
                data-testid={`next-step-${s.key}-go`}
              >
                {t('nextSteps.open')}
                <ArrowRight className="ml-1 h-3 w-3" />
              </Button>
            )}
          </div>
        ))}
      </CardContent>
    </Card>
  );
}
