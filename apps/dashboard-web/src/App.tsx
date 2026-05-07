import { useEffect } from 'react';
import { Outlet, Route, Routes } from 'react-router-dom';
import { Sidebar } from '@/components/layout/Sidebar';
import { TopBar } from '@/components/layout/TopBar';
import { Home } from '@/routes/Home';
import { ProjectDetail } from '@/routes/ProjectDetail';
import { TeamBuilder } from '@/routes/TeamBuilder';
import { PlanEditor } from '@/routes/PlanEditor';
import { RunView } from '@/routes/RunView';
import { useUiStore } from '@/store/ui';

function Shell() {
  return (
    <div className="flex h-screen w-screen overflow-hidden">
      <Sidebar />
      <div className="flex flex-1 flex-col overflow-hidden">
        <TopBar />
        <main className="flex-1 overflow-auto p-6">
          <Outlet />
        </main>
      </div>
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
      </Route>
    </Routes>
  );
}
