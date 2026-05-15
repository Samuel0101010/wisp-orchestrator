import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Activity, CheckSquare, Eye, Globe, Plus, Trash2 } from 'lucide-react';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { useCreateDod, useDeleteDod, useDodCriteria, type DodKind } from '@/api/queries';
import { toast } from '@/components/ui/use-toast';

/**
 * Definition-of-Done editor. One row per acceptance gate the user wants the
 * release-gate to enforce. Three kinds:
 *   - smoke: HTTP probe. Spec = { url, expectedStatus? }
 *   - e2e:   Playwright-driven user action. Spec = { description } (the
 *            verifier writes the actual test from the description)
 *   - manual: human sign-off. Spec = { note }
 *
 * Manual criteria never auto-pass — they're a checklist the human walks
 * through after auto-gates clear. They block auto-release but not the
 * self-healing chain.
 */
const KIND_ICON: Record<DodKind, typeof Globe> = {
  smoke: Globe,
  e2e: Activity,
  manual: Eye,
};

const KIND_BADGE_VARIANT: Record<DodKind, 'default' | 'secondary' | 'outline'> = {
  smoke: 'default',
  e2e: 'secondary',
  manual: 'outline',
};

export function DefinitionOfDoneCard({ projectId }: { projectId: string }) {
  const { t } = useTranslation();
  const list = useDodCriteria(projectId);
  const create = useCreateDod(projectId);
  const del = useDeleteDod(projectId);

  const [newTitle, setNewTitle] = useState('');
  const [newKind, setNewKind] = useState<DodKind>('smoke');
  const [newSpecValue, setNewSpecValue] = useState('');

  const placeholderForKind = (k: DodKind): string => {
    switch (k) {
      case 'smoke':
        return t('dod.placeholders.smoke');
      case 'e2e':
        return t('dod.placeholders.e2e');
      case 'manual':
        return t('dod.placeholders.manual');
    }
  };

  const handleAdd = async (): Promise<void> => {
    const title = newTitle.trim();
    const specValue = newSpecValue.trim();
    if (!title || !specValue) return;
    let spec: Record<string, unknown>;
    if (newKind === 'smoke') spec = { url: specValue };
    else if (newKind === 'e2e') spec = { description: specValue };
    else spec = { note: specValue };
    try {
      await create.mutateAsync({ title, kind: newKind, spec });
      setNewTitle('');
      setNewSpecValue('');
    } catch (err) {
      toast({
        title: t('dod.errors.createFailed'),
        description: (err as Error).message,
        variant: 'destructive',
      });
    }
  };

  const handleDelete = async (id: string): Promise<void> => {
    try {
      await del.mutateAsync(id);
    } catch (err) {
      toast({
        title: t('dod.errors.deleteFailed'),
        description: (err as Error).message,
        variant: 'destructive',
      });
    }
  };

  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex items-center gap-2 text-sm font-medium">
          <CheckSquare className="h-4 w-4 text-muted-foreground" />
          {t('dod.title')}
        </CardTitle>
        <CardDescription>{t('dod.description')}</CardDescription>
      </CardHeader>
      <CardContent className="space-y-3">
        {list.data && list.data.length > 0 ? (
          <ul className="space-y-1.5">
            {list.data.map((c) => {
              const Icon = KIND_ICON[c.kind];
              const specSummary = describeSpec(c.kind, c.specJson);
              return (
                <li
                  key={c.id}
                  className="flex items-center gap-2 rounded-md border border-border bg-card px-3 py-2 text-sm"
                >
                  <Icon className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />
                  <Badge variant={KIND_BADGE_VARIANT[c.kind]} className="text-2xs">
                    {t(`dod.kinds.${c.kind}` as const)}
                  </Badge>
                  <div className="flex min-w-0 flex-1 flex-col">
                    <span className="truncate font-medium">{c.title}</span>
                    {specSummary && (
                      <span className="truncate text-2xs text-muted-foreground">{specSummary}</span>
                    )}
                  </div>
                  <Button
                    type="button"
                    variant="ghost"
                    size="icon"
                    className="h-7 w-7 shrink-0 text-muted-foreground hover:text-destructive"
                    onClick={() => void handleDelete(c.id)}
                    aria-label={t('dod.actions.delete')}
                  >
                    <Trash2 className="h-3.5 w-3.5" />
                  </Button>
                </li>
              );
            })}
          </ul>
        ) : (
          <p className="text-2xs italic text-muted-foreground">{t('dod.empty')}</p>
        )}

        <div className="grid grid-cols-1 gap-2 sm:grid-cols-[1fr_120px_1fr_auto]">
          <Input
            value={newTitle}
            onChange={(e) => setNewTitle(e.target.value)}
            placeholder={t('dod.placeholders.title')}
          />
          <select
            value={newKind}
            onChange={(e) => setNewKind(e.target.value as DodKind)}
            className="rounded-md border border-input bg-background px-2 py-1.5 text-sm"
          >
            <option value="smoke">{t('dod.kinds.smoke')}</option>
            <option value="e2e">{t('dod.kinds.e2e')}</option>
            <option value="manual">{t('dod.kinds.manual')}</option>
          </select>
          <Input
            value={newSpecValue}
            onChange={(e) => setNewSpecValue(e.target.value)}
            placeholder={placeholderForKind(newKind)}
          />
          <Button
            type="button"
            onClick={() => void handleAdd()}
            disabled={
              create.isPending || newTitle.trim().length === 0 || newSpecValue.trim().length === 0
            }
            size="sm"
          >
            <Plus className="mr-1 h-3.5 w-3.5" />
            {t('dod.actions.add')}
          </Button>
        </div>
      </CardContent>
    </Card>
  );
}

function describeSpec(kind: DodKind, spec: Record<string, unknown>): string | null {
  if (kind === 'smoke') {
    const url = typeof spec.url === 'string' ? spec.url : null;
    return url ? `GET ${url}` : null;
  }
  if (kind === 'e2e') {
    const desc = typeof spec.description === 'string' ? spec.description : null;
    if (desc) return desc;
    const file = typeof spec.testFile === 'string' ? spec.testFile : null;
    return file ? file : null;
  }
  if (kind === 'manual') {
    const note = typeof spec.note === 'string' ? spec.note : null;
    return note;
  }
  return null;
}
