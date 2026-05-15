import { useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Check } from 'lucide-react';
import { useToggleAutopilot } from '@/api/queries';

interface AutopilotToggleProps {
  runId: string;
  initialEnabled: boolean;
  initialBudgetMinutes: number | null;
  initialBudgetTokens: number | null;
}

/**
 * Autopilot + budget controls with a "saved" indicator.
 *
 * The button cycles through three states:
 *   - dirty       → enabled button labelled "Speichern" / "Save"
 *   - saving      → disabled, "Speichern…"
 *   - saved/clean → disabled, "Gespeichert" with a check icon
 *
 * `last-saved` snapshot tracks the values that were persisted server-side
 * the most recent successful save. Any local edit makes the form dirty
 * again, the save button re-enables, and on a fresh successful save the
 * snapshot moves forward.
 */
export function AutopilotToggle({
  runId,
  initialEnabled,
  initialBudgetMinutes,
  initialBudgetTokens,
}: AutopilotToggleProps) {
  const { t } = useTranslation();
  const [enabled, setEnabled] = useState(initialEnabled);
  const [budgetMin, setBudgetMin] = useState<string>(initialBudgetMinutes?.toString() ?? '');
  const [budgetTok, setBudgetTok] = useState<string>(initialBudgetTokens?.toString() ?? '');
  const [saved, setSaved] = useState({
    enabled: initialEnabled,
    budgetMin: initialBudgetMinutes?.toString() ?? '',
    budgetTok: initialBudgetTokens?.toString() ?? '',
  });
  const toggle = useToggleAutopilot();

  const dirty =
    enabled !== saved.enabled || budgetMin !== saved.budgetMin || budgetTok !== saved.budgetTok;

  // Refs let the useEffect read the latest form state without re-triggering
  // when local edits happen. Resync from server is otherwise driven solely
  // by changes to `initialEnabled` / `initialBudgetMinutes` / `initialBudgetTokens`.
  const dirtyRef = useRef(dirty);
  const pendingRef = useRef(toggle.isPending);
  useEffect(() => {
    dirtyRef.current = dirty;
    pendingRef.current = toggle.isPending;
  });

  // If the snapshot from the server changes (e.g. another tab updated, or the
  // /api/runs/:id refetch refreshes) AND the user has no unsaved local edits
  // and no save is in flight, adopt the new values as the saved baseline.
  // Skipping the resync while dirty/pending is critical: otherwise a 5s
  // background refetch in the middle of the user's edit would clobber their
  // checkbox/number inputs before they could press Speichern.
  useEffect(() => {
    if (dirtyRef.current || pendingRef.current) return;
    setEnabled(initialEnabled);
    setBudgetMin(initialBudgetMinutes?.toString() ?? '');
    setBudgetTok(initialBudgetTokens?.toString() ?? '');
    setSaved({
      enabled: initialEnabled,
      budgetMin: initialBudgetMinutes?.toString() ?? '',
      budgetTok: initialBudgetTokens?.toString() ?? '',
    });
  }, [initialEnabled, initialBudgetMinutes, initialBudgetTokens]);

  const save = (): void => {
    toggle.mutate(
      {
        runId,
        enabled,
        budgetMinutes: budgetMin ? Number(budgetMin) : undefined,
        budgetTokens: budgetTok ? Number(budgetTok) : undefined,
      },
      {
        onSuccess: () => {
          setSaved({ enabled, budgetMin, budgetTok });
        },
      },
    );
  };

  let buttonLabel: string;
  if (toggle.isPending) {
    buttonLabel = t('runView.autopilot.saving');
  } else if (dirty) {
    buttonLabel = t('runView.autopilot.save');
  } else {
    buttonLabel = t('runView.autopilot.saved');
  }
  const buttonDisabled = toggle.isPending || !dirty;

  return (
    <div className="flex items-center gap-3 rounded border border-border bg-card p-3 text-sm">
      <label className="flex items-center gap-2">
        <input type="checkbox" checked={enabled} onChange={(e) => setEnabled(e.target.checked)} />
        <span className="font-medium">{t('runView.autopilot.label')}</span>
      </label>
      <input
        type="number"
        min={1}
        placeholder={t('runView.autopilot.budgetMinPlaceholder')}
        className="w-24 rounded border border-border bg-background px-2 py-1"
        value={budgetMin}
        onChange={(e) => setBudgetMin(e.target.value)}
        disabled={!enabled}
        aria-label={t('runView.autopilot.budgetMinPlaceholder')}
      />
      <input
        type="number"
        min={1}
        placeholder={t('runView.autopilot.budgetTokensPlaceholder')}
        className="w-32 rounded border border-border bg-background px-2 py-1"
        value={budgetTok}
        onChange={(e) => setBudgetTok(e.target.value)}
        disabled={!enabled}
        aria-label={t('runView.autopilot.budgetTokensPlaceholder')}
      />
      <button
        onClick={save}
        disabled={buttonDisabled}
        data-testid="autopilot-save"
        data-dirty={dirty}
        className="inline-flex items-center gap-1.5 rounded bg-primary px-3 py-1 text-primary-foreground transition-opacity hover:opacity-90 disabled:cursor-default disabled:opacity-60"
      >
        {!toggle.isPending && !dirty && <Check className="h-3.5 w-3.5" />}
        {buttonLabel}
      </button>
    </div>
  );
}
