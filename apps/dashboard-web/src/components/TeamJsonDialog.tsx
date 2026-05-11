import { useState } from 'react';
import { useTranslation } from 'react-i18next';
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
  const { t } = useTranslation();
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
          {t('teamJsonDialog.trigger')}
        </Button>
      </DialogTrigger>
      <DialogContent className="max-w-3xl">
        <DialogHeader>
          <DialogTitle>{t('teamJsonDialog.title')}</DialogTitle>
          <DialogDescription>{t('teamJsonDialog.description')}</DialogDescription>
        </DialogHeader>
        <pre
          className="max-h-[60vh] overflow-auto rounded-md border bg-muted p-3 text-xs"
          data-testid="team-json-pre"
        >
          {json}
        </pre>
        <DialogFooter>
          <Button variant="outline" onClick={copy} data-testid="team-json-copy">
            {copied ? t('teamJsonDialog.copied') : t('teamJsonDialog.copy')}
          </Button>
          <Button onClick={() => setOpen(false)}>{t('buttons.close')}</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
