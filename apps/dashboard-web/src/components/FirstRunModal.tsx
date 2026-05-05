import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from './ui/dialog';
import { Button } from './ui/button';

const ACK_KEY = 'agent-harness:first-run-ack-v1';

export interface FirstRunModalProps {
  open: boolean;
  onAck: () => void;
}

export function FirstRunModal({ open, onAck }: FirstRunModalProps) {
  const handleAck = (): void => {
    try {
      localStorage.setItem(ACK_KEY, '1');
    } catch {
      // localStorage unavailable (private mode etc.) — proceed anyway.
    }
    onAck();
  };

  return (
    <Dialog open={open} onOpenChange={() => undefined}>
      <DialogContent
        data-testid="first-run-modal"
        onInteractOutside={(e) => e.preventDefault()}
        onEscapeKeyDown={(e) => e.preventDefault()}
      >
        <DialogHeader>
          <DialogTitle>Agent Harness uses your Claude subscription</DialogTitle>
          <DialogDescription>
            This run dispatches the official <code>claude</code> CLI as subprocesses inheriting your
            existing subscription credentials. It does not extract or store your tokens, and it
            never calls Anthropic&apos;s API endpoints directly. Anthropic&apos;s Terms of Service
            apply to your usage. Subscription tiers are intended for personal use; for
            commercial-grade automation, use the API tier (paid per token) instead.
          </DialogDescription>
        </DialogHeader>
        <p className="text-xs text-muted-foreground">
          You will see this once. Acknowledgment is stored in browser localStorage.
        </p>
        <DialogFooter>
          <Button onClick={handleAck} data-testid="first-run-ack">
            I understand, continue
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

export function hasAckedFirstRun(): boolean {
  try {
    return localStorage.getItem(ACK_KEY) === '1';
  } catch {
    return false;
  }
}

// Exported for tests
export const FIRST_RUN_ACK_KEY = ACK_KEY;
