import { type ReactNode } from 'react';
import { ArrowDownRight, ArrowUpRight } from 'lucide-react';
import { cn } from '@/lib/utils';
import { AnimatedCounter } from '@/components/AnimatedCounter';

export interface KpiTileProps {
  label: string;
  value: number;
  /** Custom value formatter — e.g. compact tokens, %, "4m 12s". Wraps the AnimatedCounter. */
  format?: (n: number) => string;
  /** Sub-label rendered under the headline number — small caption text. */
  caption?: ReactNode;
  /** Optional delta vs prior period. Positive renders up-arrow + success tone; negative renders down-arrow + warning. */
  delta?: number;
  /** Override the auto delta colour — pass 'positive' for success when delta is negative (e.g. duration shrinking is good). */
  deltaPolarity?: 'auto' | 'higher-is-better' | 'lower-is-better';
  /** Icon shown top-right. */
  icon?: ReactNode;
  /** Soft accent band on the left side (uses semantic tone). */
  tone?: 'info' | 'success' | 'warning' | 'destructive' | 'muted';
  className?: string;
  'data-testid'?: string;
}

const toneToBg: Record<NonNullable<KpiTileProps['tone']>, string> = {
  info: 'before:bg-info',
  success: 'before:bg-success',
  warning: 'before:bg-warning',
  destructive: 'before:bg-destructive',
  muted: 'before:bg-muted-foreground/40',
};

export function KpiTile({
  label,
  value,
  format,
  caption,
  delta,
  deltaPolarity = 'higher-is-better',
  icon,
  tone = 'muted',
  className,
  ...rest
}: KpiTileProps) {
  const showDelta = typeof delta === 'number' && Number.isFinite(delta) && delta !== 0;
  const isPositive =
    showDelta &&
    (deltaPolarity === 'higher-is-better' ? (delta as number) > 0 : (delta as number) < 0);
  return (
    <div
      className={cn(
        'relative overflow-hidden rounded-lg border bg-card p-5 transition-shadow hover:shadow-sm',
        'before:absolute before:left-0 before:top-0 before:h-full before:w-0.5 before:opacity-70',
        toneToBg[tone],
        className,
      )}
      data-testid={rest['data-testid']}
    >
      <div className="flex items-start justify-between">
        <span className="text-[11px] font-medium uppercase tracking-wider text-muted-foreground">
          {label}
        </span>
        {icon && <span className="text-muted-foreground">{icon}</span>}
      </div>
      <div className="mt-2 flex items-baseline gap-2">
        <AnimatedCounter
          value={value}
          format={format}
          className="text-3xl font-semibold leading-none"
        />
        {showDelta && (
          <span
            className={cn(
              'inline-flex items-center gap-0.5 text-xs font-medium',
              isPositive ? 'text-success' : 'text-warning',
            )}
          >
            {isPositive ? (
              <ArrowUpRight className="h-3.5 w-3.5" />
            ) : (
              <ArrowDownRight className="h-3.5 w-3.5" />
            )}
            {Math.abs(delta as number).toFixed(0)}%
          </span>
        )}
      </div>
      {caption && <div className="mt-2 text-xs text-muted-foreground">{caption}</div>}
    </div>
  );
}
