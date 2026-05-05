import { useCallback, useEffect, useMemo } from 'react';
import ReactFlow, {
  Background,
  Controls,
  type Edge as RFEdge,
  type Node as RFNode,
  type NodeProps,
  ReactFlowProvider,
  useEdgesState,
  useNodesState,
} from 'reactflow';
import dagre from 'dagre';
import type { Plan, Role, TaskNode } from '@agent-harness/schemas';
import 'reactflow/dist/style.css';

interface PlanCanvasProps {
  plan: Plan;
  selectedNodeId: string | null;
  onSelectNode: (id: string | null) => void;
}

interface PlanNodeData {
  taskNode: TaskNode;
  selected: boolean;
}

const NODE_WIDTH = 220;
const NODE_HEIGHT = 110;

function roleAccent(role: Role): string {
  return `hsl(var(--role-${role}))`;
}

function PlanTaskNode({ data }: NodeProps<PlanNodeData>) {
  const { taskNode, selected } = data;
  const accent = roleAccent(taskNode.role);
  const oneLine = taskNode.prompt.replace(/\s+/g, ' ').trim();
  return (
    <div
      data-testid={`plan-node-${taskNode.id}`}
      data-role={taskNode.role}
      className={
        'overflow-hidden rounded-md border bg-card text-card-foreground shadow-sm transition ' +
        (selected ? 'ring-2 ring-ring' : 'hover:ring-1 hover:ring-ring/40')
      }
      style={{ width: NODE_WIDTH }}
    >
      <div style={{ background: accent, height: 4 }} />
      <div className="flex flex-col gap-1 p-3">
        <div className="flex items-center justify-between">
          <span className="text-sm font-semibold">{taskNode.id}</span>
          <span
            className="rounded px-1.5 py-0.5 text-[10px] font-medium uppercase tracking-wide"
            style={{ background: accent, color: 'white' }}
          >
            {taskNode.role}
          </span>
        </div>
        <p className="line-clamp-1 text-xs text-muted-foreground" title={taskNode.prompt}>
          {oneLine || <span className="italic">(no prompt)</span>}
        </p>
        <span className="text-[10px] text-muted-foreground/80">edit</span>
      </div>
    </div>
  );
}

const NODE_TYPES = { task: PlanTaskNode };

function layoutPlan(plan: Plan): Map<string, { x: number; y: number }> {
  const g = new dagre.graphlib.Graph();
  g.setGraph({ rankdir: 'TB', nodesep: 40, ranksep: 60 });
  g.setDefaultEdgeLabel(() => ({}));
  for (const n of plan.nodes) {
    g.setNode(n.id, { width: NODE_WIDTH, height: NODE_HEIGHT });
  }
  for (const e of plan.edges) {
    if (plan.nodes.some((n) => n.id === e.from) && plan.nodes.some((n) => n.id === e.to)) {
      g.setEdge(e.from, e.to);
    }
  }
  dagre.layout(g);
  const positions = new Map<string, { x: number; y: number }>();
  for (const n of plan.nodes) {
    const meta = g.node(n.id);
    if (meta) {
      positions.set(n.id, { x: meta.x - NODE_WIDTH / 2, y: meta.y - NODE_HEIGHT / 2 });
    } else {
      positions.set(n.id, { x: 0, y: 0 });
    }
  }
  return positions;
}

function buildRfNodes(plan: Plan, selectedId: string | null): RFNode<PlanNodeData>[] {
  const positions = layoutPlan(plan);
  return plan.nodes.map((tn) => ({
    id: tn.id,
    type: 'task',
    position: positions.get(tn.id) ?? { x: 0, y: 0 },
    data: { taskNode: tn, selected: selectedId === tn.id },
  }));
}

function buildRfEdges(plan: Plan): RFEdge[] {
  return plan.edges.map((e, idx) => ({
    id: `e-${idx}-${e.from}-${e.to}`,
    source: e.from,
    target: e.to,
    type: 'default',
    animated: false,
  }));
}

function PlanCanvasInner({ plan, selectedNodeId, onSelectNode }: PlanCanvasProps) {
  const initialNodes = useMemo(() => buildRfNodes(plan, selectedNodeId), [plan, selectedNodeId]);
  const initialEdges = useMemo(() => buildRfEdges(plan), [plan]);
  const [nodes, setNodes, onNodesChange] = useNodesState<PlanNodeData>(initialNodes);
  const [edges, setEdges, onEdgesChange] = useEdgesState(initialEdges);

  // When the plan reference changes, rebuild nodes/edges and re-layout.
  useEffect(() => {
    setNodes(buildRfNodes(plan, selectedNodeId));
    setEdges(buildRfEdges(plan));
  }, [plan, selectedNodeId, setNodes, setEdges]);

  const handleNodeClick = useCallback(
    (_e: React.MouseEvent, node: RFNode) => {
      onSelectNode(node.id);
    },
    [onSelectNode],
  );

  const handlePaneClick = useCallback(() => {
    onSelectNode(null);
  }, [onSelectNode]);

  return (
    <ReactFlow
      nodes={nodes}
      edges={edges}
      nodeTypes={NODE_TYPES}
      onNodesChange={onNodesChange}
      onEdgesChange={onEdgesChange}
      onNodeClick={handleNodeClick}
      onPaneClick={handlePaneClick}
      fitView
      proOptions={{ hideAttribution: true }}
    >
      <Background gap={16} />
      <Controls showInteractive={false} />
    </ReactFlow>
  );
}

export function PlanCanvas(props: PlanCanvasProps) {
  return (
    <ReactFlowProvider>
      <PlanCanvasInner {...props} />
    </ReactFlowProvider>
  );
}
