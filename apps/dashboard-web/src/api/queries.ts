import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import type {
  Agent,
  AgentMessage,
  AgentThread,
  CreateAgentInput,
  CreateThreadInput,
  Plan,
  Project,
  Run,
  RunOutcome,
  RunPausedReason,
  RunStatus,
  SendMessageResponse,
  Task,
  Team,
  UpdateAgentInput,
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
  // Production-loop toggles. Optional so a name-only edit doesn't need to
  // resend the flags.
  autoMergeOnSuccess?: boolean;
  selfHealingEnabled?: boolean;
  maxChainIterations?: number;
  // Project-level autopilot defaults (apply to NEW runs only).
  defaultAutopilotMode?: boolean;
  defaultAutopilotBudgetMinutes?: number | null;
  defaultAutopilotBudgetTokens?: number | null;
  // v1.8 runtime-verify settings. NULL clears an existing override.
  runtimeVerifyEnabled?: boolean;
  runtimeVerifyDevCmd?: string | null;
  runtimeVerifyProbeUrl?: string | null;
}

// ---------- DoD criteria (v1.8) ----------

export type DodKind = 'smoke' | 'e2e' | 'manual';

export interface DodCriterion {
  id: string;
  projectId: string;
  title: string;
  kind: DodKind;
  specJson: Record<string, unknown>;
  position: number;
  createdAt: string | Date;
}

export interface CreateDodInput {
  title: string;
  kind: DodKind;
  spec: Record<string, unknown>;
  position?: number;
}

export interface PatchDodInput {
  id: string;
  title?: string;
  kind?: DodKind;
  spec?: Record<string, unknown>;
  position?: number;
}

export function useDodCriteria(projectId: string | undefined) {
  return useQuery<DodCriterion[]>({
    queryKey: ['dod', projectId ?? null],
    enabled: Boolean(projectId),
    queryFn: async () => {
      if (!projectId) return [];
      try {
        return await apiFetch<DodCriterion[]>(`/api/projects/${projectId}/dod`);
      } catch (err) {
        if (err instanceof ApiError && err.status === 404) return [];
        throw err;
      }
    },
  });
}

export function useCreateDod(projectId: string | undefined) {
  const qc = useQueryClient();
  return useMutation<DodCriterion, Error, CreateDodInput>({
    mutationFn: (input) => {
      if (!projectId) throw new Error('No project id');
      return apiFetch<DodCriterion>(`/api/projects/${projectId}/dod`, {
        method: 'POST',
        body: JSON.stringify(input),
      });
    },
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ['dod', projectId] });
    },
  });
}

export function usePatchDod(projectId: string | undefined) {
  const qc = useQueryClient();
  return useMutation<DodCriterion, Error, PatchDodInput>({
    mutationFn: ({ id, ...patch }) => {
      if (!projectId) throw new Error('No project id');
      return apiFetch<DodCriterion>(`/api/projects/${projectId}/dod/${id}`, {
        method: 'PATCH',
        body: JSON.stringify(patch),
      });
    },
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ['dod', projectId] });
    },
  });
}

export function useDeleteDod(projectId: string | undefined) {
  const qc = useQueryClient();
  return useMutation<void, Error, string>({
    mutationFn: async (id) => {
      if (!projectId) throw new Error('No project id');
      await apiFetch<void>(`/api/projects/${projectId}/dod/${id}`, { method: 'DELETE' });
    },
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ['dod', projectId] });
    },
  });
}

// ---------- runtime report (v1.8) ----------

export type RuntimeReportVerdict = 'pass' | 'fail' | 'skipped' | 'error';

export interface RuntimeReportRow {
  id: string;
  runId: string;
  verdict: RuntimeReportVerdict;
  bootOk: boolean;
  e2eOk: boolean;
  dodPassed: number;
  dodTotal: number;
  reportMd: string | null;
  evidenceJson: { artifacts?: string[] } | null;
  createdAt: string | Date;
}

export function useRuntimeReport(runId: string | undefined) {
  return useQuery<RuntimeReportRow | null>({
    queryKey: ['runtime-report', runId ?? null],
    enabled: Boolean(runId),
    refetchInterval: 5000,
    queryFn: async () => {
      if (!runId) return null;
      try {
        return await apiFetch<RuntimeReportRow>(`/api/runs/${runId}/runtime-report`);
      } catch (err) {
        if (err instanceof ApiError && err.status === 404) return null;
        throw err;
      }
    },
  });
}

// ---------- Project brief / interview (v1.9 Phase 1) ----------

export interface ProjectBriefRow {
  id: string;
  projectId: string;
  targetAudience: string | null;
  successCriteria: string | null;
  designPrefs: string | null;
  platform: string | null;
  constraints: string | null;
  deadline: number | null;
  completenessScore: number;
  prdPath: string | null;
  briefReady: boolean;
  createdAt: number;
  updatedAt: number;
}

export interface InterviewTranscriptMessage {
  id: string;
  threadId: string;
  role: 'user' | 'assistant';
  content: string;
  createdAt: string | Date;
  authorAgentId: string | null;
}

export interface InterviewStateResponse {
  brief: ProjectBriefRow | null;
  transcript: InterviewTranscriptMessage[];
  threadId?: string;
}

export function useInterview(projectId: string | undefined) {
  return useQuery<InterviewStateResponse>({
    queryKey: ['interview', projectId ?? null],
    enabled: Boolean(projectId),
    queryFn: async () => {
      if (!projectId) return { brief: null, transcript: [] };
      return await apiFetch<InterviewStateResponse>(`/api/projects/${projectId}/interview`);
    },
  });
}

export function useStartInterview(projectId: string | undefined) {
  const qc = useQueryClient();
  return useMutation<InterviewStateResponse, Error, void>({
    mutationFn: async () => {
      if (!projectId) throw new Error('No project id');
      return await apiFetch<InterviewStateResponse>(`/api/projects/${projectId}/interview/start`, {
        method: 'POST',
      });
    },
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ['interview', projectId] });
    },
  });
}

export interface SendInterviewMessageResponse {
  userMessage: InterviewTranscriptMessage;
  assistantMessage: InterviewTranscriptMessage;
  brief: ProjectBriefRow;
  shouldFinalize: boolean;
  parseError: string | null;
}

export function useSendInterviewMessage(projectId: string | undefined) {
  const qc = useQueryClient();
  return useMutation<SendInterviewMessageResponse, Error, string>({
    mutationFn: async (message) => {
      if (!projectId) throw new Error('No project id');
      return await apiFetch<SendInterviewMessageResponse>(
        `/api/projects/${projectId}/interview/message`,
        { method: 'POST', body: JSON.stringify({ message }) },
      );
    },
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ['interview', projectId] });
    },
  });
}

export interface FinalizeInterviewResponse {
  brief: ProjectBriefRow;
  prdPath: string | null;
  prdWriteError: string | null;
}

export function useFinalizeInterview(projectId: string | undefined) {
  const qc = useQueryClient();
  return useMutation<FinalizeInterviewResponse, Error, void>({
    mutationFn: async () => {
      if (!projectId) throw new Error('No project id');
      return await apiFetch<FinalizeInterviewResponse>(
        `/api/projects/${projectId}/interview/finalize`,
        { method: 'POST' },
      );
    },
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ['interview', projectId] });
    },
  });
}

export interface PatchBriefInput {
  targetAudience?: string | null;
  successCriteria?: string | null;
  designPrefs?: string | null;
  platform?: string | null;
  constraints?: string | null;
  deadline?: number | null;
  completenessScore?: number;
  briefReady?: boolean;
}

export function usePatchBrief(projectId: string | undefined) {
  const qc = useQueryClient();
  return useMutation<{ brief: ProjectBriefRow }, Error, PatchBriefInput>({
    mutationFn: async (patch) => {
      if (!projectId) throw new Error('No project id');
      return await apiFetch<{ brief: ProjectBriefRow }>(`/api/projects/${projectId}/interview`, {
        method: 'PATCH',
        body: JSON.stringify(patch),
      });
    },
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ['interview', projectId] });
    },
  });
}

// ---------- Project state (v1.10 Phase 2) ----------

export interface ProjectStateRow {
  id: string;
  projectId: string;
  runId: string | null;
  stateMd: string | null;
  completedFeatures: string[];
  openTodos: string[];
  knownIssues: string[];
  architectureSnapshot: unknown | null;
  createdAt: string | Date;
}

export function useProjectState(projectId: string | undefined) {
  return useQuery<{ state: ProjectStateRow | null }>({
    queryKey: ['project-state', projectId ?? null],
    enabled: Boolean(projectId),
    refetchInterval: 30_000,
    queryFn: async () => {
      if (!projectId) return { state: null };
      return await apiFetch<{ state: ProjectStateRow | null }>(`/api/projects/${projectId}/state`);
    },
  });
}

// ---------- Preview (v1.11 Phase 3) ----------

export interface PreviewStatusResponse {
  running: boolean;
  port?: number;
  pid?: number;
  startedAt?: number;
  status?: 'starting' | 'running' | 'error' | 'stopped';
  error?: string;
}

export interface StartPreviewResponse {
  status: 'running' | 'error';
  port: number;
  pid: number | null;
  startedAt: number;
  error?: string;
}

export function usePreviewStatus(projectId: string | undefined) {
  return useQuery<PreviewStatusResponse>({
    queryKey: ['preview-status', projectId ?? null],
    enabled: Boolean(projectId),
    refetchInterval: (query) => (query.state.data?.running ? 2000 : 5000),
    queryFn: async () => {
      if (!projectId) return { running: false };
      try {
        return await apiFetch<PreviewStatusResponse>(`/api/projects/${projectId}/preview/status`);
      } catch {
        return { running: false };
      }
    },
  });
}

export function useStartPreview(projectId: string | undefined) {
  const qc = useQueryClient();
  return useMutation<StartPreviewResponse, Error, void>({
    mutationFn: async () => {
      if (!projectId) throw new Error('No project id');
      return await apiFetch<StartPreviewResponse>(`/api/projects/${projectId}/preview/start`, {
        method: 'POST',
      });
    },
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ['preview-status', projectId] });
    },
  });
}

export function useStopPreview(projectId: string | undefined) {
  const qc = useQueryClient();
  return useMutation<{ stopped: boolean }, Error, void>({
    mutationFn: async () => {
      if (!projectId) throw new Error('No project id');
      return await apiFetch<{ stopped: boolean }>(`/api/projects/${projectId}/preview/stop`, {
        method: 'POST',
      });
    },
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ['preview-status', projectId] });
    },
  });
}

// ---------- Change requests (v1.12 Phase 4) ----------

export type ChangeRequestStatus = 'pending' | 'in-run' | 'done' | 'dismissed';
export type ChangeRequestSource = 'visual' | 'text';

export interface ChangeRequestRect {
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface ChangeRequestRow {
  id: string;
  projectId: string;
  runId: string | null;
  status: ChangeRequestStatus;
  source: ChangeRequestSource;
  selector: string | null;
  rectJson: ChangeRequestRect | null;
  screenshotPath: string | null;
  userPrompt: string;
  createdAt: number;
  resolvedAt: number | null;
}

export function useChangeRequests(projectId: string | undefined, status?: ChangeRequestStatus) {
  return useQuery<ChangeRequestRow[]>({
    queryKey: ['change-requests', projectId ?? null, status ?? 'pending'],
    enabled: Boolean(projectId),
    refetchInterval: 5000,
    queryFn: async () => {
      if (!projectId) return [];
      const qs = status ? `?status=${encodeURIComponent(status)}` : '';
      try {
        return await apiFetch<ChangeRequestRow[]>(
          `/api/projects/${projectId}/change-requests${qs}`,
        );
      } catch (err) {
        if (err instanceof ApiError && err.status === 404) return [];
        throw err;
      }
    },
  });
}

export interface CreateChangeRequestInput {
  source: ChangeRequestSource;
  selector?: string;
  rectJson?: ChangeRequestRect;
  userPrompt: string;
}

export function useCreateChangeRequest(projectId: string | undefined) {
  const qc = useQueryClient();
  return useMutation<ChangeRequestRow, Error, CreateChangeRequestInput>({
    mutationFn: async (input) => {
      if (!projectId) throw new Error('No project id');
      return await apiFetch<ChangeRequestRow>(`/api/projects/${projectId}/change-requests`, {
        method: 'POST',
        body: JSON.stringify(input),
      });
    },
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ['change-requests', projectId] });
    },
  });
}

export interface PatchChangeRequestInput {
  id: string;
  status?: ChangeRequestStatus;
  userPrompt?: string;
}

export function usePatchChangeRequest(projectId: string | undefined) {
  const qc = useQueryClient();
  return useMutation<ChangeRequestRow, Error, PatchChangeRequestInput>({
    mutationFn: async ({ id, ...patch }) => {
      if (!projectId) throw new Error('No project id');
      return await apiFetch<ChangeRequestRow>(`/api/projects/${projectId}/change-requests/${id}`, {
        method: 'PATCH',
        body: JSON.stringify(patch),
      });
    },
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ['change-requests', projectId] });
    },
  });
}

export function useDeleteChangeRequest(projectId: string | undefined) {
  const qc = useQueryClient();
  return useMutation<void, Error, string>({
    mutationFn: async (id) => {
      if (!projectId) throw new Error('No project id');
      await apiFetch<void>(`/api/projects/${projectId}/change-requests/${id}`, {
        method: 'DELETE',
      });
    },
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ['change-requests', projectId] });
    },
  });
}

export interface RunIterationResult {
  planId: string;
  runId: string;
}

/**
 * Chains the three calls needed to kick off an iteration run from the queue:
 *   1. POST /api/projects/:id/plan  → generate iteration plan with the queue
 *   2. POST /api/plans/:planId/lock → flip draft → locked
 *   3. POST /api/runs               → start run + link change_requests
 * Each step is awaited sequentially; on failure the thrown error includes
 * which step failed so the caller can toast a meaningful message.
 */
export function useRunIteration(projectId: string | undefined) {
  const qc = useQueryClient();
  return useMutation<RunIterationResult, Error, { changeRequestIds: string[] }>({
    mutationFn: async ({ changeRequestIds }) => {
      if (!projectId) throw new Error('No project id');
      let planId: string;
      try {
        const planRes = await apiFetch<{ id: string }>(`/api/projects/${projectId}/plan`, {
          method: 'POST',
          body: JSON.stringify({ changeRequestIds }),
        });
        planId = planRes.id;
      } catch (err) {
        throw new Error(`Step 1/3 failed: ${(err as Error).message}`);
      }
      try {
        await apiFetch(`/api/plans/${planId}/lock`, { method: 'POST' });
      } catch (err) {
        throw new Error(`Step 2/3 failed: lock plan (${(err as Error).message})`);
      }
      let runId: string;
      try {
        const runRes = await apiFetch<{ runId: string }>(`/api/runs`, {
          method: 'POST',
          body: JSON.stringify({ planId, changeRequestIds }),
        });
        runId = runRes.runId;
      } catch (err) {
        throw new Error(`Step 3/3 failed: start run (${(err as Error).message})`);
      }
      return { planId, runId };
    },
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ['change-requests', projectId] });
      void qc.invalidateQueries({ queryKey: ['runs', projectId] });
      void qc.invalidateQueries({ queryKey: ['project-runs', projectId] });
    },
  });
}

// ---------- Org chart (v1.13 Phase 5) ----------

export interface OrgChartRole {
  role: string;
  displayName: string;
  model: 'opus' | 'sonnet' | 'haiku';
  avatarUrl: string | null;
  color: string | null;
  description: string | null;
  allowedToolsCount: number;
  seedKey: string | null;
  agentId: string | null;
}

export interface OrgChartEdge {
  from: string;
  to: string;
  kind: 'plan-dep' | 'handoff';
}

export interface OrgChartLiveStatus {
  role: string;
  status: 'idle' | 'working' | 'done' | 'failed';
  lastTaskId?: string;
  lastUpdatedAt?: number;
}

export interface OrgChartResponse {
  roles: OrgChartRole[];
  edges: OrgChartEdge[];
  liveStatus: OrgChartLiveStatus[];
  latestPlanId: string | null;
  latestRunId: string | null;
}

export function useOrgChart(projectId: string | undefined) {
  return useQuery<OrgChartResponse>({
    queryKey: ['org-chart', projectId ?? null],
    enabled: Boolean(projectId),
    refetchInterval: 5000,
    queryFn: async () => {
      if (!projectId) {
        return { roles: [], edges: [], liveStatus: [], latestPlanId: null, latestRunId: null };
      }
      try {
        return await apiFetch<OrgChartResponse>(`/api/projects/${projectId}/org-chart`);
      } catch (err) {
        if (err instanceof ApiError && err.status === 404) {
          return { roles: [], edges: [], liveStatus: [], latestPlanId: null, latestRunId: null };
        }
        throw err;
      }
    },
  });
}

// ---------- Agent overrides (v1.14 Phase 6) ----------

export interface AgentOverrideRow {
  id: string;
  projectId: string;
  role: string;
  model: 'opus' | 'sonnet' | 'haiku' | null;
  extraSystemPrompt: string | null;
  extraAllowedTools: string[] | null;
  memoryNamespace: string | null;
  createdAt: number | string;
  updatedAt: number | string;
}

export interface AgentOverridePatch {
  model?: 'opus' | 'sonnet' | 'haiku' | null;
  extraSystemPrompt?: string | null;
  extraAllowedTools?: string[] | null;
  memoryNamespace?: string | null;
}

export function useAgentOverrides(projectId: string | undefined) {
  return useQuery<AgentOverrideRow[]>({
    queryKey: ['agent-overrides', projectId ?? null],
    enabled: Boolean(projectId),
    queryFn: async () => {
      if (!projectId) return [];
      try {
        return await apiFetch<AgentOverrideRow[]>(`/api/projects/${projectId}/agent-overrides`);
      } catch (err) {
        if (err instanceof ApiError && err.status === 404) return [];
        throw err;
      }
    },
  });
}

export function usePutAgentOverride(projectId: string | undefined) {
  const qc = useQueryClient();
  return useMutation<AgentOverrideRow, Error, { role: string; patch: AgentOverridePatch }>({
    mutationFn: async ({ role, patch }) => {
      if (!projectId) throw new Error('projectId required');
      return apiFetch<AgentOverrideRow>(
        `/api/projects/${projectId}/agent-overrides/${encodeURIComponent(role)}`,
        {
          method: 'PUT',
          body: JSON.stringify(patch),
          headers: { 'content-type': 'application/json' },
        },
      );
    },
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ['agent-overrides', projectId ?? null] });
    },
  });
}

export function useDeleteAgentOverride(projectId: string | undefined) {
  const qc = useQueryClient();
  return useMutation<void, Error, string>({
    mutationFn: async (role) => {
      if (!projectId) throw new Error('projectId required');
      await apiFetch<void>(
        `/api/projects/${projectId}/agent-overrides/${encodeURIComponent(role)}`,
        { method: 'DELETE' },
      );
    },
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ['agent-overrides', projectId ?? null] });
    },
  });
}

export interface InitRepoResponse {
  ok: true;
  alreadyInitialized: boolean;
  repoPath: string;
  head?: string;
}

/**
 * Initialize the project's working-tree as a git repo so the orchestrator's
 * `git worktree add` succeeds. Idempotent — safe to call on existing repos.
 * Wired up by PlanEditor's recovery banner when `POST /api/runs` returns
 * `{ error: 'repo_not_initialized' }`.
 */
export function useInitProjectRepo() {
  return useMutation<InitRepoResponse, Error, string>({
    mutationFn: (projectId) =>
      apiFetch<InitRepoResponse>(`/api/projects/${projectId}/init-repo`, {
        method: 'POST',
      }),
  });
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

export function useToggleAutopilot() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (input: {
      runId: string;
      enabled: boolean;
      budgetMinutes?: number;
      budgetTokens?: number;
    }) =>
      apiFetch(`/api/runs/${input.runId}/autopilot`, {
        method: 'POST',
        body: JSON.stringify({
          enabled: input.enabled,
          budgetMinutes: input.budgetMinutes,
          budgetTokens: input.budgetTokens,
        }),
      }),
    onSuccess: (_d, input) => {
      void qc.invalidateQueries({ queryKey: ['run', input.runId] });
    },
  });
}

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
  /** Self-healing chain pointers (null/0 for user-launched root runs). */
  parentRunId?: string | null;
  chainIteration?: number;
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

// ---------- Agents (Model B) ----------

export function useAgents() {
  return useQuery<Agent[]>({
    queryKey: ['agents'],
    queryFn: async () => {
      try {
        return await apiFetch<Agent[]>('/api/agents');
      } catch {
        return [];
      }
    },
  });
}

export function useAgent(agentId: string | undefined) {
  return useQuery<Agent | null>({
    queryKey: ['agent', agentId ?? null],
    enabled: Boolean(agentId),
    queryFn: async () => {
      if (!agentId) return null;
      try {
        return await apiFetch<Agent>(`/api/agents/${agentId}`);
      } catch (err) {
        if (err instanceof ApiError && err.status === 404) return null;
        throw err;
      }
    },
  });
}

export function useCreateAgent() {
  const qc = useQueryClient();
  return useMutation<Agent, Error, CreateAgentInput>({
    mutationFn: (input) =>
      apiFetch<Agent>('/api/agents', {
        method: 'POST',
        body: JSON.stringify(input),
      }),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ['agents'] });
    },
  });
}

export function useUpdateAgent() {
  const qc = useQueryClient();
  return useMutation<Agent, Error, { id: string; patch: UpdateAgentInput }>({
    mutationFn: ({ id, patch }) =>
      apiFetch<Agent>(`/api/agents/${id}`, {
        method: 'PATCH',
        body: JSON.stringify(patch),
      }),
    onSuccess: (agent) => {
      void qc.invalidateQueries({ queryKey: ['agents'] });
      void qc.invalidateQueries({ queryKey: ['agent', agent.id] });
    },
  });
}

export function useDeleteAgent() {
  const qc = useQueryClient();
  return useMutation<void, Error, { id: string; force?: boolean }>({
    mutationFn: async ({ id, force }) => {
      await apiFetch<unknown>(`/api/agents/${id}${force ? '?force=1' : ''}`, { method: 'DELETE' });
    },
    onSuccess: (_, { id }) => {
      void qc.invalidateQueries({ queryKey: ['agents'] });
      // Cascade-delete on the server removes threads + messages; drop their
      // caches too so a second tab doesn't keep serving stale rows.
      void qc.invalidateQueries({ queryKey: ['agent-threads', id] });
      void qc.invalidateQueries({ queryKey: ['agent-usage', id] });
    },
  });
}

export interface AgentUsage {
  usage: Array<{ teamId: string; projectId: string; projectName: string; role: string }>;
}

export function useAgentUsage(agentId: string | undefined) {
  return useQuery<AgentUsage>({
    queryKey: ['agent-usage', agentId ?? null],
    enabled: Boolean(agentId),
    queryFn: async () => {
      if (!agentId) return { usage: [] };
      try {
        return await apiFetch<AgentUsage>(`/api/agents/${agentId}/usage`);
      } catch {
        return { usage: [] };
      }
    },
  });
}

// ---------- Agent threads + messages ----------

export function useAgentThreads(agentId: string | undefined) {
  return useQuery<AgentThread[]>({
    queryKey: ['agent-threads', agentId ?? null],
    enabled: Boolean(agentId),
    queryFn: async () => {
      if (!agentId) return [];
      try {
        return await apiFetch<AgentThread[]>(`/api/agents/${agentId}/threads`);
      } catch {
        return [];
      }
    },
  });
}

export function useCreateThread() {
  const qc = useQueryClient();
  return useMutation<AgentThread, Error, { agentId: string; input?: CreateThreadInput }>({
    mutationFn: ({ agentId, input }) =>
      apiFetch<AgentThread>(`/api/agents/${agentId}/threads`, {
        method: 'POST',
        body: JSON.stringify(input ?? {}),
      }),
    onSuccess: (thread) => {
      void qc.invalidateQueries({ queryKey: ['agent-threads', thread.agentId] });
    },
  });
}

export function useDeleteThread() {
  const qc = useQueryClient();
  return useMutation<void, Error, { threadId: string; agentId: string }>({
    mutationFn: async ({ threadId }) => {
      await apiFetch<unknown>(`/api/threads/${threadId}`, { method: 'DELETE' });
    },
    onSuccess: (_, { threadId, agentId }) => {
      void qc.invalidateQueries({ queryKey: ['agent-threads', agentId] });
      void qc.invalidateQueries({ queryKey: ['thread-messages', threadId] });
      void qc.invalidateQueries({ queryKey: ['thread', threadId] });
    },
  });
}

export function useThreadMessages(threadId: string | undefined) {
  return useQuery<AgentMessage[]>({
    queryKey: ['thread-messages', threadId ?? null],
    enabled: Boolean(threadId),
    queryFn: async () => {
      if (!threadId) return [];
      try {
        return await apiFetch<AgentMessage[]>(`/api/threads/${threadId}/messages`);
      } catch {
        return [];
      }
    },
  });
}

export function useSendMessage() {
  const qc = useQueryClient();
  return useMutation<
    SendMessageResponse,
    Error,
    { threadId: string; agentId: string; content: string; addressedTo?: string }
  >({
    mutationFn: ({ threadId, content, addressedTo }) =>
      apiFetch<SendMessageResponse>(`/api/threads/${threadId}/messages`, {
        method: 'POST',
        body: JSON.stringify({ content, ...(addressedTo ? { addressedTo } : {}) }),
      }),
    onSuccess: (_, { threadId, agentId }) => {
      void qc.invalidateQueries({ queryKey: ['thread-messages', threadId] });
      void qc.invalidateQueries({ queryKey: ['agent-threads', agentId] });
      void qc.invalidateQueries({ queryKey: ['thread-participants', threadId] });
      void qc.invalidateQueries({ queryKey: ['thread', threadId] });
      // create_project directives can mutate the project list.
      void qc.invalidateQueries({ queryKey: ['projects'] });
    },
  });
}

// ----- Chat v2: participants & thread detail -----

export interface ThreadParticipantSummary {
  agentId: string;
  name: string;
  seedKey: string | null;
  role: 'manager' | 'member';
}

export function useThreadParticipants(threadId: string | undefined) {
  return useQuery<ThreadParticipantSummary[]>({
    queryKey: ['thread-participants', threadId ?? null],
    enabled: Boolean(threadId),
    queryFn: async () => {
      if (!threadId) return [];
      try {
        return await apiFetch<ThreadParticipantSummary[]>(`/api/threads/${threadId}/participants`);
      } catch {
        return [];
      }
    },
  });
}

export function useAddParticipant() {
  const qc = useQueryClient();
  return useMutation<
    { agentId: string; name: string; role: string },
    Error,
    { threadId: string; agentId: string; role?: 'manager' | 'member' }
  >({
    mutationFn: ({ threadId, agentId, role }) =>
      apiFetch(`/api/threads/${threadId}/participants`, {
        method: 'POST',
        body: JSON.stringify({ agentId, ...(role ? { role } : {}) }),
      }),
    onSuccess: (_, { threadId }) => {
      void qc.invalidateQueries({ queryKey: ['thread-participants', threadId] });
      void qc.invalidateQueries({ queryKey: ['thread', threadId] });
    },
  });
}

export function useRemoveParticipant() {
  const qc = useQueryClient();
  return useMutation<void, Error, { threadId: string; agentId: string }>({
    mutationFn: async ({ threadId, agentId }) => {
      await apiFetch<unknown>(`/api/threads/${threadId}/participants/${agentId}`, {
        method: 'DELETE',
      });
    },
    onSuccess: (_, { threadId }) => {
      void qc.invalidateQueries({ queryKey: ['thread-participants', threadId] });
      void qc.invalidateQueries({ queryKey: ['thread', threadId] });
    },
  });
}

export interface ChatActionRow {
  id: string;
  threadId: string;
  messageId: string | null;
  kind: 'consult' | 'add_member' | 'create_project' | 'start_run' | 'invoke_skill';
  payloadJson: unknown;
  resultJson: unknown;
  status: 'pending' | 'ok' | 'failed';
  createdAt: string | number | Date;
}

export interface ThreadDetailResponse {
  thread: AgentThread;
  agent: Agent | null;
  project: Project | null;
  participants: ThreadParticipantSummary[];
  actions: ChatActionRow[];
}

export function useThreadDetail(threadId: string | undefined) {
  return useQuery<ThreadDetailResponse | null>({
    queryKey: ['thread', threadId ?? null],
    enabled: Boolean(threadId),
    queryFn: async () => {
      if (!threadId) return null;
      try {
        return await apiFetch<ThreadDetailResponse>(`/api/threads/${threadId}`);
      } catch {
        return null;
      }
    },
  });
}

export function useCompressThread() {
  const qc = useQueryClient();
  return useMutation<
    { compressed: boolean; reason?: string; remainingMessageCount?: number },
    Error,
    { threadId: string }
  >({
    mutationFn: ({ threadId }) => apiFetch(`/api/threads/${threadId}/compress`, { method: 'POST' }),
    onSuccess: (_, { threadId }) => {
      void qc.invalidateQueries({ queryKey: ['thread-messages', threadId] });
      void qc.invalidateQueries({ queryKey: ['thread', threadId] });
    },
  });
}

// ---------- Workers ----------

export interface WorkerSummary {
  name: string;
  cronSpec: string;
  enabled: boolean;
}

export interface WorkerRunRow {
  id: string;
  workerName: string;
  startedAt: number | string;
  endedAt: number | string | null;
  status: 'running' | 'ok' | 'failed';
  resultJson: unknown;
  errorReason: string | null;
}

export function useWorkers() {
  return useQuery<WorkerSummary[]>({
    queryKey: ['workers'],
    queryFn: () => apiFetch('/api/workers'),
  });
}

export function useWorkerRuns(name: string | undefined) {
  return useQuery<WorkerRunRow[]>({
    queryKey: ['worker-runs', name],
    queryFn: () => apiFetch(`/api/workers/${name}/runs`),
    enabled: !!name,
  });
}

export function useRunWorker() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (name: string) => apiFetch(`/api/workers/${name}/run`, { method: 'POST' }),
    onSuccess: (_d, name) => {
      void qc.invalidateQueries({ queryKey: ['worker-runs', name] });
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

// ---------- Skills ----------

export interface SkillSummary {
  name: string;
  description: string;
  model: 'opus' | 'sonnet' | 'haiku';
  allowedTools: string[];
  argumentHint?: string;
  /** Discovery origin: 'seed' | 'project' | 'user' | 'plugin:<name>'. */
  source: string;
}

export function useSkills() {
  return useQuery<SkillSummary[]>({
    queryKey: ['skills'],
    queryFn: () => apiFetch<SkillSummary[]>('/api/skills'),
  });
}

export function useReloadSkills() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: () => apiFetch('/api/skills/reload', { method: 'POST' }),
    onSuccess: () => void qc.invalidateQueries({ queryKey: ['skills'] }),
  });
}

// ---------- GOAP Planner ----------

export interface GoapAction {
  name: string;
  cost: number;
  preconditions: Record<string, boolean>;
  effects: Record<string, boolean>;
}
export interface GoapPlanRequest {
  initial: Record<string, boolean>;
  goal: Record<string, boolean>;
  actions: GoapAction[];
}
export interface GoapPlanResponse {
  plan: GoapAction[] | null;
  totalCost: number | null;
}

export function usePlanGoap() {
  return useMutation({
    mutationFn: (input: GoapPlanRequest) =>
      apiFetch<GoapPlanResponse>('/api/goap/plan', {
        method: 'POST',
        body: JSON.stringify(input),
        headers: { 'Content-Type': 'application/json' },
      }),
  });
}

// ---------- Run Summaries ----------

export interface RunSummaryRow {
  runId: string;
  projectId: string;
  summaryMd: string;
  mode: string | null;
  tokensTotal: number;
  createdAt: number | string;
}

export function useRunSummaries(projectId?: string) {
  return useQuery<RunSummaryRow[]>({
    queryKey: ['run-summaries', projectId ?? 'all'],
    queryFn: () =>
      apiFetch(
        `/api/insights/run-summaries${projectId ? `?projectId=${encodeURIComponent(projectId)}` : ''}`,
      ),
  });
}

// ---------- Prompt Bundles ----------

export interface PromptBundleRow {
  bundleKey: string;
  cwd: string;
  claudeSessionId: string | null;
  model: string;
  hitCount: number;
  lastUsedAt: number | string;
  createdAt: number | string;
}

export function usePromptBundles() {
  return useQuery<PromptBundleRow[]>({
    queryKey: ['prompt-bundles'],
    queryFn: () => apiFetch<PromptBundleRow[]>('/api/prompt-bundles'),
  });
}

export function useDeletePromptBundle() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (key: string) =>
      apiFetch(`/api/prompt-bundles/${encodeURIComponent(key)}`, { method: 'DELETE' }),
    onSuccess: () => void qc.invalidateQueries({ queryKey: ['prompt-bundles'] }),
  });
}
