import { useState } from 'react';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { Button } from '@/components/ui/button';
import { Label } from '@/components/ui/label';
import { Textarea } from '@/components/ui/textarea';
import { useProbePrompt } from '@/api/queries';
import { ApiError } from '@/api/client';
import type { DraftAgent } from '@/components/TeamRoleCard';

interface Props {
  open: boolean;
  onOpenChange: (v: boolean) => void;
  draft: DraftAgent;
}

/**
 * Sends the role's system prompt + a user-supplied sample goal to the probe
 * endpoint and shows the response inline. maxTurns is capped server-side at
 * 2 — this is for prompt-tweaking, not for getting real work done.
 */
export function TestPromptDialog({ open, onOpenChange, draft }: Props) {
  const [sampleGoal, setSampleGoal] = useState(
    'Add a hello(name) function returning "Hello, <name>" to src/hello.ts plus a vitest test.',
  );
  const probe = useProbePrompt();

  const handleRun = (): void => {
    probe.mutate({
      systemPrompt: draft.systemPrompt,
      sampleGoal,
      model: draft.model,
      allowedTools: draft.allowedTools,
    });
  };

  const errorBody =
    probe.error instanceof ApiError && typeof probe.error.body === 'object' && probe.error.body
      ? (probe.error.body as Record<string, unknown>)
      : null;

  return (
    <Dialog
      open={open}
      onOpenChange={(v) => {
        onOpenChange(v);
        if (!v) probe.reset();
      }}
    >
      <DialogContent className="max-w-3xl">
        <DialogHeader>
          <DialogTitle>Test prompt — {draft.role || '(new role)'}</DialogTitle>
          <DialogDescription>
            Sends the role's system prompt + a sample goal to claude -p with maxTurns=2. Counts
            against your subscription quota.
          </DialogDescription>
        </DialogHeader>
        <div className="flex flex-col gap-3">
          <div className="flex flex-col gap-1.5">
            <Label htmlFor="probe-goal">Sample goal</Label>
            <Textarea
              id="probe-goal"
              rows={3}
              value={sampleGoal}
              onChange={(e) => setSampleGoal(e.target.value)}
            />
          </div>
          <div className="flex items-center gap-2 text-xs text-muted-foreground">
            <span>
              Model: <code>{draft.model}</code>
            </span>
            <span>
              Tools: <code>{draft.allowedTools.length || 'defaults'}</code>
            </span>
          </div>
          {probe.isPending && (
            <div className="rounded-md border bg-muted p-3 text-sm" data-testid="probe-loading">
              Running probe…
            </div>
          )}
          {probe.isError && (
            <div
              className="rounded-md border border-destructive/40 bg-destructive/10 p-3 text-sm text-destructive"
              data-testid="probe-error"
            >
              <p className="font-semibold">Probe failed</p>
              <p className="text-xs">{probe.error.message}</p>
              {errorBody && typeof errorBody.details === 'string' && (
                <pre className="mt-2 max-h-40 overflow-auto whitespace-pre-wrap text-xs">
                  {String(errorBody.details)}
                </pre>
              )}
              {errorBody && errorBody.error === 'auth-failed' && (
                <p className="mt-2 text-xs">
                  Hint: run <code>claude login</code> on the server host first.
                </p>
              )}
            </div>
          )}
          {probe.isSuccess && (
            <div
              className="flex flex-col gap-2 rounded-md border bg-muted p-3 text-sm"
              data-testid="probe-result"
            >
              <div className="flex flex-wrap gap-3 text-xs text-muted-foreground">
                <span>
                  in: <strong>{probe.data.tokensIn.toLocaleString()}</strong>
                </span>
                <span>
                  out: <strong>{probe.data.tokensOut.toLocaleString()}</strong>
                </span>
                <span>
                  turns: <strong>{probe.data.turns}</strong>
                </span>
                <span>
                  elapsed: <strong>{(probe.data.elapsedMs / 1000).toFixed(1)}s</strong>
                </span>
              </div>
              <pre className="max-h-80 overflow-auto whitespace-pre-wrap text-xs">
                {probe.data.response || '(empty response)'}
              </pre>
            </div>
          )}
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)}>
            Close
          </Button>
          <Button
            onClick={handleRun}
            disabled={probe.isPending || !sampleGoal.trim()}
            data-testid="probe-run"
          >
            {probe.isPending ? 'Running…' : 'Run probe'}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
