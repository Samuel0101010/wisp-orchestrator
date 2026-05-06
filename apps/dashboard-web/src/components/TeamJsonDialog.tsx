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
import type { Team } from '@agent-harness/schemas';

interface Props {
  team: Team;
}

/**
 * Read-only JSON view of the current team draft. Useful for sharing a config
 * or debugging "what will get saved?" without scraping the network panel.
 */
export function TeamJsonDialog({ team }: Props) {
  const [open, setOpen] = useState(false);
  const [copied, setCopied] = useState(false);
  const json = JSON.stringify(team, null, 2);

  const copy = async (): Promise<void> => {
    try {
      await navigator.clipboard.writeText(json);
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    } catch {
      /* clipboard unavailable — silently noop, user can copy manually */
    }
  };

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger asChild>
        <Button variant="outline" data-testid="view-json-trigger">
          View JSON
        </Button>
      </DialogTrigger>
      <DialogContent className="max-w-3xl">
        <DialogHeader>
          <DialogTitle>Team configuration (JSON)</DialogTitle>
          <DialogDescription>
            What gets sent to PUT /api/projects/:id/team. Useful for sharing a config or moving it
            between machines.
          </DialogDescription>
        </DialogHeader>
        <pre
          className="max-h-[60vh] overflow-auto rounded-md border bg-muted p-3 text-xs"
          data-testid="team-json-pre"
        >
          {json}
        </pre>
        <DialogFooter>
          <Button variant="outline" onClick={copy} data-testid="team-json-copy">
            {copied ? 'Copied!' : 'Copy'}
          </Button>
          <Button onClick={() => setOpen(false)}>Close</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
