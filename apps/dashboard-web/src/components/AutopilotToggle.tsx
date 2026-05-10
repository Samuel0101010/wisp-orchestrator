import { useState } from 'react';
import { useToggleAutopilot } from '@/api/queries';

export function AutopilotToggle({
  runId,
  initialEnabled,
  initialBudgetMinutes,
  initialBudgetTokens,
}: {
  runId: string;
  initialEnabled: boolean;
  initialBudgetMinutes: number | null;
  initialBudgetTokens: number | null;
}) {
  const [enabled, setEnabled] = useState(initialEnabled);
  const [budgetMin, setBudgetMin] = useState<string>(initialBudgetMinutes?.toString() ?? '');
  const [budgetTok, setBudgetTok] = useState<string>(initialBudgetTokens?.toString() ?? '');
  const toggle = useToggleAutopilot();

  const save = () => {
    toggle.mutate({
      runId,
      enabled,
      budgetMinutes: budgetMin ? Number(budgetMin) : undefined,
      budgetTokens: budgetTok ? Number(budgetTok) : undefined,
    });
  };

  return (
    <div className="flex items-center gap-3 rounded border border-border bg-card p-3 text-sm">
      <label className="flex items-center gap-2">
        <input type="checkbox" checked={enabled} onChange={(e) => setEnabled(e.target.checked)} />
        <span className="font-medium">Autopilot</span>
      </label>
      <input
        type="number" min={1} placeholder="budget min"
        className="w-24 rounded border border-border bg-background px-2 py-1"
        value={budgetMin} onChange={(e) => setBudgetMin(e.target.value)}
        disabled={!enabled}
      />
      <input
        type="number" min={1} placeholder="budget tokens"
        className="w-32 rounded border border-border bg-background px-2 py-1"
        value={budgetTok} onChange={(e) => setBudgetTok(e.target.value)}
        disabled={!enabled}
      />
      <button
        onClick={save}
        disabled={toggle.isPending}
        className="rounded bg-primary px-3 py-1 text-primary-foreground hover:opacity-90 disabled:opacity-50"
      >
        {toggle.isPending ? 'Saving…' : 'Save'}
      </button>
    </div>
  );
}
