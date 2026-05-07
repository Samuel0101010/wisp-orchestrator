import { useTranslation } from 'react-i18next';
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
  const { t } = useTranslation();
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
          <DialogTitle>{t('firstRunModal.title')}</DialogTitle>
          <DialogDescription>{t('firstRunModal.description')}</DialogDescription>
        </DialogHeader>
        <p className="text-xs text-muted-foreground">{t('firstRunModal.footnote')}</p>
        <DialogFooter>
          <Button onClick={handleAck} data-testid="first-run-ack">
            {t('firstRunModal.acknowledge')}
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
