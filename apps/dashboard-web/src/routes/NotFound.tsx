import type { ReactElement } from 'react';
import { useTranslation } from 'react-i18next';
import { Link } from 'react-router-dom';
import { Button } from '@/components/ui/button';

export function NotFound(): ReactElement {
  const { t } = useTranslation();
  return (
    <div className="mx-auto flex max-w-lg flex-col items-start gap-4 p-8 text-sm">
      <div className="text-3xs uppercase tracking-wider text-muted-foreground">404</div>
      <div className="text-2xl font-semibold">
        {t('notFound.title', 'This view does not exist.')}
      </div>
      <div className="text-muted-foreground">
        {t('notFound.body', "The URL doesn't match any route. Likely a stale link or typo.")}
      </div>
      <Button asChild>
        <Link to="/">{t('notFound.back', 'Back to Mission Control')}</Link>
      </Button>
    </div>
  );
}
