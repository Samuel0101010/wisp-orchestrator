import { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { AlertTriangle, CheckCircle2 } from 'lucide-react';
import { useRepoStatus } from '@/api/queries';

/**
 * Advisory status line under the repo-path field in the New Project dialog.
 * Debounces the typed path and tells the user up front whether the folder is a
 * git repo, exists but isn't a repo, or doesn't exist yet — so the "not a git
 * repo" problem surfaces at entry time instead of only at the first run.
 * Non-blocking: project creation is always allowed; WISP initialises the repo
 * on first run.
 */
export function RepoPathHint({ path }: { path: string }) {
  const { t } = useTranslation();
  const [debounced, setDebounced] = useState(path.trim());

  useEffect(() => {
    const id = setTimeout(() => setDebounced(path.trim()), 400);
    return () => clearTimeout(id);
  }, [path]);

  const { data, isFetching } = useRepoStatus(debounced);

  if (debounced.length === 0) return null;

  if (isFetching && !data) {
    return (
      <p className="text-2xs text-muted-foreground" data-testid="repo-path-hint">
        {t('newProject.repoStatus.checking')}
      </p>
    );
  }
  if (!data) return null;

  if (data.isGitRepo) {
    return (
      <p
        className="flex items-center gap-1 text-2xs text-emerald-600 dark:text-emerald-400"
        data-testid="repo-path-hint"
      >
        <CheckCircle2 className="h-3 w-3 shrink-0" />
        {t('newProject.repoStatus.gitRepo')}
      </p>
    );
  }

  return (
    <p
      className="flex items-center gap-1 text-2xs text-amber-600 dark:text-amber-400"
      data-testid="repo-path-hint"
    >
      <AlertTriangle className="h-3 w-3 shrink-0" />
      {data.exists ? t('newProject.repoStatus.notGitRepo') : t('newProject.repoStatus.missing')}
    </p>
  );
}
