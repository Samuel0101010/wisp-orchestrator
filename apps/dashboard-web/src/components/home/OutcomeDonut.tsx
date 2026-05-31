import { Cell, Pie, PieChart, ResponsiveContainer, Tooltip } from 'recharts';
import { useTranslation } from 'react-i18next';

export interface OutcomeDonutProps {
  counts: {
    success?: number;
    failure?: number;
    cancelled?: number;
    unknown?: number;
    budget_exceeded?: number;
  };
  height?: number;
}

const TONES = {
  success: 'hsl(var(--success))',
  failure: 'hsl(var(--destructive))',
  cancelled: 'hsl(var(--muted-foreground))',
  unknown: 'hsl(var(--warning))',
} as const;

export function OutcomeDonut({ counts, height = 220 }: OutcomeDonutProps) {
  const { t } = useTranslation();
  // A budget_exceeded run is a failure outcome (matches Home's classify()); fold
  // it into the failure bucket so the donut total matches the run count and the
  // run isn't silently dropped from the chart.
  const merged = { ...counts, failure: (counts.failure ?? 0) + (counts.budget_exceeded ?? 0) };
  const data = (Object.keys(TONES) as Array<keyof typeof TONES>)
    .map((k) => ({
      key: k,
      label: t(`home.outcomeDonut.labels.${k}`),
      value: merged[k] ?? 0,
      color: TONES[k],
    }))
    .filter((d) => d.value > 0);
  const total = data.reduce((sum, d) => sum + d.value, 0);

  if (total === 0) {
    return (
      <div
        className="flex items-center justify-center text-xs text-muted-foreground"
        style={{ height }}
      >
        {t('home.outcomeDonut.empty')}
      </div>
    );
  }

  // Stat-row 0-state: too few runs to read a donut, or one slice dominates.
  const dominant = data.reduce((max, d) => (d.value > max.value ? d : max), data[0]!);
  const dominantPct = dominant.value / total;
  if (total <= 5 || dominantPct > 0.9) {
    return (
      <div
        className="flex items-center text-sm"
        style={{ minHeight: height }}
        data-testid="outcome-stat-row"
      >
        <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
          <span className="inline-flex items-center gap-1.5">
            <span
              className="size-2 rounded-full"
              style={{ background: dominant.color }}
              aria-hidden
            />
            <span className="font-medium">{dominant.label}</span>
          </span>
          <span className="text-muted-foreground" aria-hidden>
            ·
          </span>
          <span className="text-muted-foreground tabular-nums">
            {t('home.outcomeDonut.statRow', '{{count}} of {{total}} ({{pct}}%)', {
              count: dominant.value,
              total,
              pct: Math.round(dominantPct * 100),
            })}
          </span>
        </div>
      </div>
    );
  }

  return (
    <div className="flex h-full items-center gap-6">
      <div style={{ width: '50%', height }}>
        <ResponsiveContainer width="100%" height="100%">
          <PieChart>
            <Pie
              data={data}
              dataKey="value"
              nameKey="label"
              innerRadius="60%"
              outerRadius="92%"
              paddingAngle={2}
              stroke="hsl(var(--card))"
              strokeWidth={2}
              isAnimationActive={false}
            >
              {data.map((d) => (
                <Cell key={d.key} fill={d.color} />
              ))}
            </Pie>
            <Tooltip
              contentStyle={{
                background: 'hsl(var(--popover))',
                border: '1px solid hsl(var(--border))',
                borderRadius: 'var(--radius)',
                fontSize: 12,
              }}
              formatter={(value, name) => {
                const v = Number(value);
                return [`${v} (${Math.round((v / total) * 100)}%)`, String(name)];
              }}
            />
          </PieChart>
        </ResponsiveContainer>
      </div>
      <ul className="flex flex-1 flex-col gap-2 text-sm">
        {data.map((d) => (
          <li key={d.key} className="flex items-center gap-2">
            <span
              className="inline-block h-2.5 w-2.5 rounded-sm"
              style={{ background: d.color }}
              aria-hidden
            />
            <span className="flex-1 text-muted-foreground">{d.label}</span>
            <span className="tabular-nums">{d.value}</span>
            <span className="w-10 text-right tabular-nums text-muted-foreground">
              {Math.round((d.value / total) * 100)}%
            </span>
          </li>
        ))}
      </ul>
    </div>
  );
}
