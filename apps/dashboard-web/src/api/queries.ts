import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import type {
  Plan,
  Project,
  Run,
  RunOutcome,
  RunPausedReason,
  RunStatus,
  Task,
  Team,
} from '@agent-harness/schemas';
import { ApiError, apiFetch } from './client';

export interface HealthResponse {
  status: 'ok' | string;
}

export function useHealth() {
  return useQuery<HealthResponse>({
    queryKey: ['health'],
    queryFn: () => apiFetch<HealthResponse>('/api/health'),
    retry: false,
  });
}

export function useProjects() {
  return useQuery<Project[]>({
    queryKey: ['projects'],
    queryFn: async () => {
      try {
        return await apiFetch<Project[]>('/api/projects');
      } catch {
        // backend may not be running yet — return an empty list
        return [];
      }
    },
  });
}

export function useProject(projectId: string | undefined) {
  return useQuery<Project | null>({
    queryKey: ['project', projectId ?? null],
    enabled: Boolean(projectId),
    queryFn: async () => {
      if (!projectId) return null;
      try {
        return await apiFetch<Project>(`/api/projects/${projectId}`);
      } catch (err) {
        if (err instanceof ApiError && err.status === 404) return null;
        throw err;
      }
    },
  });
}

export interface CreateProjectInput {
  name: string;
  goal: string;
  repoPath: string;
}

export function useCreateProject() {
  const qc = useQueryClient();
  return useMutation<Project, Error, CreateProjectInput>({
    mutationFn: (input) =>
      apiFetch<Project>('/api/projects', {
        method: 'POST',
        body: JSON.stringify(input),
      }),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ['projects'] });
    },
  });
}

export function useTeam(projectId: string | undefined) {
  return useQuery<Team | null>({
    queryKey: ['team', projectId ?? null],
    enabled: Boolean(projectId),
    queryFn: async () => {
      if (!projectId) return null;
      try {
        return await apiFetch<Team>(`/api/projects/${projectId}/team`);
      } catch (err) {
        if (err instanceof ApiError && err.status === 404) return null;
        throw err;
      }
    },
  });
}

export function useSaveTeam(projectId: string | undefined) {
  const qc = useQueryClient();
  return useMutation<Team, Error, Team>({
    mutationFn: (team) => {
      if (!projectId) throw new Error('No project selected');
      return apiFetch<Team>(`/api/projects/${projectId}/team`, {
        method: 'PUT',
        body: JSON.stringify(team),
      });
    },
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ['team', projectId] });
    },
  });
}

export type PlanStatus = 'draft' | 'locked' | 'running' | 'done' | 'failed';

export interface PlanRowResponse {
  id: string;
  projectId: string;
  status: PlanStatus;
  dagJson: Plan;
  plan?: Plan;
  attempts?: number;
}

export function useGeneratePlan(projectId: string | undefined) {
  const qc = useQueryClient();
  return useMutation<PlanRowResponse, Error, void>({
    mutationFn: () => {
      if (!projectId) throw new Error('No project selected');
      return apiFetch<PlanRowResponse>(`/api/projects/${projectId}/plan`, {
        method: 'POST',
        body: JSON.stringify({}),
      });
    },
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ['plan', projectId] });
    },
  });
}

export function useGeneratedPlan(projectId: string | undefined) {
  return useQuery<PlanRowResponse | null>({
    queryKey: ['plan', projectId ?? null],
    enabled: Boolean(projectId),
    queryFn: async () => {
      if (!projectId) return null;
      try {
        return await apiFetch<PlanRowResponse>(`/api/projects/${projectId}/plan`);
      } catch (err) {
        if (err instanceof ApiError && err.status === 404) return null;
        throw err;
      }
    },
  });
}

export function usePatchPlan(planId: string | undefined, projectId: string | undefined) {
  const qc = useQueryClient();
  return useMutation<PlanRowResponse, Error, Plan>({
    mutationFn: (dagJson) => {
      if (!planId) throw new Error('No plan id');
      return apiFetch<PlanRowResponse>(`/api/plans/${planId}`, {
        method: 'PATCH',
        body: JSON.stringify({ dagJson }),
      });
    },
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ['plan', projectId] });
    },
  });
}

export function useLockPlan(planId: string | undefined, projectId: string | undefined) {
  const qc = useQueryClient();
  return useMutation<PlanRowResponse, Error, void>({
    mutationFn: () => {
      if (!planId) throw new Error('No plan id');
      return apiFetch<PlanRowResponse>(`/api/plans/${planId}/lock`, {
        method: 'POST',
        body: JSON.stringify({}),
      });
    },
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ['plan', projectId] });
    },
  });
}

// ---------- runs ----------

export interface RunSnapshotResponse {
  run: Run;
  tasks: Task[];
  lastCheckpoint: { id: string; runId: string; snapshotPath: string; ts: string | Date } | null;
}

export function useRun(runId: string | undefined) {
  return useQuery<RunSnapshotResponse | null>({
    queryKey: ['run', runId ?? null],
    enabled: Boolean(runId),
    refetchInterval: 5000,
    queryFn: async () => {
      if (!runId) return null;
      try {
        return await apiFetch<RunSnapshotResponse>(`/api/runs/${runId}`);
      } catch (err) {
        if (err instanceof ApiError && err.status === 404) return null;
        throw err;
      }
    },
  });
}

export interface StartRunInput {
  planId: string;
  budgetMinutes?: number;
  budgetTurns?: number;
  maxParallel?: number;
}

export function useStartRun() {
  return useMutation<{ runId: string }, Error, StartRunInput>({
    mutationFn: (input) =>
      apiFetch<{ runId: string }>('/api/runs', {
        method: 'POST',
        body: JSON.stringify(input),
      }),
  });
}

function makeRunActionMutation(action: 'pause' | 'resume' | 'cancel') {
  return function useRunAction(runId: string | undefined) {
    const qc = useQueryClient();
    return useMutation<Run, Error, void>({
      mutationFn: () => {
        if (!runId) throw new Error('No run id');
        return apiFetch<Run>(`/api/runs/${runId}/${action}`, {
          method: 'POST',
          body: JSON.stringify({}),
        });
      },
      onSuccess: () => {
        void qc.invalidateQueries({ queryKey: ['run', runId] });
      },
    });
  };
}

export const usePauseRun = makeRunActionMutation('pause');
export const useResumeRun = makeRunActionMutation('resume');
export const useCancelRun = makeRunActionMutation('cancel');

export interface ProjectRunRow {
  id: string;
  planId: string;
  status: RunStatus;
  outcome: RunOutcome | null;
  startedAt: string | Date | null;
  endedAt: string | Date | null;
  pausedReason: RunPausedReason | null;
  resumeAt: string | Date | null;
}

export function useProjectRuns(projectId: string | undefined) {
  return useQuery<ProjectRunRow[]>({
    queryKey: ['project-runs', projectId ?? null],
    enabled: Boolean(projectId),
    queryFn: async () => {
      if (!projectId) return [];
      try {
        return await apiFetch<ProjectRunRow[]>(`/api/projects/${projectId}/runs`);
      } catch (err) {
        if (err instanceof ApiError && err.status === 404) return [];
        throw err;
      }
    },
  });
}
