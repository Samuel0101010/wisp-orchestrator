/**
 * OrgChartView (v1.13 Phase 5) — per-project team org-chart.
 *
 * Renders the team's roles as a ReactFlow DAG with dagre layout (TB).
 * Each node shows the agent avatar (or initials fallback), display name,
 * role badge, model badge, and a live-status pill in the top-right corner.
 * Edges are dashed for `plan-dep` and solid for `handoff` (the latter
 * ships in Phase 6; we render the visual distinction today).
 */
import { useCallback, useEffect, useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import ReactFlow, {
  Background,
  BackgroundVariant,
  type Edge as RFEdge,
  type Node as RFNode,
  type NodeProps,
  ReactFlowProvider,
  useEdgesState,
  useNodesState,
} from 'reactflow';
import { AgentOverrideDialog } from '@/components/AgentOverrideDialog';
import dagre from 'dagre';
import { Link } from 'react-router-dom';
import { Network } from 'lucide-react';
import { Avatar } from '@/components/Avatar';
import { Badge } from '@/components/ui/badge';
import { EmptyState } from '@/components/ui/empty-state';
import { Button } from '@/components/ui/button';
import {
  useOrgChart,
  type OrgChartEdge,
  type OrgChartLiveStatus,
  type OrgChartResponse,
  type OrgChartRole,
} from '@/api/queries';
import 'reactflow/dist/style.css';

const NODE_WIDTH = 180;
const NODE_HEIGHT = 96;

interface AgentNodeData {
  role: OrgChartRole;
  status: OrgChartLiveStatus['status'];
}

function statusPillClass(status: OrgChartLiveStatus['status']): string {
  switch (status) {
    case 'working':
      return 'bg-blue-500 animate-pulse';
    case 'done':
      return 'bg-emerald-500';
    case 'failed':
      return 'bg-red-500';
    case 'idle':
    default:
      return 'bg-muted-foreground/40';
  }
}

function AgentNode({ data }: NodeProps<AgentNodeData>) {
  const { role, status } = data;
  return (
    <div
      data-testid={`org-chart-node-${role.role}`}
      data-role={role.role}
      className="relative overflow-hidden rounded-md border bg-card text-card-foreground shadow-sm"
      style={{ width: NODE_WIDTH, height: NODE_HEIGHT, borderColor: role.color ?? undefined }}
    >
      <span
        data-testid={`org-chart-status-${role.role}`}
        data-status={status}
        title={status}
        className={`absolute right-2 top-2 inline-block h-2 w-2 rounded-full ${statusPillClass(status)}`}
      />
      <div className="flex items-center gap-2 p-2">
        <Avatar
          name={role.displayName}
          avatarUrl={role.avatarUrl}
          color={role.color}
          size={32}
          decorative
        />
        <div className="flex min-w-0 flex-1 flex-col gap-0.5">
          <span className="truncate text-sm font-medium" title={role.displayName}>
            {role.displayName}
          </span>
          <span className="truncate font-mono text-2xs text-muted-foreground" title={role.role}>
            {role.role}
          </span>
        </div>
      </div>
      <div className="flex items-center gap-1 px-2 pb-2">
        <Badge variant="outline" className="text-2xs">
          {role.model}
        </Badge>
        {role.seedKey ? (
          <Badge variant="secondary" className="text-2xs">
            seed
          </Badge>
        ) : null}
      </div>
    </div>
  );
}

const NODE_TYPES = { agent: AgentNode };

function layoutRoles(
  roles: OrgChartRole[],
  edges: OrgChartEdge[],
): Map<string, { x: number; y: number }> {
  const g = new dagre.graphlib.Graph();
  g.setGraph({ rankdir: 'TB', nodesep: 30, ranksep: 50 });
  g.setDefaultEdgeLabel(() => ({}));
  for (const r of roles) g.setNode(r.role, { width: NODE_WIDTH, height: NODE_HEIGHT });
  const roleSet = new Set(roles.map((r) => r.role));
  for (const e of edges) {
    if (roleSet.has(e.from) && roleSet.has(e.to)) {
      g.setEdge(e.from, e.to);
    }
  }
  dagre.layout(g);
  const out = new Map<string, { x: number; y: number }>();
  for (const r of roles) {
    const meta = g.node(r.role);
    if (meta) {
      out.set(r.role, { x: meta.x - NODE_WIDTH / 2, y: meta.y - NODE_HEIGHT / 2 });
    } else {
      out.set(r.role, { x: 0, y: 0 });
    }
  }
  return out;
}

function buildNodes(data: OrgChartResponse): RFNode<AgentNodeData>[] {
  const positions = layoutRoles(data.roles, data.edges);
  const statusByRole = new Map(data.liveStatus.map((s) => [s.role, s.status]));
  return data.roles.map((r) => ({
    id: r.role,
    type: 'agent',
    position: positions.get(r.role) ?? { x: 0, y: 0 },
    data: { role: r, status: statusByRole.get(r.role) ?? 'idle' },
  }));
}

function buildEdges(data: OrgChartResponse): RFEdge[] {
  return data.edges.map((e, idx) => ({
    id: `oe-${idx}-${e.from}-${e.to}`,
    source: e.from,
    target: e.to,
    type: 'default',
    style: {
      stroke: 'hsl(var(--muted-foreground))',
      strokeWidth: 1,
      strokeDasharray: e.kind === 'plan-dep' ? '4 3' : undefined,
    },
    data: { kind: e.kind },
  }));
}

interface OrgChartViewProps {
  projectId: string;
}

function OrgChartViewInner({ projectId }: OrgChartViewProps) {
  const { t } = useTranslation();
  const q = useOrgChart(projectId);

  const data: OrgChartResponse = q.data ?? {
    roles: [],
    edges: [],
    liveStatus: [],
    latestPlanId: null,
    latestRunId: null,
  };

  const [selectedRole, setSelectedRole] = useState<OrgChartRole | null>(null);
  const onNodeClick = useCallback((_e: unknown, node: RFNode<AgentNodeData>) => {
    setSelectedRole(node.data.role);
  }, []);

  const builtNodes = useMemo(() => buildNodes(data), [data]);
  const builtEdges = useMemo(() => buildEdges(data), [data]);
  const [nodes, setNodes, onNodesChange] = useNodesState<AgentNodeData>(builtNodes);
  const [edges, setEdges, onEdgesChange] = useEdgesState(builtEdges);

  // Resync when the fetched data changes — useNodesState only seeds on first
  // mount, so without this nodes never appear after the initial loading→data
  // transition.
  useEffect(() => {
    setNodes(builtNodes);
    setEdges(builtEdges);
  }, [builtNodes, builtEdges, setNodes, setEdges]);

  if (!q.isLoading && data.roles.length === 0) {
    return (
      <div data-testid="org-chart-empty" className="rounded-md border border-dashed p-6">
        <EmptyState
          icon={<Network />}
          title={t('orgChart.empty.title')}
          description={t('orgChart.empty.description')}
          action={
            <Button asChild size="sm" variant="outline">
              <Link to={`/projects/${projectId}/teams`}>{t('orgChart.empty.action')}</Link>
            </Button>
          }
        />
      </div>
    );
  }

  return (
    <div className="flex flex-col gap-3">
      <div className="flex items-baseline justify-between">
        <div className="flex flex-col gap-0.5">
          <h2 className="text-sm font-medium">{t('orgChart.title')}</h2>
          <p className="text-2xs text-muted-foreground">{t('orgChart.description')}</p>
        </div>
        <div className="flex items-center gap-3 text-2xs text-muted-foreground">
          <span className="flex items-center gap-1">
            <span className="inline-block h-2 w-6 border-t border-dashed border-muted-foreground/60" />
            {t('orgChart.legend.planDep')}
          </span>
          <span className="flex items-center gap-1">
            <span className="inline-block h-px w-6 bg-muted-foreground/60" />
            {t('orgChart.legend.handoff')}
          </span>
        </div>
      </div>
      <div
        data-testid="org-chart-view"
        className="relative h-[480px] w-full overflow-hidden rounded-md border bg-background"
      >
        <ReactFlow
          nodes={nodes}
          edges={edges}
          nodeTypes={NODE_TYPES}
          onNodesChange={onNodesChange}
          onEdgesChange={onEdgesChange}
          onNodeClick={onNodeClick}
          fitView
          proOptions={{ hideAttribution: true }}
        >
          <Background
            variant={BackgroundVariant.Dots}
            gap={24}
            size={1}
            color="hsl(var(--border))"
          />
        </ReactFlow>
      </div>
      <AgentOverrideDialog
        open={selectedRole !== null}
        onOpenChange={(o) => {
          if (!o) setSelectedRole(null);
        }}
        projectId={projectId}
        role={selectedRole}
      />
    </div>
  );
}

export function OrgChartView({ projectId }: OrgChartViewProps) {
  return (
    <ReactFlowProvider>
      <OrgChartViewInner projectId={projectId} />
    </ReactFlowProvider>
  );
}
