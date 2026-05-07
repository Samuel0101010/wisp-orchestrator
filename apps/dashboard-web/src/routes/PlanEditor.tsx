import { useEffect, useMemo, useState } from 'react';
import { FirstRunModal, hasAckedFirstRun } from '@/components/FirstRunModal';
import { useNavigate, useParams } from 'react-router-dom';
import {
  type Edge,
  type Plan,
  type Role,
  type TaskNode,
  validateDag,
} from '@agent-harness/schemas';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Textarea } from '@/components/ui/textarea';
import { toast } from '@/components/ui/use-toast';
import { ApiError } from '@/api/client';
import {
  type PlanStatus,
  useGeneratePlan,
  useGeneratedPlan,
  useLockPlan,
  usePatchPlan,
  useProject,
  useStartRun,
} from '@/api/queries';
import { PlanCanvas } from '@/components/plan/PlanCanvas';
import { PlanVersionBadge } from '@/components/PlanVersionBadge';
import { BackToProject } from '@/components/BackToProject';

const ROLES: Role[] = ['architect', 'developer', 'qa'];

function statusBadgeVariant(
  status: PlanStatus,
): 'default' | 'secondary' | 'destructive' | 'outline' {
  switch (status) {
    case 'draft':
      return 'secondary';
    case 'locked':
      return 'default';
    case 'running':
      return 'default';
    case 'done':
      return 'outline';
    case 'failed':
      return 'destructive';
    default:
      return 'secondary';
  }
}

function planEqual(a: Plan, b: Plan): boolean {
  return JSON.stringify(a) === JSON.stringify(b);
}

interface NodeEditorProps {
  plan: Plan;
  node: TaskNode;
  readOnly: boolean;
  onChange: (next: Plan) => void;
}

function NodeEditor({ plan, node, readOnly, onChange }: NodeEditorProps) {
  const otherIds = plan.nodes.filter((n) => n.id !== node.id).map((n) => n.id);

  const updateNode = (mutate: (n: TaskNode) => TaskNode): void => {
    const nextNodes = plan.nodes.map((n) => (n.id === node.id ? mutate(n) : n));
    // Recompute edges to mirror node.deps so the visual graph matches.
    const nextEdges: Edge[] = [];
    for (const n of nextNodes) {
      for (const d of n.deps) {
        nextEdges.push({ from: d, to: n.id });
      }
    }
    onChange({ ...plan, nodes: nextNodes, edges: nextEdges });
  };

  const toggleDep = (depId: string, checked: boolean): void => {
    updateNode((n) => {
      const set = new Set(n.deps);
      if (checked) set.add(depId);
      else set.delete(depId);
      return { ...n, deps: [...set] };
    });
  };

  return (
    <div className="flex flex-col gap-4">
      <div>
        <Label htmlFor="node-id">ID</Label>
        <Input id="node-id" value={node.id} readOnly disabled />
      </div>
      <div>
        <Label htmlFor="node-role">Role</Label>
        <select
          id="node-role"
          aria-label="Role"
          className="flex h-9 w-full rounded-md border border-input bg-transparent px-3 py-1 text-sm shadow-sm focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring disabled:cursor-not-allowed disabled:opacity-50"
          value={node.role}
          disabled={readOnly}
          onChange={(e) => {
            const nextRole = e.target.value as Role;
            updateNode((n) => ({ ...n, role: nextRole }));
          }}
        >
          {ROLES.map((r) => (
            <option key={r} value={r}>
              {r}
            </option>
          ))}
        </select>
      </div>
      <div>
        <Label htmlFor="node-prompt">Prompt</Label>
        <Textarea
          id="node-prompt"
          rows={6}
          value={node.prompt}
          disabled={readOnly}
          onChange={(e) => updateNode((n) => ({ ...n, prompt: e.target.value }))}
        />
      </div>
      <div>
        <Label htmlFor="node-maxturns">Max turns</Label>
        <Input
          id="node-maxturns"
          type="number"
          min={5}
          max={100}
          value={node.maxTurns}
          disabled={readOnly}
          onChange={(e) => {
            const v = Number(e.target.value);
            if (!Number.isFinite(v)) return;
            const clamped = Math.max(5, Math.min(100, Math.round(v)));
            updateNode((n) => ({ ...n, maxTurns: clamped }));
          }}
        />
      </div>
      <div>
        <Label>Deps</Label>
        {otherIds.length === 0 ? (
          <p className="text-xs text-muted-foreground">No other nodes to depend on.</p>
        ) : (
          <div className="flex flex-col gap-1.5 rounded-md border border-input p-2">
            {otherIds.map((id) => {
              const checked = node.deps.includes(id);
              return (
                <label key={id} className="flex items-center gap-2 text-sm">
                  <input
                    type="checkbox"
                    checked={checked}
                    disabled={readOnly}
                    onChange={(e) => toggleDep(id, e.target.checked)}
                  />
                  <span>{id}</span>
                </label>
              );
            })}
          </div>
        )}
      </div>
      <div>
        <Label>Success criteria</Label>
        <div className="flex flex-col gap-2">
          {(['build', 'test', 'lint', 'custom'] as const).map((key) => (
            <div key={key} className="flex flex-col gap-1">
              <Label htmlFor={`node-sc-${key}`} className="text-xs text-muted-foreground">
                {key}
              </Label>
              <Input
                id={`node-sc-${key}`}
                value={node.successCriteria[key] ?? ''}
                disabled={readOnly}
                onChange={(e) => {
                  const v = e.target.value;
                  updateNode((n) => {
                    const sc = { ...n.successCriteria };
                    if (v === '') delete sc[key];
                    else sc[key] = v;
                    return { ...n, successCriteria: sc };
                  });
                }}
              />
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}

interface PlanEditorBodyProps {
  projectId: string;
  projectName: string;
  planRow: { id: string; status: PlanStatus; dagJson: Plan };
}

function PlanEditorBody({ projectId, projectName, planRow }: PlanEditorBodyProps) {
  const [localPlan, setLocalPlan] = useState<Plan>(planRow.dagJson);
  const [selectedNodeId, setSelectedNodeId] = useState<string | null>(null);
  const [confirmRegen, setConfirmRegen] = useState(false);
  const [confirmLockRun, setConfirmLockRun] = useState(false);
  const [firstRunOpen, setFirstRunOpen] = useState(false);
  const patchPlan = usePatchPlan(planRow.id, projectId);
  const lockPlan = useLockPlan(planRow.id, projectId);
  const generatePlan = useGeneratePlan(projectId);
  const startRun = useStartRun();
  const navigate = useNavigate();

  // Re-hydrate local state if the server plan changes (e.g. after regenerate).
  useEffect(() => {
    setLocalPlan(planRow.dagJson);
    setSelectedNodeId(null);
  }, [planRow.id, planRow.dagJson]);

  const dirty = !planEqual(localPlan, planRow.dagJson);

  const validation = useMemo(() => validateDag(localPlan), [localPlan]);
  const valid = validation.ok;
  const validationErrors = valid ? [] : validation.errors;

  const readOnly = planRow.status !== 'draft';
  const selectedNode = selectedNodeId
    ? (localPlan.nodes.find((n) => n.id === selectedNodeId) ?? null)
    : null;

  const handleSave = async (): Promise<void> => {
    if (!valid || !dirty) return;
    try {
      await patchPlan.mutateAsync(localPlan);
      toast({ title: 'Plan saved' });
    } catch (err) {
      toast({
        title: 'Save failed',
        description: errorMessage(err),
        variant: 'destructive',
      });
    }
  };

  const handleLockAndRun = async (): Promise<void> => {
    setConfirmLockRun(false);
    try {
      let planId = planRow.id;
      if (planRow.status === 'draft') {
        const locked = await lockPlan.mutateAsync();
        planId = locked.id;
        toast({ title: 'Plan locked' });
      }
      const { runId } = await startRun.mutateAsync({ planId });
      toast({ title: 'Run started', description: `Run ${runId.slice(0, 8)}` });
      navigate(`/projects/${projectId}/run/${runId}`);
    } catch (err) {
      toast({
        title: 'Lock & Run failed',
        description: errorMessage(err),
        variant: 'destructive',
      });
    }
  };

  const handleRegenerate = async (): Promise<void> => {
    setConfirmRegen(false);
    try {
      await generatePlan.mutateAsync();
      toast({ title: 'Plan regenerated' });
    } catch (err) {
      toast({
        title: 'Regenerate failed',
        description: errorMessage(err),
        variant: 'destructive',
      });
    }
  };

  const canSave = !readOnly && dirty && valid;
  // Both 'draft' and 'locked' permit a run start: draft → lock-then-run,
  // locked → run-only (handleLockAndRun already conditionally skips the lock
  // step for locked plans). Without 'locked' here, a partial failure where
  // lock succeeded but startRun threw would strand the plan with no UI path
  // back to start a run.
  const canLockAndRun =
    (planRow.status === 'draft' || planRow.status === 'locked') && !dirty && valid;
  const lockAndRunLabel = planRow.status === 'locked' ? 'Run' : 'Lock & Run';

  return (
    <div className="flex h-[calc(100vh-7rem)] flex-col gap-3">
      <BackToProject />
      <div className="flex items-center justify-between gap-3 rounded-md border bg-card p-3">
        <div className="flex items-center gap-3">
          <h1 className="text-lg font-semibold">{projectName}</h1>
          <Badge variant={statusBadgeVariant(planRow.status)} data-testid="plan-status">
            {planRow.status}
          </Badge>
          <PlanVersionBadge planId={planRow.id} />
          {dirty && (
            <span className="text-xs text-muted-foreground" data-testid="dirty-indicator">
              unsaved changes
            </span>
          )}
        </div>
        <div className="flex items-center gap-2">
          <Button
            variant="outline"
            disabled={readOnly || generatePlan.isPending}
            onClick={() => setConfirmRegen(true)}
          >
            Re-generate
          </Button>
          <Button
            variant="outline"
            disabled={!canSave || patchPlan.isPending}
            onClick={() => {
              void handleSave();
            }}
          >
            {patchPlan.isPending ? 'Saving…' : 'Save'}
          </Button>
          <Button
            disabled={!canLockAndRun || lockPlan.isPending || startRun.isPending}
            onClick={() => {
              if (!hasAckedFirstRun()) {
                setFirstRunOpen(true);
              } else {
                setConfirmLockRun(true);
              }
            }}
          >
            {lockPlan.isPending ? 'Locking…' : startRun.isPending ? 'Starting…' : lockAndRunLabel}
          </Button>
        </div>
      </div>
      {!valid && (
        <div
          className="rounded-md border border-destructive/40 bg-destructive/10 p-3 text-sm text-destructive"
          data-testid="validation-banner"
        >
          <p className="font-semibold">Plan has validation errors</p>
          <ul className="ml-5 list-disc text-xs">
            {validationErrors.map((e) => (
              <li key={e}>{e}</li>
            ))}
          </ul>
        </div>
      )}
      <div className="flex flex-1 gap-3 overflow-hidden">
        <div className="relative flex-1 overflow-hidden rounded-md border bg-card">
          <PlanCanvas
            plan={localPlan}
            selectedNodeId={selectedNodeId}
            onSelectNode={setSelectedNodeId}
          />
        </div>
        <aside className="flex w-[360px] shrink-0 flex-col overflow-hidden rounded-md border bg-card">
          <div className="border-b p-3">
            <h2 className="text-sm font-semibold">
              {selectedNode ? `Edit node: ${selectedNode.id}` : 'No node selected'}
            </h2>
            <p className="text-xs text-muted-foreground">
              {selectedNode
                ? 'Edits stay local until you click Save.'
                : 'Click a node in the canvas to edit it.'}
            </p>
          </div>
          <div className="flex-1 overflow-auto p-3">
            {selectedNode ? (
              <NodeEditor
                plan={localPlan}
                node={selectedNode}
                readOnly={readOnly}
                onChange={setLocalPlan}
              />
            ) : (
              <p className="text-xs text-muted-foreground">Select a node to edit.</p>
            )}
          </div>
        </aside>
      </div>
      <FirstRunModal
        open={firstRunOpen}
        onAck={() => {
          setFirstRunOpen(false);
          setConfirmLockRun(true);
        }}
      />
      <Dialog open={confirmLockRun} onOpenChange={setConfirmLockRun}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>
              {planRow.status === 'locked' ? 'Start run?' : 'Lock plan and start run?'}
            </DialogTitle>
            <DialogDescription>
              {planRow.status === 'locked'
                ? 'Starts a run from the locked plan immediately. Tasks dispatch into git worktrees and begin executing. You can pause or cancel from the run view.'
                : 'Locking makes the plan read-only and immediately starts a run. Tasks dispatch into git worktrees and begin executing. You can pause or cancel from the run view.'}
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button variant="outline" onClick={() => setConfirmLockRun(false)}>
              Cancel
            </Button>
            <Button
              onClick={() => {
                void handleLockAndRun();
              }}
              disabled={lockPlan.isPending || startRun.isPending}
            >
              {lockPlan.isPending || startRun.isPending ? 'Starting…' : lockAndRunLabel}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
      <Dialog open={confirmRegen} onOpenChange={setConfirmRegen}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Re-generate plan?</DialogTitle>
            <DialogDescription>
              This replaces the current draft with a freshly generated plan. Unsaved edits will be
              discarded.
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button variant="outline" onClick={() => setConfirmRegen(false)}>
              Cancel
            </Button>
            <Button
              onClick={() => {
                void handleRegenerate();
              }}
              disabled={generatePlan.isPending}
            >
              {generatePlan.isPending ? 'Regenerating…' : 'Re-generate'}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}

function errorMessage(err: unknown): string {
  if (err instanceof ApiError) {
    if (typeof err.body === 'object' && err.body && 'message' in err.body) {
      return String((err.body as { message: unknown }).message);
    }
    if (typeof err.body === 'object' && err.body && 'error' in err.body) {
      return String((err.body as { error: unknown }).error);
    }
    return err.message;
  }
  return (err as Error).message;
}

export function PlanEditor() {
  const { projectId } = useParams<{ projectId?: string }>();
  const projectQuery = useProject(projectId);
  const planQuery = useGeneratedPlan(projectId);
  const generatePlan = useGeneratePlan(projectId);

  if (!projectId) {
    return (
      <Card>
        <CardHeader>
          <CardTitle>Plan Editor</CardTitle>
          <CardDescription>Select a project to view its plan.</CardDescription>
        </CardHeader>
        <CardContent />
      </Card>
    );
  }

  if (planQuery.isLoading) {
    return (
      <div className="flex h-[calc(100vh-7rem)] flex-col gap-3">
        <div className="rounded-md border bg-card p-3">
          <div className="h-5 w-40 animate-pulse rounded bg-muted" />
        </div>
        <div className="flex flex-1 gap-3 overflow-hidden">
          <div
            className="flex-1 animate-pulse rounded-md border bg-card"
            data-testid="plan-loading"
          />
          <div className="w-[360px] animate-pulse rounded-md border bg-card" />
        </div>
      </div>
    );
  }

  if (planQuery.isError) {
    return (
      <Card>
        <CardHeader>
          <CardTitle>Plan Editor</CardTitle>
          <CardDescription>Failed to load plan.</CardDescription>
        </CardHeader>
        <CardContent>
          <p className="text-sm text-destructive">{(planQuery.error as Error).message}</p>
        </CardContent>
      </Card>
    );
  }

  if (!planQuery.data) {
    const handleGenerate = async (): Promise<void> => {
      try {
        await generatePlan.mutateAsync();
        toast({ title: 'Plan generated' });
      } catch (err) {
        toast({
          title: 'Generate failed',
          description: errorMessage(err),
          variant: 'destructive',
        });
      }
    };
    return (
      <Card>
        <CardHeader>
          <CardTitle>No plan yet</CardTitle>
          <CardDescription>Generate a plan from this project's team and goal.</CardDescription>
        </CardHeader>
        <CardContent>
          <Button
            onClick={() => {
              void handleGenerate();
            }}
            disabled={generatePlan.isPending}
          >
            {generatePlan.isPending ? 'Generating…' : 'Generate Plan'}
          </Button>
        </CardContent>
      </Card>
    );
  }

  return (
    <PlanEditorBody
      projectId={projectId}
      projectName={projectQuery.data?.name ?? 'project'}
      planRow={planQuery.data}
    />
  );
}
