import { useNavigate } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import { CheckCircle2, ExternalLink, FolderOpen, MessageSquare, Package } from 'lucide-react';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { useProject, useProjectType, useRun } from '@/api/queries';

/**
 * Friendly "your app is ready" banner shown in the run view once a run has
 * completed successfully. Tells a non-developer what to do next instead of
 * leaving them on a green kanban board:
 *  - non-web packageTarget → point at the "Build app" card + folder location
 *  - detected web-app      → primary button straight into the preview tab
 *  - everything else       → folder location + "ask the chat" hint
 * Renders nothing unless run.status === 'completed' && outcome === 'success'.
 */
export function SuccessCard({ projectId, runId }: { projectId: string; runId: string }) {
  const { t } = useTranslation();
  const navigate = useNavigate();
  const runQuery = useRun(runId);
  const project = useProject(projectId);
  const projectType = useProjectType(projectId);

  const run = runQuery.data?.run;
  if (!run || run.status !== 'completed' || run.outcome !== 'success') return null;

  const packageTarget = project.data?.packageTarget ?? 'web';
  const repoPath = project.data?.repoPath ?? '';
  const isWebApp = projectType.data?.type === 'web-app';

  const folderLine = repoPath ? (
    <p
      className="flex items-center gap-1.5 text-xs text-muted-foreground"
      data-testid="run-success-folder"
    >
      <FolderOpen className="h-3.5 w-3.5 shrink-0" />
      {t('runView.success.folder', { path: repoPath })}
    </p>
  ) : null;

  return (
    <Card data-testid="run-success-card" className="border-success/40 bg-success/5">
      <CardHeader className="pb-2">
        <CardTitle className="flex items-center gap-2 text-sm font-medium text-success">
          <CheckCircle2 className="h-4 w-4" />
          {t('runView.success.title')}
        </CardTitle>
      </CardHeader>
      <CardContent className="flex flex-col gap-2">
        {packageTarget !== 'web' ? (
          <>
            <p
              className="flex items-center gap-1.5 text-xs text-foreground"
              data-testid="run-success-desktop-hint"
            >
              <Package className="h-3.5 w-3.5 shrink-0" />
              {t('runView.success.desktop.hint')}
            </p>
            {folderLine}
          </>
        ) : isWebApp ? (
          <>
            <div>
              <Button
                size="sm"
                onClick={() => navigate(`/projects/${projectId}?tab=preview`)}
                data-testid="run-success-preview-cta"
              >
                <ExternalLink className="mr-1.5 h-3.5 w-3.5" />
                {t('runView.success.web.cta')}
              </Button>
            </div>
            {folderLine}
          </>
        ) : (
          <>
            {folderLine}
            <p
              className="flex items-center gap-1.5 text-xs text-muted-foreground"
              data-testid="run-success-next-hint"
            >
              <MessageSquare className="h-3.5 w-3.5 shrink-0" />
              {t('runView.success.next')}
            </p>
          </>
        )}
      </CardContent>
    </Card>
  );
}
