import { beforeEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import type { ProjectTypeResponse } from '@/api/queries';
import { SuccessCard } from './SuccessCard';

// The card only reads `.data` from these three hooks — mock them wholesale so
// the matrix below can flip run/project/type shape per test.
let runData: { run: { status: string; outcome: string | null } } | null;
let projectData: { packageTarget: string; repoPath: string } | null;
let typeData: ProjectTypeResponse | null;

vi.mock('@/api/queries', () => ({
  useRun: () => ({ data: runData }),
  useProject: () => ({ data: projectData }),
  useProjectType: () => ({ data: typeData }),
}));

const navigateMock = vi.fn();
vi.mock('react-router-dom', async (importActual) => {
  const actual = (await importActual()) as typeof import('react-router-dom');
  return { ...actual, useNavigate: () => navigateMock };
});

function renderCard() {
  return render(
    <MemoryRouter>
      <SuccessCard projectId="p1" runId="run-1" />
    </MemoryRouter>,
  );
}

beforeEach(() => {
  navigateMock.mockReset();
  runData = { run: { status: 'completed', outcome: 'success' } };
  projectData = { packageTarget: 'web', repoPath: 'C:\\wisp\\my-app' };
  typeData = { type: 'web-app', framework: 'vite', reason: 'vite.config.ts' };
});

describe('SuccessCard', () => {
  it('renders nothing while the run is still running', () => {
    runData = { run: { status: 'running', outcome: null } };
    renderCard();
    expect(screen.queryByTestId('run-success-card')).not.toBeInTheDocument();
  });

  it('renders nothing for a completed run without a success outcome', () => {
    runData = { run: { status: 'completed', outcome: 'failure' } };
    renderCard();
    expect(screen.queryByTestId('run-success-card')).not.toBeInTheDocument();
  });

  it('renders nothing before the run snapshot has loaded', () => {
    runData = null;
    renderCard();
    expect(screen.queryByTestId('run-success-card')).not.toBeInTheDocument();
  });

  it('web-app: shows the preview CTA + folder line and navigates to the preview tab', () => {
    renderCard();
    expect(screen.getByTestId('run-success-card')).toBeInTheDocument();
    expect(screen.getByText('Your app is ready.')).toBeInTheDocument();
    expect(screen.getByTestId('run-success-folder')).toHaveTextContent('C:\\wisp\\my-app');
    expect(screen.queryByTestId('run-success-desktop-hint')).not.toBeInTheDocument();

    fireEvent.click(screen.getByTestId('run-success-preview-cta'));
    expect(navigateMock).toHaveBeenCalledWith('/projects/p1?tab=preview');
  });

  it('desktop target: shows the build-app hint instead of the preview CTA', () => {
    projectData = { packageTarget: 'tauri-exe', repoPath: 'C:\\wisp\\my-app' };
    renderCard();
    expect(screen.getByTestId('run-success-card')).toBeInTheDocument();
    expect(screen.getByTestId('run-success-desktop-hint')).toBeInTheDocument();
    expect(screen.getByTestId('run-success-folder')).toHaveTextContent('C:\\wisp\\my-app');
    expect(screen.queryByTestId('run-success-preview-cta')).not.toBeInTheDocument();
  });

  it('other project types: shows folder + chat hint, no CTA', () => {
    typeData = { type: 'cli', framework: null, reason: 'bin entry' };
    renderCard();
    expect(screen.getByTestId('run-success-card')).toBeInTheDocument();
    expect(screen.getByTestId('run-success-folder')).toBeInTheDocument();
    expect(screen.getByTestId('run-success-next-hint')).toBeInTheDocument();
    expect(screen.queryByTestId('run-success-preview-cta')).not.toBeInTheDocument();
    expect(screen.queryByTestId('run-success-desktop-hint')).not.toBeInTheDocument();
  });

  it('unknown project type (probe 404): still shows the chat hint branch', () => {
    typeData = null;
    renderCard();
    expect(screen.getByTestId('run-success-card')).toBeInTheDocument();
    expect(screen.getByTestId('run-success-next-hint')).toBeInTheDocument();
    expect(screen.queryByTestId('run-success-preview-cta')).not.toBeInTheDocument();
  });
});
