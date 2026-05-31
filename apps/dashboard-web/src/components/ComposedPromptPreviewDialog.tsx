import { useMemo, useState } from 'react';
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
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Textarea } from '@/components/ui/textarea';
import type { Team } from '@wisp/schemas';
import { composeTaskPromptPreview } from '@/data/composedPrompt';

interface Props {
  team: Team;
  defaultGoal?: string;
}

/**
 * Shows what an agent actually receives at runtime: system prompt + composed
 * task prompt (goal + task spec + success criteria + retry context). The
 * composeTaskPrompt logic mirrors the orchestrator's; see
 * apps/dashboard-web/src/data/composedPrompt.ts.
 */
export function ComposedPromptPreviewDialog({ team, defaultGoal }: Props) {
  const { t } = useTranslation();
  const [open, setOpen] = useState(false);
  const [roleId, setRoleId] = useState<string>(team.roles[0]?.role ?? '');
  const [goal, setGoal] = useState(defaultGoal ?? '');
  const [taskPrompt, setTaskPrompt] = useState(
    'Implement the change described in tasks.md, smallest diff that satisfies the acceptance criteria.',
  );
  const [preflight, setPreflight] = useState('pnpm install');
  const [build, setBuild] = useState('pnpm build');
  const [test, setTest] = useState('pnpm test');

  const role = team.roles.find((r) => r.role === roleId) ?? team.roles[0];

  const composed = useMemo(() => {
    if (!role) return '';
    return composeTaskPromptPreview(
      goal || '<your goal here>',
      {
        id: 'sample-1',
        role: role.role,
        prompt: taskPrompt,
        successCriteria: { preflight, build, test },
      },
      null,
    );
  }, [role, goal, taskPrompt, preflight, build, test]);

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger asChild>
        <Button variant="outline" data-testid="composed-preview-trigger">
          {t('teamBuilder.previewTaskPrompt', 'Preview Task Prompt')}
        </Button>
      </DialogTrigger>
      <DialogContent className="max-w-4xl">
        <DialogHeader>
          <DialogTitle>What the agent sees</DialogTitle>
          <DialogDescription>
            The system prompt is fixed per role. The task prompt below is what the walker composes
            and feeds to claude -p — pick a role, edit the sample inputs, and inspect the result.
          </DialogDescription>
        </DialogHeader>
        <div className="grid gap-3 lg:grid-cols-2">
          <div className="flex flex-col gap-3">
            <div className="flex flex-col gap-1.5">
              <Label htmlFor="preview-role">Role</Label>
              <select
                id="preview-role"
                value={role?.role ?? ''}
                onChange={(e) => setRoleId(e.target.value)}
                className="flex h-10 w-full rounded-md border border-input bg-background px-3 py-2 text-sm"
                data-testid="composed-preview-role"
              >
                {team.roles.map((r) => (
                  <option key={r.role} value={r.role}>
                    {r.role} ({r.model})
                  </option>
                ))}
              </select>
            </div>
            <div className="flex flex-col gap-1.5">
              <Label htmlFor="preview-goal">Goal (project-level)</Label>
              <Input
                id="preview-goal"
                value={goal}
                onChange={(e) => setGoal(e.target.value)}
                placeholder="e.g. Add hello(name) plus a vitest test"
              />
            </div>
            <div className="flex flex-col gap-1.5">
              <Label htmlFor="preview-task">Task prompt (per-task)</Label>
              <Textarea
                id="preview-task"
                rows={3}
                value={taskPrompt}
                onChange={(e) => setTaskPrompt(e.target.value)}
              />
            </div>
            <div className="grid grid-cols-3 gap-2">
              <div className="flex flex-col gap-1">
                <Label className="text-xs" htmlFor="preview-preflight">
                  preflight
                </Label>
                <Input
                  id="preview-preflight"
                  value={preflight}
                  onChange={(e) => setPreflight(e.target.value)}
                />
              </div>
              <div className="flex flex-col gap-1">
                <Label className="text-xs" htmlFor="preview-build">
                  build
                </Label>
                <Input
                  id="preview-build"
                  value={build}
                  onChange={(e) => setBuild(e.target.value)}
                />
              </div>
              <div className="flex flex-col gap-1">
                <Label className="text-xs" htmlFor="preview-test">
                  test
                </Label>
                <Input id="preview-test" value={test} onChange={(e) => setTest(e.target.value)} />
              </div>
            </div>
          </div>
          <div className="flex flex-col gap-3">
            <div>
              <p className="text-xs font-medium text-muted-foreground">
                System prompt (sent as `--system-prompt`)
              </p>
              <pre
                className="mt-1 max-h-32 overflow-auto rounded-md border bg-muted p-2 text-xs2"
                data-testid="composed-preview-system"
              >
                {role?.systemPrompt ?? ''}
              </pre>
            </div>
            <div>
              <p className="text-xs font-medium text-muted-foreground">
                Composed task prompt (piped to stdin)
              </p>
              <pre
                className="mt-1 max-h-[55vh] overflow-auto rounded-md border bg-muted p-2 text-xs2"
                data-testid="composed-preview-task"
              >
                {composed}
              </pre>
            </div>
          </div>
        </div>
        <DialogFooter>
          <Button onClick={() => setOpen(false)}>Close</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
