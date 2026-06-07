import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { UserPlus } from 'lucide-react';
import type { Agent } from '@wisp/schemas';
import { useAgents } from '@/api/queries';
import { Button } from '@/components/ui/button';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from '@/components/ui/dialog';

/**
 * Seed agents that orchestrate chat / interviews rather than build the project,
 * so they are not offered as project team workers.
 */
const EXCLUDED_SEED_KEYS = new Set(['manager', 'lead', 'requirements-interviewer']);

interface AddBuiltInAgentDialogProps {
  onPick: (agent: Agent) => void;
  disabled?: boolean;
}

/**
 * Lets the user drop a built-in / saved agent (the ones available in chat)
 * onto the project team — the visual equivalent of what the chat manager's
 * create_project directive already does. The server + schema already support
 * the agentId soft-link; this is the missing UI bridge (finding #6).
 */
export function AddBuiltInAgentDialog({ onPick, disabled }: AddBuiltInAgentDialogProps) {
  const { t } = useTranslation();
  const [open, setOpen] = useState(false);
  const { data: agents, isLoading, isError } = useAgents();
  const pickable = (Array.isArray(agents) ? agents : []).filter(
    (a) => !(a.seedKey && EXCLUDED_SEED_KEYS.has(a.seedKey)),
  );

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger asChild>
        <Button variant="outline" disabled={disabled} data-testid="add-builtin-agent-trigger">
          <UserPlus className="mr-2 h-4 w-4" />
          {t('teamBuilder.addAgent.trigger')}
        </Button>
      </DialogTrigger>
      <DialogContent className="max-w-lg">
        <DialogHeader>
          <DialogTitle>{t('teamBuilder.addAgent.title')}</DialogTitle>
          <DialogDescription>{t('teamBuilder.addAgent.description')}</DialogDescription>
        </DialogHeader>
        <div
          className="flex max-h-96 flex-col gap-2 overflow-y-auto"
          data-testid="add-builtin-agent-list"
        >
          {isLoading ? (
            <p className="py-6 text-center text-sm text-muted-foreground">
              {t('teamBuilder.addAgent.loading')}
            </p>
          ) : isError ? (
            <p className="py-6 text-center text-sm text-destructive">
              {t('teamBuilder.addAgent.error')}
            </p>
          ) : pickable.length === 0 ? (
            <p className="py-6 text-center text-sm text-muted-foreground">
              {t('teamBuilder.addAgent.empty')}
            </p>
          ) : (
            pickable.map((a) => (
              <button
                key={a.id}
                type="button"
                data-testid={`add-builtin-agent-${a.id}`}
                onClick={() => {
                  onPick(a);
                  setOpen(false);
                }}
                className="flex items-start gap-3 rounded-md border border-border p-3 text-left transition-colors hover:bg-accent focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
              >
                <span
                  aria-hidden
                  className="mt-0.5 flex size-7 shrink-0 items-center justify-center overflow-hidden rounded-full bg-muted text-xs font-semibold uppercase text-muted-foreground"
                >
                  {a.avatarUrl ? (
                    <img src={a.avatarUrl} alt="" className="h-full w-full object-cover" />
                  ) : (
                    a.name.slice(0, 1)
                  )}
                </span>
                <span className="min-w-0 flex-1">
                  <span className="flex items-center gap-2">
                    <span className="truncate text-sm font-medium">{a.name}</span>
                    <span className="shrink-0 rounded bg-muted px-1.5 py-0.5 text-2xs uppercase tracking-wide text-muted-foreground">
                      {a.model}
                    </span>
                    {a.seedKey ? (
                      <span className="shrink-0 truncate text-2xs text-muted-foreground">
                        {a.seedKey}
                      </span>
                    ) : null}
                  </span>
                  {a.description ? (
                    <span className="mt-0.5 line-clamp-2 block text-xs text-muted-foreground">
                      {a.description}
                    </span>
                  ) : null}
                </span>
              </button>
            ))
          )}
        </div>
      </DialogContent>
    </Dialog>
  );
}
