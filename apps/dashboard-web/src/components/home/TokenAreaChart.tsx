import {
  Area,
  AreaChart,
  CartesianGrid,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from 'recharts';

export interface TokenAreaChartProps {
  data: Array<{ day: string; tokens: number }>;
  height?: number;
}

function formatDay(day: string): string {
  // Input: 2026-05-07 → "May 7". Locale-aware short label.
  const d = new Date(day + 'T00:00:00Z');
  if (Number.isNaN(d.getTime())) return day;
  return d.toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
}

function formatTokens(n: number): string {
  if (n < 1000) return String(n);
  if (n < 10_000) return `${(n / 1000).toFixed(1)}k`;
  if (n < 1_000_000) return `${Math.round(n / 1000)}k`;
  return `${(n / 1_000_000).toFixed(1)}M`;
}

/** Token throughput area chart. Themed via CSS vars so dark/light theme switches automatically. */
export function TokenAreaChart({ data, height = 220 }: TokenAreaChartProps) {
  return (
    <ResponsiveContainer width="100%" height={height}>
      <AreaChart data={data} margin={{ top: 8, right: 4, bottom: 0, left: 0 }}>
        <defs>
          <linearGradient id="tokenAreaFill" x1="0" y1="0" x2="0" y2="1">
            <stop offset="0%" stopColor="hsl(var(--info))" stopOpacity={0.5} />
            <stop offset="100%" stopColor="hsl(var(--info))" stopOpacity={0.02} />
          </linearGradient>
        </defs>
        <CartesianGrid strokeDasharray="3 3" stroke="hsl(var(--border))" vertical={false} />
        <XAxis
          dataKey="day"
          tickFormatter={formatDay}
          stroke="hsl(var(--muted-foreground))"
          tick={{ fontSize: 11 }}
          axisLine={false}
          tickLine={false}
        />
        <YAxis
          stroke="hsl(var(--muted-foreground))"
          tick={{ fontSize: 11 }}
          tickFormatter={formatTokens}
          axisLine={false}
          tickLine={false}
          width={40}
        />
        <Tooltip
          contentStyle={{
            background: 'hsl(var(--popover))',
            border: '1px solid hsl(var(--border))',
            borderRadius: 'var(--radius)',
            fontSize: 12,
          }}
          labelStyle={{ color: 'hsl(var(--muted-foreground))' }}
          itemStyle={{ color: 'hsl(var(--foreground))' }}
          labelFormatter={(label) => formatDay(String(label))}
          formatter={(value) => [formatTokens(Number(value)), 'tokens']}
        />
        <Area
          type="monotone"
          dataKey="tokens"
          stroke="hsl(var(--info))"
          strokeWidth={2}
          fill="url(#tokenAreaFill)"
          isAnimationActive={false}
        />
      </AreaChart>
    </ResponsiveContainer>
  );
}
