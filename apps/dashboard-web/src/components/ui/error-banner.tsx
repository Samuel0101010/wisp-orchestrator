import { AlertCircle, RotateCw } from 'lucide-react';
import { cn } from '@/lib/utils';
import { useTranslation } from 'react-i18next';
import type { ReactNode } from 'react';

interface ErrorBannerProps {
  title?: ReactNode;
  message?: ReactNode;
  /** Hook this to a queryClient.invalidate / refetch callback for retries. */
  onRetry?: () => void;
  className?: string;
}

/**
 * Inline error banner with optional retry. Replaces silent fallbacks
 * (empty arrays, generic toast) so the user understands what failed
 * and can try again without a page reload.
 */
export function ErrorBanner({ title, message, onRetry, className }: ErrorBannerProps) {
  const { t } = useTranslation();
  return (
    <div
      role="alert"
      className={cn(
        'flex items-start gap-3 rounded-md border border-destructive/40 bg-destructive/5 p-3 text-sm text-destructive',
        className,
      )}
    >
      <AlertCircle className="mt-0.5 h-4 w-4 shrink-0" aria-hidden="true" />
      <div className="flex-1">
        <p className="font-medium">{title ?? t('errors.title', 'Something went wrong')}</p>
        {message && <p className="mt-1 text-xs opacity-80">{message}</p>}
      </div>
      {onRetry && (
        <button
          onClick={onRetry}
          className="ml-auto flex items-center gap-1 rounded border border-destructive/40 px-2 py-1 text-xs font-medium hover:bg-destructive/10"
        >
          <RotateCw className="h-3 w-3" aria-hidden="true" />
          {t('buttons.retry', 'Retry')}
        </button>
      )}
    </div>
  );
}
