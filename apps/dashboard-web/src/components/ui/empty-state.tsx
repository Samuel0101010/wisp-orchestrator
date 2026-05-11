import { cn } from '@/lib/utils';
import type { ReactNode } from 'react';

interface EmptyStateProps {
  /** Inline icon (lucide-react component). */
  icon?: ReactNode;
  /** Headline shown larger. */
  title: string;
  /** Optional body text below the title. */
  description?: ReactNode;
  /** Optional action node (Button, Link, etc.) shown below the description. */
  action?: ReactNode;
  /** Additional classes for the outer container. */
  className?: string;
}

/**
 * Friendly empty state with optional icon + CTA. Use whenever a list,
 * table, or panel has nothing to show so the user gets guidance instead
 * of a bare "No data" string.
 */
export function EmptyState({ icon, title, description, action, className }: EmptyStateProps) {
  return (
    <div
      className={cn(
        'flex flex-col items-center justify-center rounded-md border border-dashed border-border bg-card/40 p-8 text-center',
        className,
      )}
    >
      {icon && <div className="mb-3 text-muted-foreground/70">{icon}</div>}
      <h3 className="text-sm font-medium">{title}</h3>
      {description && <p className="mt-1 max-w-md text-sm text-muted-foreground">{description}</p>}
      {action && <div className="mt-4">{action}</div>}
    </div>
  );
}
