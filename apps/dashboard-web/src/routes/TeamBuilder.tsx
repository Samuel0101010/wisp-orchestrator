import { useEffect, useMemo, useState } from 'react';
import { useNavigate, useParams } from 'react-router-dom';
import type { AgentSpec, Role, Team } from '@agent-harness/schemas';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Textarea } from '@/components/ui/textarea';
import { toast } from '@/components/ui/use-toast';
import { useGeneratePlan, useProject, useSaveTeam, useTeam } from '@/api/queries';
import { ApiError } from '@/api/client';
import { DEFAULT_TEAM } from '@/data/defaultTeam';

const SYSTEM_PROMPT_MIN = 50;
const ROLES: Role[] = ['architect', 'developer', 'qa'];

interface DraftAgent {
  role: Role;
  model: string;
  allowedToolsText: string; // comma-separated raw input
  systemPrompt: string;
}

interface Draft {
  architect: DraftAgent;
  developer: DraftAgent;
  qa: DraftAgent;
}

function specToDraft(spec: AgentSpec): DraftAgent {
  return {
    role: spec.role,
    model: spec.model,
    allowedToolsText: spec.allowedTools.join(', '),
    systemPrompt: spec.systemPrompt,
  };
}

function draftToSpec(draft: DraftAgent): AgentSpec {
  return {
    role: draft.role,
    model: draft.model.trim(),
    allowedTools: draft.allowedToolsText
      .split(',')
      .map((s) => s.trim())
      .filter(Boolean),
    systemPrompt: draft.systemPrompt,
  };
}

function teamToDraft(team: Team): Draft {
  return {
    architect: specToDraft(team.architect),
    developer: specToDraft(team.developer),
    qa: specToDraft(team.qa),
  };
}

function draftToTeam(draft: Draft): Team {
  return {
    architect: draftToSpec(draft.architect),
    developer: draftToSpec(draft.developer),
    qa: draftToSpec(draft.qa),
  };
}

function isDraftValid(draft: Draft): boolean {
  for (const role of ROLES) {
    const a = draft[role];
    if (!a.model.trim()) return false;
    if (a.systemPrompt.length < SYSTEM_PROMPT_MIN) return false;
  }
  return true;
}

interface AgentCardProps {
  role: Role;
  draft: DraftAgent;
  onChange: (next: DraftAgent) => void;
}

function roleLabel(role: Role): string {
  return role.charAt(0).toUpperCase() + role.slice(1);
}

function AgentCard({ role, draft, onChange }: AgentCardProps) {
  const promptLen = draft.systemPrompt.length;
  const promptShort = promptLen < SYSTEM_PROMPT_MIN;
  return (
    <Card>
      <CardHeader>
        <div className="flex items-center justify-between">
          <CardTitle>{roleLabel(role)}</CardTitle>
          <Badge variant="secondary" data-testid={`badge-${role}`}>
            {draft.model || 'no model'}
          </Badge>
        </div>
        <CardDescription>Configure the {roleLabel(role)} agent.</CardDescription>
      </CardHeader>
      <CardContent className="flex flex-col gap-4">
        <div className="flex flex-col gap-1.5">
          <Label htmlFor={`${role}-model`}>Model</Label>
          <Input
            id={`${role}-model`}
            placeholder="opus, sonnet, haiku, inherit"
            value={draft.model}
            onChange={(e) => onChange({ ...draft, model: e.target.value })}
          />
        </div>
        <div className="flex flex-col gap-1.5">
          <Label htmlFor={`${role}-tools`}>Allowed tools</Label>
          <Input
            id={`${role}-tools`}
            placeholder="Read, Edit, Write, Bash(npm:*, git:*)"
            value={draft.allowedToolsText}
            onChange={(e) => onChange({ ...draft, allowedToolsText: e.target.value })}
          />
          <p className="text-xs text-muted-foreground">
            Comma-separated. e.g. Read, Edit, Write, Bash(npm:*, git:*)
          </p>
        </div>
        <div className="flex flex-col gap-1.5">
          <Label htmlFor={`${role}-prompt`}>System prompt</Label>
          <Textarea
            id={`${role}-prompt`}
            rows={10}
            value={draft.systemPrompt}
            onChange={(e) => onChange({ ...draft, systemPrompt: e.target.value })}
          />
          <p
            className={promptShort ? 'text-xs text-destructive' : 'text-xs text-muted-foreground'}
            data-testid={`prompt-count-${role}`}
          >
            {promptLen} / min {SYSTEM_PROMPT_MIN} characters
          </p>
        </div>
      </CardContent>
    </Card>
  );
}

export function TeamBuilder() {
  const { projectId } = useParams<{ projectId?: string }>();
  const navigate = useNavigate();
  const projectQuery = useProject(projectId);
  const teamQuery = useTeam(projectId);
  const saveTeam = useSaveTeam(projectId);
  const generatePlan = useGeneratePlan(projectId);

  const [draft, setDraft] = useState<Draft>(() => teamToDraft(DEFAULT_TEAM));
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
        <AgentCard
          role="architect"
          draft={draft.architect}
          onChange={(next) => setDraft((d) => ({ ...d, architect: next }))}
        />
        <AgentCard
          role="developer"
          draft={draft.developer}
          onChange={(next) => setDraft((d) => ({ ...d, developer: next }))}
        />
        <AgentCard
          role="qa"
          draft={draft.qa}
          onChange={(next) => setDraft((d) => ({ ...d, qa: next }))}
        />
      </div>
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
