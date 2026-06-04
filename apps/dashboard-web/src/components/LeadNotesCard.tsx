import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Bot, Play, Power, Trash2 } from 'lucide-react';
import {
  useDeleteLeadNote,
  useLeadNotes,
  useLeadTick,
  useProject,
  useUpdateProject,
  type LeadNoteRow,
  type LeadRecommendedAction,
} from '@/api/queries';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { toast } from '@/components/ui/use-toast';

interface LeadNotesCardProps {
  projectId: string;
}

/**
 * v2.0.0 Phase 8 — Team Lead (Theo) card.
 *
 * Renders inside the Brief tab below BriefCard + ProjectStateCard. Lets the
 * user activate the lead, trigger a synthesis tick, and review prior notes
 * (most recent 5). V1 surfaces replan recommendations only — actually
 * spawning a replan run is on the v2.1 roadmap.
 */
export function LeadNotesCard({ projectId }: LeadNotesCardProps) {
  const { t } = useTranslation();
  const project = useProject(projectId);
  const updateProject = useUpdateProject();
  const tick = useLeadTick(projectId);
  const notesQ = useLeadNotes(projectId, 10);
  const deleteNote = useDeleteLeadNote(projectId);

  const leadEnabled = project.data?.leadEnabled ?? false;
  const notes = notesQ.data ?? [];

  const handleActivate = async (): Promise<void> => {
    try {
      await updateProject.mutateAsync({ id: projectId, leadEnabled: true });
      toast({ title: t('leadNotes.toasts.leadActivated') });
    } catch (err) {
      toast({
        title: t('leadNotes.toasts.tickFailed'),
        description: (err as Error).message,
        variant: 'destructive',
      });
    }
  };

  const handleTick = async (): Promise<void> => {
    if (tick.isPending) return;
    try {
      await tick.mutateAsync();
    } catch (err) {
      toast({
        title: t('leadNotes.toasts.tickFailed'),
        description: (err as Error).message,
        variant: 'destructive',
      });
    }
  };

  const handleDelete = async (id: string): Promise<void> => {
    try {
      await deleteNote.mutateAsync(id);
    } catch (err) {
      toast({
        title: t('leadNotes.toasts.deleteFailed'),
        description: (err as Error).message,
        variant: 'destructive',
      });
    }
  };

  return (
    <Card data-testid="lead-notes-card">
      <CardHeader className="flex flex-row items-start justify-between gap-3 space-y-0 pb-2">
        <div className="flex flex-1 flex-col gap-1">
          <CardTitle className="flex items-center gap-2 text-sm font-medium">
            <Bot className="h-4 w-4 text-muted-foreground" />
            {t('leadNotes.title')}
            {leadEnabled ? (
              <Badge variant="secondary" className="text-2xs">
                {t('leadNotes.statusActive')}
              </Badge>
            ) : (
              <Badge variant="outline" className="text-2xs">
                {t('leadNotes.statusInactive')}
              </Badge>
            )}
          </CardTitle>
          <CardDescription className="text-xs">{t('leadNotes.description')}</CardDescription>
        </div>
        <div className="flex flex-col gap-1">
          {!leadEnabled ? (
            <Button
              type="button"
              size="sm"
              variant="outline"
              onClick={() => void handleActivate()}
              disabled={updateProject.isPending}
              data-testid="lead-activate"
              className="h-7 px-2 text-xs"
            >
              <Power className="mr-1 h-3 w-3" />
              {t('leadNotes.activate')}
            </Button>
          ) : (
            <Button
              type="button"
              size="sm"
              onClick={() => void handleTick()}
              disabled={tick.isPending}
              data-testid="lead-tick-button"
              className="h-7 px-2 text-xs"
            >
              <Play className="mr-1 h-3 w-3" />
              {tick.isPending ? t('leadNotes.ticking') : t('leadNotes.tickNow')}
            </Button>
          )}
        </div>
      </CardHeader>

      <CardContent className="flex flex-col gap-3">
        {notes.length === 0 ? (
          <p className="text-xs text-muted-foreground" data-testid="lead-notes-empty">
            {t('leadNotes.empty')}
          </p>
        ) : (
          <div className="flex flex-col gap-2">
            {notes.slice(0, 5).map((note) => (
              <LeadNoteRowView
                key={note.id}
                note={note}
                onDelete={() => void handleDelete(note.id)}
              />
            ))}
          </div>
        )}
      </CardContent>
    </Card>
  );
}

function LeadNoteRowView({ note, onDelete }: { note: LeadNoteRow; onDelete: () => void }) {
  const { t } = useTranslation();
  const [open, setOpen] = useState(false);
  const decision = note.decisionsJson;
  const action: LeadRecommendedAction | undefined = decision?.recommendedAction;
  const blockers = decision?.blockers ?? [];
  const nextRole = decision?.nextRole;

  const created = (() => {
    try {
      return new Date(note.createdAt).toLocaleString();
    } catch {
      return String(note.createdAt);
    }
  })();

  return (
    <Card className="border bg-muted/20 p-2" data-testid={`lead-note-${note.id}`}>
      <div className="flex items-center justify-between gap-2">
        <div className="flex flex-wrap items-center gap-2">
          {action ? (
            <Badge
              variant={
                action === 'continue' ? 'secondary' : action === 'replan' ? 'default' : 'outline'
              }
              className="text-2xs"
              data-testid={`lead-decision-${action}`}
            >
              {t(`leadNotes.recommendedAction.${action}`)}
            </Badge>
          ) : null}
          {nextRole ? (
            <Badge variant="outline" className="text-2xs">
              {t('leadNotes.nextRole')}: {nextRole}
            </Badge>
          ) : null}
          <span className="text-2xs text-muted-foreground">{created}</span>
        </div>
        <Button
          type="button"
          size="sm"
          variant="ghost"
          onClick={onDelete}
          className="h-6 px-1 text-xs"
          aria-label={t('leadNotes.deleteNote')}
        >
          <Trash2 className="h-3 w-3" />
        </Button>
      </div>

      {blockers.length > 0 ? (
        <div className="mt-1 flex flex-wrap gap-1">
          <span className="text-2xs uppercase tracking-wide text-muted-foreground">
            {t('leadNotes.blockers')}:
          </span>
          {blockers.map((b, i) => (
            <Badge key={i} variant="outline" className="text-2xs">
              {b}
            </Badge>
          ))}
        </div>
      ) : null}

      <details
        className="mt-1"
        open={open}
        onToggle={(e) => setOpen((e.currentTarget as HTMLDetailsElement).open)}
      >
        <summary className="cursor-pointer text-xs text-muted-foreground">
          {open ? t('leadNotes.collapse') : t('leadNotes.expand')}
        </summary>
        <pre className="mt-1 whitespace-pre-wrap rounded bg-background p-2 text-xs leading-snug">
          {note.summaryMd}
        </pre>
      </details>
    </Card>
  );
}
