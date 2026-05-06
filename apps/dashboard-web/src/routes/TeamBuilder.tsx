import { useEffect, useMemo, useState } from 'react';
import { useNavigate, useParams } from 'react-router-dom';
import type { AgentSpec, Team } from '@agent-harness/schemas';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Textarea } from '@/components/ui/textarea';
import { toast } from '@/components/ui/use-toast';
import {
  useGeneratePlan,
  useProject,
  useSaveAsTemplate,
  useSaveTeam,
  useTeam,
} from '@/api/queries';
import { ApiError } from '@/api/client';
import { DEFAULT_TEAM } from '@/data/defaultTeam';
import {
  TeamRoleCard,
  type DraftAgent,
  SYSTEM_PROMPT_MIN,
  SYSTEM_PROMPT_MAX,
  isRoleNameValid,
} from '@/components/TeamRoleCard';
import { TeamRoleAddButton } from '@/components/TeamRoleAddButton';
import { ApplyTemplateDialog } from '@/components/ApplyTemplateDialog';
import { TeamJsonDialog } from '@/components/TeamJsonDialog';
import { ComposedPromptPreviewDialog } from '@/components/ComposedPromptPreviewDialog';
import { TestPromptDialog } from '@/components/TestPromptDialog';
import { CostEstimatePanel } from '@/components/CostEstimatePanel';

const MAX_ROLES = 8;

function specToDraft(spec: AgentSpec): DraftAgent {
  return {
    role: spec.role,
    model: spec.model,
    allowedTools: [...spec.allowedTools],
    systemPrompt: spec.systemPrompt,
  };
}

function draftToSpec(d: DraftAgent): AgentSpec {
  return {
    role: d.role.trim(),
    model: d.model,
    allowedTools: d.allowedTools,
    systemPrompt: d.systemPrompt,
  };
}

function teamToDraft(team: Team): DraftAgent[] {
  return team.roles.map(specToDraft);
}

function draftToTeam(draft: DraftAgent[]): Team {
  return { roles: draft.map(draftToSpec) };
}

function findDuplicates(draft: DraftAgent[]): Set<string> {
  const counts = new Map<string, number>();
  for (const d of draft) {
    const r = d.role.trim();
    if (!r) continue;
    counts.set(r, (counts.get(r) ?? 0) + 1);
  }
  const dups = new Set<string>();
  for (const [r, n] of counts) if (n > 1) dups.add(r);
  return dups;
}

function isDraftValid(draft: DraftAgent[]): boolean {
  if (draft.length < 1 || draft.length > MAX_ROLES) return false;
  const seen = new Set<string>();
  for (const d of draft) {
    const role = d.role.trim();
    if (!isRoleNameValid(role)) return false;
    if (seen.has(role)) return false;
    seen.add(role);
    if (d.systemPrompt.length < SYSTEM_PROMPT_MIN) return false;
    if (d.systemPrompt.length > SYSTEM_PROMPT_MAX) return false;
  }
  return true;
}

function teamsEqual(a: DraftAgent[], b: Team): boolean {
  if (a.length !== b.roles.length) return false;
  for (let i = 0; i < a.length; i++) {
    const x = a[i]!;
    const y = b.roles[i]!;
    if (x.role !== y.role) return false;
    if (x.model !== y.model) return false;
    if (x.systemPrompt !== y.systemPrompt) return false;
    if (x.allowedTools.length !== y.allowedTools.length) return false;
    for (let j = 0; j < x.allowedTools.length; j++) {
      if (x.allowedTools[j] !== y.allowedTools[j]) return false;
    }
  }
  return true;
}

export function TeamBuilder() {
  const { projectId } = useParams<{ projectId?: string }>();
  const navigate = useNavigate();
  const projectQuery = useProject(projectId);
  const teamQuery = useTeam(projectId);
  const saveTeam = useSaveTeam(projectId);
  const generatePlan = useGeneratePlan(projectId);
  const saveAsTemplate = useSaveAsTemplate();

  const [draft, setDraft] = useState<DraftAgent[]>(() => teamToDraft(DEFAULT_TEAM));
  const [tplOpen, setTplOpen] = useState(false);
  const [tplId, setTplId] = useState('');
  const [tplName, setTplName] = useState('');
  const [tplDescription, setTplDescription] = useState('');
  const [hydrated, setHydrated] = useState(false);
  const [testPromptIndex, setTestPromptIndex] = useState<number | null>(null);

  // When the team query resolves, hydrate the draft once.
  useEffect(() => {
    if (hydrated) return;
    if (teamQuery.isFetching) return;
    if (teamQuery.data) {
      setDraft(teamToDraft(teamQuery.data));
    }
    setHydrated(true);
  }, [teamQuery.data, teamQuery.isFetching, hydrated]);

  const teamExists = Boolean(teamQuery.data);
  const dups = useMemo(() => findDuplicates(draft), [draft]);
  const valid = useMemo(() => isDraftValid(draft), [draft]);
  const dirty = useMemo(
    () => (teamQuery.data ? !teamsEqual(draft, teamQuery.data) : true),
    [draft, teamQuery.data],
  );

  if (!projectId) {
    return (
      <Card>
        <CardHeader>
          <CardTitle>Team Builder</CardTitle>
          <CardDescription>Select a project to configure its team.</CardDescription>
        </CardHeader>
        <CardContent />
      </Card>
    );
  }

  const handleSave = async (): Promise<void> => {
    try {
      await saveTeam.mutateAsync(draftToTeam(draft));
      toast({ title: 'Team saved' });
    } catch (err) {
      const msg =
        err instanceof ApiError
          ? typeof err.body === 'object' && err.body && 'message' in err.body
            ? String((err.body as { message: unknown }).message)
            : err.message
          : (err as Error).message;
      toast({ title: 'Save failed', description: msg, variant: 'destructive' });
    }
  };

  const handleGenerate = async (): Promise<void> => {
    try {
      await generatePlan.mutateAsync();
      navigate(`/projects/${projectId}/plan`);
    } catch (err) {
      const msg =
        err instanceof ApiError
          ? typeof err.body === 'object' && err.body && 'message' in err.body
            ? String((err.body as { message: unknown }).message)
            : err.message
          : (err as Error).message;
      toast({ title: 'Plan generation failed', description: msg, variant: 'destructive' });
    }
  };

  const handleSaveAsTemplate = async (): Promise<void> => {
    try {
      await saveAsTemplate.mutateAsync({
        id: tplId.trim(),
        name: tplName.trim(),
        description: tplDescription.trim(),
        team: draftToTeam(draft),
        suggestedGoals: ['Use this template to seed your team configuration.'],
      });
      toast({ title: 'Template saved', description: `id=${tplId.trim()}` });
      setTplOpen(false);
      setTplId('');
      setTplName('');
      setTplDescription('');
    } catch (err) {
      const msg =
        err instanceof ApiError
          ? typeof err.body === 'object' && err.body && 'message' in err.body
            ? String((err.body as { message: unknown }).message)
            : err.message
          : (err as Error).message;
      toast({ title: 'Template save failed', description: msg, variant: 'destructive' });
    }
  };

  const isTplValid =
    /^[a-z][a-z0-9-]*$/.test(tplId.trim()) &&
    tplId.trim().length >= 2 &&
    tplName.trim().length >= 2 &&
    tplDescription.trim().length >= 20;

  const projectName = projectQuery.data?.name ?? 'project';

  const moveRole = (from: number, to: number): void => {
    if (to < 0 || to >= draft.length) return;
    setDraft((arr) => {
      const copy = [...arr];
      const [picked] = copy.splice(from, 1);
      if (picked) copy.splice(to, 0, picked);
      return copy;
    });
  };

  const applyTemplate = (team: Team): void => {
    setDraft(teamToDraft(team));
    toast({ title: 'Template applied', description: `${team.roles.length} role(s) loaded` });
  };

  const generateTitle =
    !teamExists && !valid
      ? 'Configure roles and save the team first'
      : !teamExists
        ? 'Save the team first to generate a plan'
        : dirty
          ? 'Unsaved changes — save first to generate a plan'
          : '';

  const canGenerate = teamExists && !dirty && valid;

  const draftTeam = draftToTeam(draft);

  return (
    <div className="flex flex-col gap-6">
      <div>
        <h1 className="text-2xl font-semibold">Team Builder</h1>
        <p className="text-sm text-muted-foreground">
          Configure the agents for{' '}
          <span className="font-medium text-foreground">{projectName}</span>.
        </p>
      </div>
      <CostEstimatePanel team={draftTeam} projectId={projectId} />
      <div className="grid gap-4 lg:grid-cols-3">
        {draft.map((d, i) => (
          <TeamRoleCard
            key={i}
            draft={d}
            index={i}
            onChange={(next) => setDraft((arr) => arr.map((a, j) => (j === i ? next : a)))}
            onRemove={() =>
              setDraft((arr) => (arr.length > 1 ? arr.filter((_, j) => j !== i) : arr))
            }
            onMoveUp={() => moveRole(i, i - 1)}
            onMoveDown={() => moveRole(i, i + 1)}
            canRemove={draft.length > 1}
            canMoveUp={i > 0}
            canMoveDown={i < draft.length - 1}
            isDuplicate={d.role.trim() !== '' && dups.has(d.role.trim())}
            onTestPrompt={() => setTestPromptIndex(i)}
          />
        ))}
      </div>
      <TeamRoleAddButton
        onAdd={() =>
          setDraft((arr) =>
            arr.length < MAX_ROLES
              ? [...arr, { role: '', model: 'sonnet', allowedTools: ['Read'], systemPrompt: '' }]
              : arr,
          )
        }
        disabled={draft.length >= MAX_ROLES}
        count={draft.length}
        max={MAX_ROLES}
      />
      <div className="flex flex-wrap items-center justify-end gap-2">
        <ApplyTemplateDialog onApply={applyTemplate} hasContent={dirty} />
        <ComposedPromptPreviewDialog team={draftTeam} defaultGoal={projectQuery.data?.goal} />
        <TeamJsonDialog team={draftTeam} />
        <Dialog open={tplOpen} onOpenChange={setTplOpen}>
          <DialogTrigger asChild>
            <Button variant="outline" disabled={!valid}>
              Save as Template
            </Button>
          </DialogTrigger>
          <DialogContent>
            <DialogHeader>
              <DialogTitle>Save team as template</DialogTitle>
              <DialogDescription>
                Stores this team configuration to disk under your data dir. You can pick it from the
                New Project dialog later.
              </DialogDescription>
            </DialogHeader>
            <div className="flex flex-col gap-3">
              <div className="flex flex-col gap-1.5">
                <Label htmlFor="tpl-id">id (kebab-case, ≥2 chars)</Label>
                <Input
                  id="tpl-id"
                  value={tplId}
                  onChange={(e) => setTplId(e.target.value)}
                  placeholder="my-team"
                />
              </div>
              <div className="flex flex-col gap-1.5">
                <Label htmlFor="tpl-name">Name (≥2 chars)</Label>
                <Input
                  id="tpl-name"
                  value={tplName}
                  onChange={(e) => setTplName(e.target.value)}
                  placeholder="My Team"
                />
              </div>
              <div className="flex flex-col gap-1.5">
                <Label htmlFor="tpl-desc">Description (≥20 chars)</Label>
                <Textarea
                  id="tpl-desc"
                  rows={3}
                  value={tplDescription}
                  onChange={(e) => setTplDescription(e.target.value)}
                />
              </div>
            </div>
            <DialogFooter>
              <Button
                onClick={handleSaveAsTemplate}
                disabled={!isTplValid || saveAsTemplate.isPending}
              >
                {saveAsTemplate.isPending ? 'Saving…' : 'Save'}
              </Button>
            </DialogFooter>
          </DialogContent>
        </Dialog>
        <Button onClick={handleSave} disabled={!valid || saveTeam.isPending}>
          {saveTeam.isPending ? 'Saving…' : 'Save Team'}
        </Button>
        <Button
          variant="default"
          onClick={handleGenerate}
          disabled={!canGenerate || generatePlan.isPending}
          title={generateTitle || undefined}
          data-testid="generate-plan"
        >
          {generatePlan.isPending ? 'Generating…' : 'Generate Plan'}
        </Button>
      </div>
      {testPromptIndex != null && draft[testPromptIndex] && (
        <TestPromptDialog
          open
          onOpenChange={(v) => {
            if (!v) setTestPromptIndex(null);
          }}
          draft={draft[testPromptIndex]!}
        />
      )}
    </div>
  );
}
