import { useEffect, useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { useNavigate, useParams } from 'react-router-dom';
import { Info } from 'lucide-react';
import {
  DndContext,
  KeyboardSensor,
  PointerSensor,
  closestCenter,
  useSensor,
  useSensors,
  type DragEndEvent,
} from '@dnd-kit/core';
import {
  SortableContext,
  arrayMove,
  rectSortingStrategy,
  sortableKeyboardCoordinates,
} from '@dnd-kit/sortable';
import type { AgentSpec, Team } from '@wisp/schemas';
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
import { Skeleton } from '@/components/ui/skeleton';
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
  type DraftAgent,
  SYSTEM_PROMPT_MIN,
  SYSTEM_PROMPT_MAX,
  isRoleNameValid,
} from '@/components/TeamRoleCard';
import { SortableTeamRoleCard } from '@/components/SortableTeamRoleCard';
import { TeamRoleAddButton } from '@/components/TeamRoleAddButton';
import { ApplyTemplateDialog } from '@/components/ApplyTemplateDialog';
import { TeamJsonDialog } from '@/components/TeamJsonDialog';
import { ComposedPromptPreviewDialog } from '@/components/ComposedPromptPreviewDialog';
import { TestPromptDialog } from '@/components/TestPromptDialog';
import { CostEstimatePanel } from '@/components/CostEstimatePanel';
import { BackToProject } from '@/components/BackToProject';

const MAX_ROLES = 8;

// Exported for unit tests — the agentId soft-link must survive this round-trip.
export function specToDraft(spec: AgentSpec): DraftAgent {
  return {
    role: spec.role,
    model: spec.model,
    allowedTools: [...spec.allowedTools],
    systemPrompt: spec.systemPrompt,
    agentId: spec.agentId,
  };
}

export function draftToSpec(d: DraftAgent): AgentSpec {
  return {
    role: d.role.trim(),
    model: d.model,
    allowedTools: d.allowedTools,
    systemPrompt: d.systemPrompt,
    ...(d.agentId ? { agentId: d.agentId } : {}),
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

// Per-row stable identifier. crypto.randomUUID is widely available in modern
// browsers; fall back to a Math.random-based suffix so non-UUID environments
// (older test runtimes) still get unique strings.
function generateRowId(): string {
  if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') {
    return crypto.randomUUID();
  }
  return `row-${Math.random().toString(36).slice(2, 11)}-${Date.now().toString(36)}`;
}

function teamsEqual(a: DraftAgent[], b: Team): boolean {
  if (a.length !== b.roles.length) return false;
  for (let i = 0; i < a.length; i++) {
    const x = a[i]!;
    const y = b.roles[i]!;
    if (x.role !== y.role) return false;
    if (x.agentId !== y.agentId) return false;
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
  const { t } = useTranslation();
  const { projectId } = useParams<{ projectId?: string }>();
  const navigate = useNavigate();
  const projectQuery = useProject(projectId);
  const teamQuery = useTeam(projectId);
  const saveTeam = useSaveTeam(projectId);
  const generatePlan = useGeneratePlan(projectId);
  const saveAsTemplate = useSaveAsTemplate();

  const [draft, setDraft] = useState<DraftAgent[]>(() => teamToDraft(DEFAULT_TEAM));
  // Stable sortable IDs, one per draft entry. dnd-kit needs IDs that survive
  // reorders without depending on the role-name string (which can be empty
  // mid-typing). We update this array in lockstep with draft on every
  // add/remove/move/template-apply/hydrate.
  const [ids, setIds] = useState<string[]>(() => draft.map(() => generateRowId()));
  const [tplOpen, setTplOpen] = useState(false);
  const [tplId, setTplId] = useState('');
  const [tplName, setTplName] = useState('');
  const [tplDescription, setTplDescription] = useState('');
  const [hydrated, setHydrated] = useState(false);
  // Tied to the row's stable id (not its positional index), so the dialog
  // continues to show the original role's content even if the user reorders
  // the team — via drag, arrow click, or template-apply — while the dialog
  // is open. If the row is removed entirely, indexOf returns -1 and we
  // close the dialog by rendering null.
  const [testPromptId, setTestPromptId] = useState<string | null>(null);

  const sensors = useSensors(
    useSensor(PointerSensor, {
      // Require 5px of movement before starting a drag — without this, every
      // click on an interactive element inside the card (input focus, button
      // press) gets interpreted as a drag attempt.
      activationConstraint: { distance: 5 },
    }),
    useSensor(KeyboardSensor, { coordinateGetter: sortableKeyboardCoordinates }),
  );

  // When the team query resolves, hydrate the draft once.
  useEffect(() => {
    if (hydrated) return;
    if (teamQuery.isFetching) return;
    if (teamQuery.data) {
      const next = teamToDraft(teamQuery.data);
      setDraft(next);
      setIds(next.map(() => generateRowId()));
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
          <CardTitle>{t('teamBuilder.title')}</CardTitle>
          <CardDescription>{t('teamBuilder.selectProject')}</CardDescription>
        </CardHeader>
        <CardContent />
      </Card>
    );
  }

  const handleSave = async (): Promise<void> => {
    try {
      await saveTeam.mutateAsync(draftToTeam(draft));
      toast({ title: t('teamBuilder.toasts.saved') });
    } catch (err) {
      const msg =
        err instanceof ApiError
          ? typeof err.body === 'object' && err.body && 'message' in err.body
            ? String((err.body as { message: unknown }).message)
            : err.message
          : (err as Error).message;
      toast({
        title: t('teamBuilder.toasts.saveFailed'),
        description: msg,
        variant: 'destructive',
      });
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
      toast({
        title: t('teamBuilder.toasts.planGenFailed'),
        description: msg,
        variant: 'destructive',
      });
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
      toast({ title: t('teamBuilder.toasts.templateSaved'), description: `id=${tplId.trim()}` });
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
      toast({
        title: t('teamBuilder.toasts.templateSaveFailed'),
        description: msg,
        variant: 'destructive',
      });
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
    setDraft((arr) => arrayMove(arr, from, to));
    setIds((arr) => arrayMove(arr, from, to));
  };

  const handleDragEnd = (event: DragEndEvent): void => {
    const { active, over } = event;
    if (!over || active.id === over.id) return;
    const oldIndex = ids.indexOf(String(active.id));
    const newIndex = ids.indexOf(String(over.id));
    if (oldIndex < 0 || newIndex < 0) return;
    setDraft((arr) => arrayMove(arr, oldIndex, newIndex));
    setIds((arr) => arrayMove(arr, oldIndex, newIndex));
  };

  const applyTemplate = (team: Team): void => {
    const next = teamToDraft(team);
    setDraft(next);
    setIds(next.map(() => generateRowId()));
    toast({
      title: t('teamBuilder.toasts.templateApplied'),
      description: t('teamBuilder.toasts.rolesLoaded_other', { count: team.roles.length }),
    });
  };

  const generateTitle =
    !teamExists && !valid
      ? t('teamBuilder.generateTitle.noTeamUnsaved')
      : !teamExists
        ? t('teamBuilder.generateTitle.saveFirst')
        : dirty
          ? t('teamBuilder.generateTitle.unsaved')
          : '';

  const canGenerate = teamExists && !dirty && valid;

  const draftTeam = draftToTeam(draft);

  return (
    <div className="flex flex-col gap-6">
      <div className="flex flex-col gap-2">
        <BackToProject />
        <h1 className="text-2xl font-semibold">{t('teamBuilder.title')}</h1>
        <p className="text-sm text-muted-foreground">
          {t('teamBuilder.subtitle', { name: projectName })}
        </p>
      </div>
      <CostEstimatePanel team={draftTeam} projectId={projectId} />
      {teamQuery.isFetching && !hydrated ? (
        <div
          className="grid gap-4 lg:grid-cols-3"
          data-testid="team-hydration-skeleton"
          role="status"
          aria-busy="true"
          aria-label={t('teamBuilder.loading')}
        >
          {Array.from({ length: 3 }).map((_, i) => (
            <div key={i} className="space-y-3 rounded-md border border-border bg-card p-4">
              <Skeleton className="h-5 w-1/3" />
              <Skeleton className="h-4 w-2/3" />
              <Skeleton className="h-40 w-full" />
            </div>
          ))}
        </div>
      ) : (
        <DndContext sensors={sensors} collisionDetection={closestCenter} onDragEnd={handleDragEnd}>
          <SortableContext items={ids} strategy={rectSortingStrategy}>
            <div className="grid gap-4 lg:grid-cols-3">
              {draft.map((d, i) => (
                <SortableTeamRoleCard
                  key={ids[i] ?? i}
                  id={ids[i] ?? `fallback-${i}`}
                  draft={d}
                  index={i}
                  onChange={(next) => setDraft((arr) => arr.map((a, j) => (j === i ? next : a)))}
                  onRemove={() => {
                    if (draft.length <= 1) return;
                    setDraft((arr) => arr.filter((_, j) => j !== i));
                    setIds((arr) => arr.filter((_, j) => j !== i));
                  }}
                  onMoveUp={() => moveRole(i, i - 1)}
                  onMoveDown={() => moveRole(i, i + 1)}
                  canRemove={draft.length > 1}
                  canMoveUp={i > 0}
                  canMoveDown={i < draft.length - 1}
                  isDuplicate={d.role.trim() !== '' && dups.has(d.role.trim())}
                  onTestPrompt={() => setTestPromptId(ids[i] ?? null)}
                />
              ))}
            </div>
          </SortableContext>
        </DndContext>
      )}
      <TeamRoleAddButton
        onAdd={() => {
          if (draft.length >= MAX_ROLES) return;
          setDraft((arr) => [
            ...arr,
            { role: '', model: 'sonnet', allowedTools: ['Read'], systemPrompt: '' },
          ]);
          setIds((arr) => [...arr, generateRowId()]);
        }}
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
            <Button variant="outline" disabled={!valid} data-testid="save-as-template-trigger">
              {t('buttons.saveAsTemplate')}
            </Button>
          </DialogTrigger>
          <DialogContent>
            <DialogHeader>
              <DialogTitle>{t('teamBuilder.saveAsTemplateDialog.title')}</DialogTitle>
              <DialogDescription>
                {t('teamBuilder.saveAsTemplateDialog.description')}
              </DialogDescription>
            </DialogHeader>
            <div className="flex flex-col gap-3">
              <div className="flex flex-col gap-1.5">
                <Label htmlFor="tpl-id">{t('teamBuilder.saveAsTemplateDialog.id')}</Label>
                <Input
                  id="tpl-id"
                  value={tplId}
                  onChange={(e) => setTplId(e.target.value)}
                  placeholder={t('teamBuilder.saveAsTemplateDialog.idPlaceholder')}
                />
              </div>
              <div className="flex flex-col gap-1.5">
                <Label htmlFor="tpl-name">{t('teamBuilder.saveAsTemplateDialog.name')}</Label>
                <Input
                  id="tpl-name"
                  value={tplName}
                  onChange={(e) => setTplName(e.target.value)}
                  placeholder={t('teamBuilder.saveAsTemplateDialog.namePlaceholder')}
                />
              </div>
              <div className="flex flex-col gap-1.5">
                <Label htmlFor="tpl-desc">
                  {t('teamBuilder.saveAsTemplateDialog.descriptionLabel')}
                </Label>
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
                {saveAsTemplate.isPending ? t('buttons.saving') : t('buttons.save')}
              </Button>
            </DialogFooter>
          </DialogContent>
        </Dialog>
        <Button
          onClick={handleSave}
          disabled={!dirty || !valid || saveTeam.isPending}
          data-testid="save-team"
        >
          {saveTeam.isPending ? t('buttons.saving') : t('buttons.saveTeam')}
        </Button>
        <Button
          variant="default"
          onClick={handleGenerate}
          disabled={!canGenerate || generatePlan.isPending}
          title={generateTitle || undefined}
          data-testid="generate-plan"
        >
          {generatePlan.isPending ? t('buttons.generating') : t('buttons.generatePlan')}
        </Button>
      </div>
      {generateTitle && (
        <p
          className="flex items-center justify-end gap-1.5 text-xs text-muted-foreground"
          data-testid="generate-gate-reason"
        >
          <Info className="size-3.5 shrink-0" aria-hidden />
          {generateTitle}
        </p>
      )}
      {(() => {
        if (testPromptId == null) return null;
        const idx = ids.indexOf(testPromptId);
        if (idx < 0 || !draft[idx]) return null;
        return (
          <TestPromptDialog
            open
            onOpenChange={(v) => {
              if (!v) setTestPromptId(null);
            }}
            draft={draft[idx]}
          />
        );
      })()}
    </div>
  );
}
