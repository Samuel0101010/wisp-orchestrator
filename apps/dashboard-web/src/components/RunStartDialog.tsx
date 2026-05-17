import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Lightbulb, Play } from 'lucide-react';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from './ui/dialog';
import { Button } from './ui/button';

const GOAL_TRUNCATE_LEN = 300;

export interface RunStartDialogProps {
  open: boolean;
  goal: string;
  starting: boolean;
  onOpenChange: (open: boolean) => void;
  onConfirm: () => void;
  onCancel: () => void;
  onGotoPreview: () => void;
}

export function RunStartDialog({
  open,
  goal,
  starting,
  onOpenChange,
  onConfirm,
  onCancel,
  onGotoPreview,
}: RunStartDialogProps) {
  const { t } = useTranslation();
  const [expanded, setExpanded] = useState(false);

  const needsTruncate = goal.length > GOAL_TRUNCATE_LEN;
  const shown = !needsTruncate || expanded ? goal : `${goal.slice(0, GOAL_TRUNCATE_LEN)}…`;

  const handleCancel = (): void => {
    onCancel();
  };

  const handleConfirm = (): void => {
    onConfirm();
  };

  const handleGotoPreview = (): void => {
    onGotoPreview();
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent data-testid="run-start-dialog">
        <DialogHeader>
          <DialogTitle>{t('projectDetail.runStart.title')}</DialogTitle>
          <DialogDescription>{t('projectDetail.runStart.description')}</DialogDescription>
        </DialogHeader>

        <div className="flex flex-col gap-3">
          <div className="flex flex-col gap-1">
            <p className="text-2xs font-medium uppercase tracking-wide text-muted-foreground">
              {t('projectDetail.runStart.goalLabel')}
            </p>
            <p
              className="whitespace-pre-wrap rounded-md border bg-muted/40 p-3 text-sm leading-relaxed"
              data-testid="run-start-goal"
            >
              {shown}
            </p>
            {needsTruncate && (
              <Button
                type="button"
                variant="ghost"
                size="sm"
                className="self-start px-2 text-xs"
                onClick={() => setExpanded((v) => !v)}
                data-testid="run-start-goal-toggle"
              >
                {expanded
                  ? t('projectDetail.runStart.collapseGoal')
                  : t('projectDetail.runStart.expandGoal')}
              </Button>
            )}
          </div>

          <div
            className="flex items-start gap-2 rounded-md border border-amber-500/30 bg-amber-500/10 p-3 text-xs"
            data-testid="run-start-iteration-hint"
          >
            <Lightbulb className="mt-0.5 h-4 w-4 shrink-0 text-amber-600 dark:text-amber-400" />
            <div className="flex flex-col gap-2">
              <p className="leading-relaxed">{t('projectDetail.runStart.iterationHint')}</p>
              <Button
                type="button"
                variant="outline"
                size="sm"
                onClick={handleGotoPreview}
                data-testid="run-start-goto-preview"
                className="self-start"
              >
                {t('projectDetail.runStart.gotoPreview')}
              </Button>
            </div>
          </div>
        </div>

        <DialogFooter>
          <Button
            type="button"
            variant="ghost"
            onClick={handleCancel}
            disabled={starting}
            data-testid="run-start-cancel"
          >
            {t('buttons.cancel')}
          </Button>
          <Button
            type="button"
            onClick={handleConfirm}
            disabled={starting}
            data-testid="run-start-confirm"
          >
            <Play className="mr-2 h-4 w-4" />
            {starting ? t('projectDetail.actions.starting') : t('projectDetail.runStart.confirm')}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
