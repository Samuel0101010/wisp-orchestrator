import { useMemo } from 'react';
import { useTranslation } from 'react-i18next';
import type { Team } from '@wisp/schemas';
import { MODEL_INFO } from '@/data/modelInfo';
import { useProjectRuns } from '@/api/queries';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';

interface Props {
  team: Team;
  projectId: string | undefined;
}

/**
 * Back-of-envelope token-usage projection. We don't bill per-token in
 * subscription mode, so this surfaces the relative weight of the team
 * configuration (a 4-opus team will burn quota much faster than 4-haiku) and,
 * when prior runs exist for the project, an empirical projection.
 *
 * Honest about its limits: zero data → only the cost-weight readout. With
 * prior runs → mean tokens/role × team size.
 */
export function CostEstimatePanel({ team, projectId }: Props) {
  const { t } = useTranslation();
  const { data } = useProjectRuns(projectId);
  // Defensive: a misbehaving server (or a test mock) could return non-array
  // payloads. Normalize to an array before filter() to avoid crashing the
  // panel for what is purely a hint UI.
  const runs = Array.isArray(data) ? data : [];

  const completed = useMemo(
    () =>
      runs.filter(
        (r) => r.outcome === 'success' && r.tokensInTotal != null && r.tokensOutTotal != null,
      ),
    [runs],
  );

  const sumWeight = team.roles.reduce((acc, r) => acc + MODEL_INFO[r.model].costWeight, 0);
  const avgWeight = team.roles.length > 0 ? sumWeight / team.roles.length : 0;
  const weightLabel =
    avgWeight >= 15 ? 'high' : avgWeight >= 6 ? 'medium' : avgWeight >= 2 ? 'low' : 'minimal';

  let avgTokens: number | null = null;
  if (completed.length > 0) {
    const total = completed.reduce(
      (acc, r) => acc + (r.tokensInTotal ?? 0) + (r.tokensOutTotal ?? 0),
      0,
    );
    avgTokens = Math.round(total / completed.length);
  }

  return (
    <Card>
      <CardHeader>
        <CardTitle className="text-base">{t('costPanel.title')}</CardTitle>
        <CardDescription>{t('costPanel.description')}</CardDescription>
      </CardHeader>
      <CardContent className="flex flex-col gap-2 text-sm">
        <div className="flex items-center justify-between">
          <span className="text-muted-foreground">{t('costPanel.teamWeight')}</span>
          <span className="font-medium tabular-nums" data-testid="cost-weight">
            {sumWeight} ({weightLabel})
          </span>
        </div>
        <div className="flex items-center justify-between">
          <span className="text-muted-foreground">{t('costPanel.roles')}</span>
          <span className="tabular-nums">
            {team.roles.map((r) => `${r.role}=${MODEL_INFO[r.model].costWeight}`).join(', ')}
          </span>
        </div>
        {avgTokens != null ? (
          <div className="flex items-center justify-between border-t pt-2">
            <span className="text-muted-foreground">
              {t('costPanel.avgTokens', { count: completed.length })}
            </span>
            <span className="font-medium tabular-nums" data-testid="cost-avg-tokens">
              {avgTokens.toLocaleString()} {t('costPanel.tokens')}
            </span>
          </div>
        ) : (
          <p className="text-xs text-muted-foreground">{t('costPanel.noData')}</p>
        )}
      </CardContent>
    </Card>
  );
}
