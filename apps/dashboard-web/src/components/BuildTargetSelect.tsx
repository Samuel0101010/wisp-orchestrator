/**
 * BuildTargetSelect — Phase 7 (v1.15) radio group that switches the
 * `projects.package_target` enum. Only `tauri-exe` is implemented in v1.15;
 * the other entries are placeholders and show a hint when selected.
 */

import { type ReactElement } from 'react';
import { useTranslation } from 'react-i18next';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { toast } from '@/components/ui/use-toast';
import { Layers } from 'lucide-react';
import { useUpdateProject, type PackageTarget } from '@/api/queries';

interface BuildTargetSelectProps {
  projectId: string;
  packageTarget: PackageTarget;
}

const OPTIONS: ReadonlyArray<{ value: PackageTarget; implemented: boolean }> = [
  { value: 'web', implemented: true },
  { value: 'tauri-exe', implemented: true },
  { value: 'electron-exe', implemented: false },
  { value: 'pkg-bin', implemented: false },
];

export function BuildTargetSelect({
  projectId,
  packageTarget,
}: BuildTargetSelectProps): ReactElement {
  const { t } = useTranslation();
  const update = useUpdateProject();

  const handleChange = async (next: PackageTarget): Promise<void> => {
    if (next === packageTarget) return;
    try {
      await update.mutateAsync({ id: projectId, packageTarget: next });
      toast({ title: t('buildApp.target.saved') });
    } catch (err) {
      toast({
        title: t('buildApp.target.saveFailed'),
        description: (err as Error).message,
        variant: 'destructive',
      });
    }
  };

  return (
    <Card data-testid="build-target-card">
      <CardHeader className="flex flex-row items-center gap-2 space-y-0 pb-2">
        <Layers className="h-4 w-4 text-muted-foreground" />
        <div className="flex flex-col gap-0.5">
          <CardTitle className="text-sm font-medium">{t('buildApp.target.title')}</CardTitle>
          <CardDescription className="text-2xs">{t('buildApp.target.description')}</CardDescription>
        </div>
      </CardHeader>
      <CardContent className="flex flex-col gap-2">
        {OPTIONS.map((opt) => (
          <label
            key={opt.value}
            className="flex items-start gap-3 rounded border p-2 text-xs"
            data-testid={`build-target-option-${opt.value}`}
          >
            <input
              type="radio"
              className="mt-0.5"
              name="package-target"
              value={opt.value}
              checked={packageTarget === opt.value}
              disabled={update.isPending}
              onChange={() => void handleChange(opt.value)}
            />
            <div className="flex flex-col gap-0.5">
              <span className="font-medium">{t(`buildApp.target.${opt.value}`)}</span>
              {!opt.implemented && (
                <span className="text-muted-foreground">{t('buildApp.target.placeholder')}</span>
              )}
            </div>
          </label>
        ))}
      </CardContent>
    </Card>
  );
}
