import { Link, useParams } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import { ArrowLeft } from 'lucide-react';
import { Button } from '@/components/ui/button';

/**
 * Renders a "← Back to project" button linking to /projects/:projectId.
 * Pulls projectId from the route params; renders nothing when there is no
 * projectId in the URL (e.g., on the home page).
 */
export function BackToProject() {
  const { t } = useTranslation();
  const { projectId } = useParams<{ projectId?: string }>();
  if (!projectId) return null;
  return (
    <Button asChild variant="ghost" size="sm" data-testid="back-to-project">
      <Link to={`/projects/${projectId}`} className="text-muted-foreground hover:text-foreground">
        <ArrowLeft className="mr-2 h-4 w-4" />
        {t('navigation.backToProject')}
      </Link>
    </Button>
  );
}
