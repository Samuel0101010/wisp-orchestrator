import * as React from 'react';
import { useTranslation } from 'react-i18next';
import { cn } from '@/lib/utils';
import { statusLabel } from '@/lib/status-labels';

export type StatusTone = 'running' | 'success' | 'failed' | 'pending' | 'paused' | 'neutral';

const toneClasses: Record<StatusTone, { dot: string; text: string; ring: string }> = {
  running: {
    dot: 'bg-info',
    text: 'text-info',
    ring: 'ring-info/20',
  },
  success: {
    dot: 'bg-success',
    text: 'text-success',
    ring: 'ring-success/20',
  },
  failed: {
    dot: 'bg-destructive',
    text: 'text-destructive',
    ring: 'ring-destructive/20',
  },
  pending: {
    dot: 'bg-muted-foreground',
    text: 'text-muted-foreground',
    ring: 'ring-muted-foreground/20',
  },
  paused: {
    dot: 'bg-warning',
    text: 'text-warning',
    ring: 'ring-warning/20',
  },
  neutral: {
    dot: 'bg-muted-foreground/60',
    text: 'text-muted-foreground',
    ring: 'ring-muted-foreground/10',
  },
};

export function statusToTone(s: string | undefined | null): StatusTone {
  if (!s) return 'neutral';
  const v = s.toLowerCase();
  if (v === 'running' || v === 'verifying' || v === 'in_progress') return 'running';
  if (v === 'done' || v === 'success' || v === 'completed' || v === 'passed') return 'success';
  if (v === 'failed' || v === 'cancelled' || v === 'error') return 'failed';
  if (v === 'paused') return 'paused';
  if (v === 'pending' || v === 'draft' || v === 'queued') return 'pending';
  return 'neutral';
}

export interface StatusDotBadgeProps extends Omit<
  React.HTMLAttributes<HTMLSpanElement>,
  'children'
> {
  /** Raw status string — mapped to tone via {@link statusToTone}. Falls back to `tone` if unset. */
  status?: string | null;
  /** Explicit tone override. Wins over `status` when provided. */
  tone?: StatusTone;
  /** Optional label override. Defaults to `status` (lowercased). */
  label?: string;
  /** Adds a soft pulse to the dot — use for live "running" states. */
  pulse?: boolean;
  /** Hide the textual label — useful for very compact lists where the dot alone communicates. */
  iconOnly?: boolean;
}

export function StatusDotBadge({
  status,
  tone,
  label,
  pulse,
  className,
  iconOnly,
  ...rest
}: StatusDotBadgeProps) {
  const { t } = useTranslation();
  const resolvedTone = tone ?? statusToTone(status);
  const toneStyle = toneClasses[resolvedTone];
  const text = label ?? (status ? statusLabel(status, t) : resolvedTone);
  return (
    <span
      className={cn(
        'inline-flex items-center gap-1.5 rounded-full px-2 py-0.5 text-[10px] font-medium uppercase tracking-wide',
        'bg-transparent ring-1 ring-inset',
        toneStyle.text,
        toneStyle.ring,
        className,
      )}
      data-status={resolvedTone}
      {...rest}
    >
      <span className={cn('relative inline-flex h-1.5 w-1.5 rounded-full', toneStyle.dot)}>
        {pulse && (
          <span
            className={cn('absolute inset-0 -m-0.5 animate-ping rounded-full opacity-60', toneStyle.dot)}
            aria-hidden
          />
        )}
      </span>
      {!iconOnly && <span>{text}</span>}
    </span>
  );
}
