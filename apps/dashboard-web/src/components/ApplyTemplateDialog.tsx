import { useState } from 'react';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from '@/components/ui/dialog';
import { Button } from '@/components/ui/button';
import { TemplatePicker } from '@/components/TemplatePicker';
import type { Team } from '@agent-harness/schemas';
import { useTemplates } from '@/api/queries';

interface Props {
  /** Called with the picked template's team payload after the user confirms. */
  onApply: (team: Team) => void;
  /** Whether the current draft has unsaved/non-default content (for the warning). */
  hasContent: boolean;
}

/**
 * Lets the user load a built-in or saved template into the existing
 * TeamBuilder draft. Surfaces a confirmation step because the picked template
 * overwrites whatever the user was editing.
 */
export function ApplyTemplateDialog({ onApply, hasContent }: Props) {
  const [open, setOpen] = useState(false);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const { data: templates = [] } = useTemplates();

  const picked = templates.find((t) => t.id === selectedId);

  const handleApply = (): void => {
    if (!picked) return;
    onApply(picked.team);
    setOpen(false);
    setSelectedId(null);
  };

  return (
    <Dialog
      open={open}
      onOpenChange={(v) => {
        setOpen(v);
        if (!v) setSelectedId(null);
      }}
    >
      <DialogTrigger asChild>
        <Button variant="outline" data-testid="apply-template-trigger">
          Apply Template
        </Button>
      </DialogTrigger>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Apply a template</DialogTitle>
          <DialogDescription>
            Loads the chosen template into the current TeamBuilder draft.
            {hasContent ? ' Your current draft will be overwritten.' : ''}
          </DialogDescription>
        </DialogHeader>
        <TemplatePicker selectedId={selectedId} onSelect={setSelectedId} />
        <DialogFooter>
          <Button variant="outline" onClick={() => setOpen(false)}>
            Cancel
          </Button>
          <Button onClick={handleApply} disabled={!picked} data-testid="apply-template-confirm">
            {picked ? `Apply ${picked.name}` : 'Apply'}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
