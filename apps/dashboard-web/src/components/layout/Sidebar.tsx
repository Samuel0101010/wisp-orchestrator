import { useState } from 'react';
import { Link, useNavigate, useParams } from 'react-router-dom';
import { Plus, FolderOpen } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { Separator } from '@/components/ui/separator';
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
  useCreateProject,
  useDailyRunCount,
  useGeneratedPlan,
  useProjectRuns,
  useProjects,
} from '@/api/queries';
import { ApiError } from '@/api/client';

export function Sidebar() {
  const [open, setOpen] = useState(false);
  const [name, setName] = useState('');
  const [goal, setGoal] = useState('');
  const [repoPath, setRepoPath] = useState('');
  const params = useParams<{ projectId?: string }>();
  const navigate = useNavigate();
  const { data: projects = [], isLoading } = useProjects();
  const createProject = useCreateProject();
  const activePlan = useGeneratedPlan(params.projectId);
  const dailyCounts = useDailyRunCount();

  const reset = (): void => {
    setName('');
    setGoal('');
    setRepoPath('');
  };

  const valid = name.trim() && goal.trim() && repoPath.trim();

  const handleCreate = async (): Promise<void> => {
    if (!valid) return;
    try {
      const project = await createProject.mutateAsync({
        name: name.trim(),
        goal: goal.trim(),
        repoPath: repoPath.trim(),
      });
      toast({ title: 'Project created', description: project.name });
      setOpen(false);
      reset();
      navigate(`/projects/${project.id}/teams`);
    } catch (err) {
      const msg =
        err instanceof ApiError
          ? typeof err.body === 'object' && err.body && 'message' in err.body
            ? String((err.body as { message: unknown }).message)
            : err.message
          : (err as Error).message;
      toast({ title: 'Create failed', description: msg, variant: 'destructive' });
    }
  };

  return (
    <aside className="flex h-full w-60 shrink-0 flex-col border-r bg-card">
      <div className="flex items-center justify-between p-4">
        <div className="flex flex-col">
          <span className="text-sm font-semibold">Agent Harness</span>
          <Badge variant="secondary" className="mt-1 w-fit text-[10px]">
            v0.1.0
          </Badge>
        </div>
      </div>
      <Separator />
      <div className="flex items-center justify-between px-4 py-3">
        <span className="text-xs uppercase tracking-wide text-muted-foreground">Projects</span>
        <Dialog
          open={open}
          onOpenChange={(o) => {
            setOpen(o);
            if (!o) reset();
          }}
        >
          <DialogTrigger asChild>
            <Button size="icon" variant="ghost" aria-label="New project">
              <Plus className="h-4 w-4" />
            </Button>
          </DialogTrigger>
          <DialogContent>
            <DialogHeader>
              <DialogTitle>New Project</DialogTitle>
              <DialogDescription>
                Create a project to start configuring a team and plan.
              </DialogDescription>
            </DialogHeader>
            <div className="flex flex-col gap-4">
              <div className="flex flex-col gap-1.5">
                <Label htmlFor="np-name">Name</Label>
                <Input
                  id="np-name"
                  placeholder="My project"
                  value={name}
                  onChange={(e) => setName(e.target.value)}
                />
              </div>
              <div className="flex flex-col gap-1.5">
                <Label htmlFor="np-goal">Goal</Label>
                <Textarea
                  id="np-goal"
                  rows={3}
                  placeholder="Describe what you want the agents to accomplish."
                  value={goal}
                  onChange={(e) => setGoal(e.target.value)}
                />
              </div>
              <div className="flex flex-col gap-1.5">
                <Label htmlFor="np-repo">Repo path</Label>
                <Input
                  id="np-repo"
                  placeholder="/absolute/path/to/repo"
                  value={repoPath}
                  onChange={(e) => setRepoPath(e.target.value)}
                />
              </div>
            </div>
            <DialogFooter>
              <Button onClick={handleCreate} disabled={!valid || createProject.isPending}>
                {createProject.isPending ? 'Creating…' : 'Create'}
              </Button>
            </DialogFooter>
          </DialogContent>
        </Dialog>
      </div>
      <nav className="flex flex-1 flex-col gap-0.5 px-2 pb-4">
        {isLoading && <span className="px-3 py-2 text-xs text-muted-foreground">Loading…</span>}
        {!isLoading && projects.length === 0 && (
          <span className="px-3 py-2 text-xs text-muted-foreground">No projects yet</span>
        )}
        {projects.map((p) => {
          const active = params.projectId === p.id;
          const status = active ? activePlan.data?.status : undefined;
          return (
            <div key={p.id} className="flex flex-col">
              <Link
                to={`/projects/${p.id}/teams`}
                className={
                  'flex items-center gap-2 rounded-md px-3 py-2 text-sm transition-colors hover:bg-accent hover:text-accent-foreground ' +
                  (active ? 'bg-accent text-accent-foreground' : 'text-muted-foreground')
                }
              >
                <FolderOpen className="h-4 w-4" />
                <span className="truncate">{p.name}</span>
                {status && (
                  <Badge
                    variant="outline"
                    className="ml-auto text-[9px] uppercase"
                    data-testid={`sidebar-plan-status-${p.id}`}
                  >
                    {status}
                  </Badge>
                )}
                {(() => {
                  const count = dailyCounts.data?.byProject[p.id] ?? 0;
                  if (count === 0) return null;
                  return (
                    <Badge
                      variant={count >= 5 ? 'destructive' : 'secondary'}
                      className={status ? 'ml-1 text-[9px]' : 'ml-auto text-[9px]'}
                      data-testid={`sidebar-daily-count-${p.id}`}
                    >
                      {count} today
                    </Badge>
                  );
                })()}
              </Link>
              {active && <RecentRuns projectId={p.id} />}
            </div>
          );
        })}
      </nav>
    </aside>
  );
}

function RecentRuns({ projectId }: { projectId: string }) {
  const runs = useProjectRuns(projectId);
  if (!runs.data || runs.data.length === 0) return null;
  const top = runs.data.slice(0, 3);
  return (
    <div className="ml-7 mr-2 flex flex-col gap-0.5 py-1" data-testid={`recent-runs-${projectId}`}>
      <span className="px-2 py-1 text-[10px] uppercase text-muted-foreground">Recent runs</span>
      {top.map((r) => (
        <Link
          key={r.id}
          to={`/projects/${projectId}/run/${r.id}`}
          className="flex items-center gap-2 rounded-md px-2 py-1 text-xs text-muted-foreground hover:bg-accent hover:text-accent-foreground"
          data-testid={`recent-run-${r.id}`}
        >
          <span className="font-mono">{r.id.slice(0, 8)}</span>
          <Badge variant="outline" className="ml-auto text-[9px] uppercase">
            {r.status}
          </Badge>
        </Link>
      ))}
    </div>
  );
}
