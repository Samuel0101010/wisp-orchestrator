import type { ReactNode } from 'react';
import { cn } from '@/lib/utils';

export type EmptyStateSize = 'column' | 'page';

export interface EmptyStateProps {
  /**
   * Lucide icon component or any ReactNode. Sized at 64px (page) or 32px (column)
   * via the wrapper, rendered in `text-muted-foreground/30`.
   */
  icon: ReactNode;
  /** Required heading (already translated). */
  title: string;
  /** Optional one-sentence helper (already translated). */
  description?: string;
  /** Optional CTA — typically a `<Button>` element. */
  action?: ReactNode;
  /**
   * `column` — compact for kanban columns / table rows.
   * `page`   — full page-empty with bigger icon. Defaults to `page`.
   */
  size?: EmptyStateSize;
  className?: string;
}

/**
 * Reusable empty surface. Two sizes:
 *   - page    Centered illustration block with 64px icon, title, optional
 *             description, and optional CTA.
 *   - column  Compact stack for kanban columns / table rows: 32px icon
 *             and a short title only.
 *
 * Consumer wraps in `border border-dashed border-border/40 rounded-md`
 * when the empty state stands alone (no surrounding card).
 */
export function EmptyState({
  icon,
  title,
  description,
  action,
  size = 'page',
  className,
}: EmptyStateProps) {
  if (size === 'column') {
    return (
      <div className={cn('flex flex-col items-center gap-1.5 py-6 text-center', className)}>
        <span
          data-testid="empty-state-icon"
          className="inline-flex size-8 items-center justify-center text-muted-foreground/30 [&_svg]:size-8"
          aria-hidden="true"
        >
          {icon}
        </span>
        <p className="text-xs font-medium text-muted-foreground">{title}</p>
      </div>
    );
  }

  return (
    <div
      className={cn('flex flex-col items-center justify-center gap-3 py-12 text-center', className)}
    >
      <span
        data-testid="empty-state-icon"
        className="inline-flex size-16 items-center justify-center text-muted-foreground/30 [&_svg]:size-16"
        aria-hidden="true"
      >
        {icon}
      </span>
      <h3 className="text-base font-medium">{title}</h3>
      {description && <p className="max-w-prose text-sm text-muted-foreground">{description}</p>}
      {action && <div className="mt-1">{action}</div>}
    </div>
  );
}
