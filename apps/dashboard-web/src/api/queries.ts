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

export interface UpdateProjectInput {
  id: string;
  name?: string;
  goal?: string;
  repoPath?: string;
}

export function useUpdateProject() {
  const qc = useQueryClient();
  return useMutation<Project, Error, UpdateProjectInput>({
    mutationFn: ({ id, ...patch }) =>
      apiFetch<Project>(`/api/projects/${id}`, {
        method: 'PATCH',
        body: JSON.stringify(patch),
      }),
    onSuccess: (project) => {
      void qc.invalidateQueries({ queryKey: ['project', project.id] });
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
      // Saved team composition can change role assignments visible in the
      // generated plan, so invalidate the plan cache too — otherwise the
      // PlanEditor opens with stale role labels until staleTime expires.
      // Match the `?? null` fallback used by useGeneratedPlan's queryKey;
      // without it the keys diverge when projectId is undefined and the
      // invalidation silently misses the cached entry.
      void qc.invalidateQueries({ queryKey: ['plan', projectId ?? null] });
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
  tokensInTotal?: number;
  tokensOutTotal?: number;
  turnsTotal?: number;
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

export interface DailyRunCount {
  totalLast24h: number;
  byProject: Record<string, number>;
}

export function useDailyRunCount() {
  return useQuery<DailyRunCount>({
    queryKey: ['runs-daily-count'],
    queryFn: () => apiFetch<DailyRunCount>('/api/runs/daily-count'),
    refetchInterval: 60_000,
  });
}

// ----- templates -----

export interface TeamTemplate {
  id: string;
  name: string;
  description: string;
  team: Team;
  suggestedGoals: string[];
  // Optional rich metadata (added in v1.1.x — older user-saved templates may
  // not have these fields).
  useCases?: string[];
  bestFor?: string[];
  notRecommendedFor?: string[];
  complexity?: 'simple' | 'medium' | 'complex';
  expectedDurationMinutes?: number;
}

export function useTemplates() {
  return useQuery<TeamTemplate[]>({
    queryKey: ['team-templates'],
    queryFn: async () => {
      const res = await apiFetch<{ templates: TeamTemplate[] }>('/api/team-templates');
      return res.templates;
    },
  });
}

export function useSaveAsTemplate() {
  const qc = useQueryClient();
  return useMutation<{ template: TeamTemplate; path: string }, Error, TeamTemplate>({
    mutationFn: (template) =>
      apiFetch<{ template: TeamTemplate; path: string }>('/api/team-templates', {
        method: 'POST',
        body: JSON.stringify(template),
      }),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ['team-templates'] });
    },
  });
}

export interface PlanChainEntry {
  id: string;
  parentPlanId: string | null;
  status: string;
  createdAt: number | null;
}

// ----- prompt probe -----

export interface ProbePromptInput {
  systemPrompt: string;
  sampleGoal: string;
  model: 'opus' | 'sonnet' | 'haiku';
  allowedTools: string[];
}

export interface ProbePromptResult {
  response: string;
  elapsedMs: number;
  tokensIn: number;
  tokensOut: number;
  turns: number;
}

export function useProbePrompt() {
  return useMutation<ProbePromptResult, Error, ProbePromptInput>({
    mutationFn: (input) =>
      apiFetch<ProbePromptResult>('/api/probe-prompt', {
        method: 'POST',
        body: JSON.stringify(input),
      }),
  });
}

// ----- Mission Control (global) -----

export interface GlobalRunRow {
  id: string;
  planId: string;
  status: RunStatus;
  outcome: RunOutcome | null;
  startedAt: string | Date | null;
  endedAt: string | Date | null;
  budgetMinutes: number;
  budgetTurns: number;
  tokensInTotal: number;
  tokensOutTotal: number;
  turnsTotal: number;
  pausedReason: RunPausedReason | null;
  resumeAt: string | Date | null;
  projectId: string;
  projectName: string;
}

export function useGlobalRuns(limit = 100) {
  return useQuery<GlobalRunRow[]>({
    queryKey: ['global-runs', limit],
    refetchInterval: 10_000,
    queryFn: async () => {
      try {
        const res = await apiFetch<{ runs: GlobalRunRow[] }>(
          `/api/runs?include=project&limit=${limit}`,
        );
        return res.runs ?? [];
      } catch {
        return [];
      }
    },
  });
}

export interface RunsSummary {
  windowDays: number;
  activeCount: number;
  totalRuns: number;
  totalTokens: number;
  successRate: number;
  avgDurationMs: number;
  outcomeCounts: { success?: number; failure?: number; cancelled?: number; unknown?: number };
  tokensByDay: Array<{ day: string; tokens: number }>;
  runsByDay: Array<{ day: string; runs: number }>;
}

const emptySummary: RunsSummary = {
  windowDays: 7,
  activeCount: 0,
  totalRuns: 0,
  totalTokens: 0,
  successRate: 0,
  avgDurationMs: 0,
  outcomeCounts: {},
  tokensByDay: [],
  runsByDay: [],
};

export function useRunsSummary(windowDays = 7) {
  return useQuery<RunsSummary>({
    queryKey: ['runs-summary', windowDays],
    refetchInterval: 30_000,
    queryFn: async () => {
      try {
        return await apiFetch<RunsSummary>(`/api/runs/summary?windowDays=${windowDays}`);
      } catch {
        return { ...emptySummary, windowDays };
      }
    },
  });
}

export function usePlanVersionChain(planId: string | undefined) {
  return useQuery<PlanChainEntry[]>({
    queryKey: ['plan-chain', planId ?? null],
    enabled: Boolean(planId),
    queryFn: async () => {
      if (!planId) return [];
      try {
        const res = await apiFetch<{ chain: PlanChainEntry[] }>(`/api/plans/${planId}/chain`);
        return res.chain;
      } catch (err) {
        if (err instanceof ApiError && err.status === 404) return [];
        throw err;
      }
    },
  });
}
