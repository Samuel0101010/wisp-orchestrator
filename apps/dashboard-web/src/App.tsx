import { useEffect } from 'react';
import { Outlet, Route, Routes } from 'react-router-dom';
import { Sidebar } from '@/components/layout/Sidebar';
import { TopBar } from '@/components/layout/TopBar';
import { CommandPalette } from '@/components/CommandPalette';
import { Home } from '@/routes/Home';
import { ProjectDetail } from '@/routes/ProjectDetail';
import { TeamBuilder } from '@/routes/TeamBuilder';
import { PlanEditor } from '@/routes/PlanEditor';
import { RunView } from '@/routes/RunView';
import { AgentsRoute } from '@/routes/Agents';
import { ChatRoute } from '@/routes/Chat';
import { SkillsRoute } from '@/routes/Skills';
import { WorkersRoute } from '@/routes/Workers';
import { InsightsRoute } from '@/routes/Insights';
import { GoapRoute } from '@/routes/Goap';
import { PromptBundlesRoute } from '@/routes/PromptBundles';
import { useUiStore } from '@/store/ui';

function Shell() {
  return (
    <div className="flex h-screen w-screen overflow-hidden">
      <Sidebar />
      <div className="flex flex-1 flex-col overflow-hidden">
        <TopBar />
        <main
          className="flex-1 overflow-auto focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-inset"
          tabIndex={0}
          aria-label="Main content"
        >
          <div className="mx-auto w-full max-w-screen-2xl p-6">
            <Outlet />
          </div>
        </main>
      </div>
      <CommandPalette />
    </div>
  );
}

export function App() {
  const theme = useUiStore((s) => s.theme);

  useEffect(() => {
    if (typeof document === 'undefined') return;
    const root = document.documentElement;
    root.classList.toggle('dark', theme === 'dark');
  }, [theme]);

  return (
    <Routes>
      <Route element={<Shell />}>
        <Route index element={<Home />} />
        <Route path="/projects/:projectId" element={<ProjectDetail />} />
        <Route path="/projects/:projectId/teams" element={<TeamBuilder />} />
        <Route path="/projects/:projectId/plan" element={<PlanEditor />} />
        <Route path="/projects/:projectId/run/:runId" element={<RunView />} />
        <Route path="/agents" element={<AgentsRoute />} />
        <Route path="/chat" element={<ChatRoute />} />
        <Route path="/skills" element={<SkillsRoute />} />
        <Route path="/workers" element={<WorkersRoute />} />
        <Route path="/insights" element={<InsightsRoute />} />
        <Route path="/goap" element={<GoapRoute />} />
        <Route path="/prompt-bundles" element={<PromptBundlesRoute />} />
      </Route>
    </Routes>
  );
}
