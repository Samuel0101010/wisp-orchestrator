import type { ReactNode } from 'react';
import { clsx } from 'clsx';

export type StatusPillTone = 'neutral' | 'info' | 'success' | 'warning' | 'destructive';
export type StatusPillVariant = 'solid' | 'soft' | 'outline';

export interface StatusPillProps {
  /** Visible label. Already-translated string. */
  children: ReactNode;
  /** Tone — drives color. */
  tone: StatusPillTone;
  /** Visual style. */
  variant?: StatusPillVariant;
  /** Adds a leading pulsing dot. Use for live/in-progress states. */
  live?: boolean;
  /** Optional leading icon (lucide etc.). */
  icon?: ReactNode;
  className?: string;
}

/**
 * Standardized status indicator. Replaces ad-hoc Badge use across
 * Workers / Skills / RunView / ProjectDetail / Sidebar. All UPPERCASE
 * 11px, rounded-full pill. Three variants:
 *   - solid    high-importance terminal states (Failed, Locked, Done)
 *   - soft     in-progress states (Running, Verifying)
 *   - outline  taxonomy tags (seed/user/plugin, sonnet/haiku/opus)
 */
const BASE =
  'inline-flex items-center gap-1 rounded-full px-2 py-0.5 font-medium uppercase tracking-wider';

/**
 * `text-xs2` is a custom utility (11px). It must come AFTER the tone's
 * `text-{tone}` color class so `tailwind-merge` doesn't drop it when it
 * mistakes them for a conflict in the `text-*` group.
 */
const TYPE_SIZE = 'text-xs2';

const VARIANT_TONE: Record<StatusPillVariant, Record<StatusPillTone, string>> = {
  solid: {
    neutral: 'bg-muted text-foreground',
    info: 'bg-info text-info-foreground',
    success: 'bg-success text-success-foreground',
    warning: 'bg-warning text-warning-foreground',
    destructive: 'bg-destructive text-destructive-foreground',
  },
  soft: {
    neutral: 'bg-muted-foreground/12 text-muted-foreground',
    info: 'bg-info/12 text-info',
    success: 'bg-success/12 text-success',
    warning: 'bg-warning/12 text-warning',
    destructive: 'bg-destructive/12 text-destructive',
  },
  outline: {
    neutral: 'border border-muted-foreground/30 text-muted-foreground',
    info: 'border border-info/40 text-info',
    success: 'border border-success/40 text-success',
    warning: 'border border-warning/40 text-warning',
    destructive: 'border border-destructive/40 text-destructive',
  },
};

export function StatusPill({
  children,
  tone,
  variant = 'soft',
  live = false,
  icon,
  className,
}: StatusPillProps) {
  return (
    <span
      className={clsx(
        // clsx (not twMerge) on purpose: `text-xs2` (custom 11px utility)
        // and `text-{tone}` look like the same `text-*` group to
        // tailwind-merge, which would drop one of them. Consumers can
        // still override via the trailing `className` argument.
        BASE,
        VARIANT_TONE[variant][tone],
        TYPE_SIZE,
        className,
      )}
    >
      {live && (
        <span
          data-testid="status-pill-live-dot"
          className="size-1.5 rounded-full bg-current animate-pulse"
          aria-hidden="true"
        />
      )}
      {icon && (
        <span className="inline-flex items-center" aria-hidden="true">
          {icon}
        </span>
      )}
      {children}
    </span>
  );
}
