import { useEffect, useMemo, useState } from 'react';
import { useNavigate, useParams } from 'react-router-dom';
import type { AgentSpec, Team } from '@agent-harness/schemas';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { toast } from '@/components/ui/use-toast';
import { useGeneratePlan, useProject, useSaveTeam, useTeam } from '@/api/queries';
import { ApiError } from '@/api/client';
import { DEFAULT_TEAM } from '@/data/defaultTeam';
import {
  TeamRoleCard,
  DraftAgent,
  SYSTEM_PROMPT_MIN,
  isRoleNameValid,
} from '@/components/TeamRoleCard';
import { TeamRoleAddButton } from '@/components/TeamRoleAddButton';

const MAX_ROLES = 8;

function specToDraft(spec: AgentSpec): DraftAgent {
  return {
    role: spec.role,
    model: spec.model,
    allowedToolsText: spec.allowedTools.join(', '),
    systemPrompt: spec.systemPrompt,
  };
}

function draftToSpec(d: DraftAgent): AgentSpec {
  return {
    role: d.role.trim(),
    model: d.model,
    allowedTools: d.allowedToolsText
      .split(',')
      .map((s) => s.trim())
      .filter(Boolean),
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

  const [draft, setDraft] = useState<DraftAgent[]>(() => teamToDraft(DEFAULT_TEAM));
  const [hydrated, setHydrated] = useState(false);

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

  const projectName = projectQuery.data?.name ?? 'project';

  return (
    <div className="flex flex-col gap-6">
      <div>
        <h1 className="text-2xl font-semibold">Team Builder</h1>
        <p className="text-sm text-muted-foreground">
          Configure the agents for{' '}
          <span className="font-medium text-foreground">{projectName}</span>.
        </p>
      </div>
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
            canRemove={draft.length > 1}
            isDuplicate={d.role.trim() !== '' && dups.has(d.role.trim())}
          />
        ))}
      </div>
      <TeamRoleAddButton
        onAdd={() =>
          setDraft((arr) =>
            arr.length < MAX_ROLES
              ? [...arr, { role: '', model: 'sonnet', allowedToolsText: 'Read', systemPrompt: '' }]
              : arr,
          )
        }
        disabled={draft.length >= MAX_ROLES}
        count={draft.length}
        max={MAX_ROLES}
      />
      <div className="flex justify-end gap-2">
        {teamExists && (
          <Button variant="outline" onClick={handleGenerate} disabled={generatePlan.isPending}>
            {generatePlan.isPending ? 'Generating…' : 'Generate Plan'}
          </Button>
        )}
        <Button onClick={handleSave} disabled={!valid || saveTeam.isPending}>
          {saveTeam.isPending ? 'Saving…' : 'Save Team'}
        </Button>
      </div>
    </div>
  );
}
