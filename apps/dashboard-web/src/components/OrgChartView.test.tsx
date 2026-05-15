import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { MemoryRouter } from 'react-router-dom';

// Mock react-flow so the custom node renders without needing real
// width/height measurements in jsdom. We render each node via the
// configured nodeTypes map directly into a wrapper div.
vi.mock('reactflow', async () => {
  const React = await import('react');
  const Background = () => React.createElement('div', { 'data-testid': 'rf-bg' });
  const ReactFlowProvider = ({ children }: { children: React.ReactNode }) =>
    React.createElement(React.Fragment, null, children);
  const ReactFlow = (props: {
    nodes: Array<{ id: string; type: string; data: unknown }>;
    nodeTypes: Record<string, React.ComponentType<{ data: unknown; id: string }>>;
    onNodeClick?: (e: unknown, node: { id: string; data: unknown }) => void;
    children?: React.ReactNode;
  }) => {
    const { nodes, nodeTypes, children, onNodeClick } = props;
    return React.createElement(
      'div',
      { 'data-testid': 'rf-mock', 'data-node-count': String(nodes.length) },
      ...nodes.map((n) =>
        React.createElement(
          'div',
          {
            key: n.id,
            'data-testid': `rf-node-wrapper-${n.id}`,
            onClick: () => onNodeClick?.(null, n),
          },
          React.createElement(nodeTypes[n.type]!, { id: n.id, data: n.data }),
        ),
      ),
      children,
    );
  };
  const useNodesState = (initial: unknown) => {
    const [state, setState] = React.useState(initial);
    return [state, setState, () => {}];
  };
  const useEdgesState = (initial: unknown) => {
    const [state, setState] = React.useState(initial);
    return [state, setState, () => {}];
  };
  return {
    __esModule: true,
    default: ReactFlow,
    Background,
    BackgroundVariant: { Dots: 'dots' },
    ReactFlowProvider,
    useNodesState,
    useEdgesState,
  };
});

import { OrgChartView } from './OrgChartView';

const originalFetch = globalThis.fetch;

interface OrgChartFixture {
  roles: Array<{
    role: string;
    displayName: string;
    model: 'opus' | 'sonnet' | 'haiku';
    avatarUrl: string | null;
    color: string | null;
    description: string | null;
    allowedToolsCount: number;
    seedKey: string | null;
    agentId: string | null;
  }>;
  edges: Array<{ from: string; to: string; kind: 'plan-dep' | 'handoff' }>;
  liveStatus: Array<{ role: string; status: 'idle' | 'working' | 'done' | 'failed' }>;
  latestPlanId: string | null;
  latestRunId: string | null;
}

let fixture: OrgChartFixture = {
  roles: [],
  edges: [],
  liveStatus: [],
  latestPlanId: null,
  latestRunId: null,
};

interface AgentOverrideFixture {
  id: string;
  projectId: string;
  role: string;
  model: 'opus' | 'sonnet' | 'haiku' | null;
  extraSystemPrompt: string | null;
  extraAllowedTools: string[] | null;
  memoryNamespace: string | null;
  createdAt: number;
  updatedAt: number;
}

let agentOverridesFixture: AgentOverrideFixture[] = [];

beforeEach(() => {
  globalThis.fetch = vi.fn(async (input) => {
    const url = typeof input === 'string' ? input : input.toString();
    if (url.includes('/org-chart')) {
      return new Response(JSON.stringify(fixture), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      });
    }
    if (url.includes('/agent-overrides')) {
      return new Response(JSON.stringify(agentOverridesFixture), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      });
    }
    return new Response('{}', { status: 404 });
  }) as typeof fetch;
});

afterEach(() => {
  globalThis.fetch = originalFetch;
  vi.restoreAllMocks();
  fixture = {
    roles: [],
    edges: [],
    liveStatus: [],
    latestPlanId: null,
    latestRunId: null,
  };
  agentOverridesFixture = [];
});

function renderView() {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={qc}>
      <MemoryRouter>
        <OrgChartView projectId="p1" />
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

describe('OrgChartView', () => {
  it('renders empty state when API returns no roles', async () => {
    fixture = {
      roles: [],
      edges: [],
      liveStatus: [],
      latestPlanId: null,
      latestRunId: null,
    };
    renderView();
    await waitFor(() => {
      expect(screen.getByTestId('org-chart-empty')).toBeInTheDocument();
    });
    expect(screen.queryByTestId('org-chart-view')).toBeNull();
  });

  it('renders one node per role with status pill class reflecting live status', async () => {
    fixture = {
      roles: [
        {
          role: 'architect',
          displayName: 'Archie',
          model: 'opus',
          avatarUrl: null,
          color: null,
          description: null,
          allowedToolsCount: 3,
          seedKey: null,
          agentId: null,
        },
        {
          role: 'developer',
          displayName: 'Devon',
          model: 'sonnet',
          avatarUrl: null,
          color: '#7c3aed',
          description: null,
          allowedToolsCount: 5,
          seedKey: 'frontend-dev',
          agentId: null,
        },
      ],
      edges: [{ from: 'architect', to: 'developer', kind: 'plan-dep' }],
      liveStatus: [
        { role: 'architect', status: 'done' },
        { role: 'developer', status: 'working' },
      ],
      latestPlanId: 'plan-1',
      latestRunId: 'run-1',
    };
    renderView();
    await waitFor(() => {
      expect(screen.getByTestId('org-chart-node-architect')).toBeInTheDocument();
    });
    expect(screen.getByTestId('org-chart-node-developer')).toBeInTheDocument();
    expect(screen.getByTestId('org-chart-view')).toBeInTheDocument();
    expect(screen.getByText('Archie')).toBeInTheDocument();
    expect(screen.getByText('Devon')).toBeInTheDocument();

    const archStatus = screen.getByTestId('org-chart-status-architect');
    expect(archStatus.getAttribute('data-status')).toBe('done');
    expect(archStatus.className).toContain('bg-emerald-500');

    const devStatus = screen.getByTestId('org-chart-status-developer');
    expect(devStatus.getAttribute('data-status')).toBe('working');
    expect(devStatus.className).toContain('bg-blue-500');
    expect(devStatus.className).toContain('animate-pulse');
  });

  it('opens the AgentOverrideDialog when a node is clicked and prefills with the existing override', async () => {
    fixture = {
      roles: [
        {
          role: 'developer',
          displayName: 'Devon',
          model: 'sonnet',
          avatarUrl: null,
          color: null,
          description: 'Implements the feature.',
          allowedToolsCount: 5,
          seedKey: null,
          agentId: null,
        },
      ],
      edges: [],
      liveStatus: [{ role: 'developer', status: 'idle' }],
      latestPlanId: null,
      latestRunId: null,
    };
    agentOverridesFixture = [
      {
        id: 'aov-1',
        projectId: 'p1',
        role: 'developer',
        model: 'opus',
        extraSystemPrompt: 'Prefer functional patterns.',
        extraAllowedTools: ['Read', 'Write'],
        memoryNamespace: 'shared-dev',
        createdAt: 0,
        updatedAt: 0,
      },
    ];

    const { default: userEventModule } = await import('@testing-library/user-event');
    const user = userEventModule.setup();
    renderView();

    await waitFor(() => {
      expect(screen.getByTestId('org-chart-node-developer')).toBeInTheDocument();
    });

    await user.click(screen.getByTestId('rf-node-wrapper-developer'));

    await waitFor(() => {
      expect(screen.getByTestId('agent-override-dialog')).toBeInTheDocument();
    });
    // Prefilled value from the override fixture
    const promptArea = screen.getByTestId('agent-override-extra-prompt') as HTMLTextAreaElement;
    expect(promptArea.value).toBe('Prefer functional patterns.');
    expect(screen.getByTestId('agent-override-save')).toBeInTheDocument();
    expect(screen.getByTestId('agent-override-reset')).toBeInTheDocument();
  });
});
