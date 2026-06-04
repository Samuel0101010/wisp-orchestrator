import { lazy, Suspense, useEffect } from 'react';
import { Outlet, Route, Routes } from 'react-router-dom';
import { Sidebar } from '@/components/layout/Sidebar';
import { TopBar } from '@/components/layout/TopBar';
import { AuthBanner } from '@/components/layout/AuthBanner';
import { AuroraBackground } from '@/components/layout/AuroraBackground';
import { CommandPalette } from '@/components/CommandPalette';
import { ErrorBoundary } from '@/components/ErrorBoundary';
import { Home } from '@/routes/Home';
import { NotFound } from '@/routes/NotFound';
import { useUiStore } from '@/store/ui';

// Code-split: every non-Home route lazy-loads. Home stays eager because it's
// the initial paint target — splitting it would force the Suspense fallback
// to flash on first load. The split chunks come from rollupOptions.manualChunks
// in vite.config.ts (reactflow+dagre, recharts, radix, react-vendor).
const ProjectDetail = lazy(() =>
  import('@/routes/ProjectDetail').then((m) => ({ default: m.ProjectDetail })),
);
const TeamBuilder = lazy(() =>
  import('@/routes/TeamBuilder').then((m) => ({ default: m.TeamBuilder })),
);
const PlanEditor = lazy(() =>
  import('@/routes/PlanEditor').then((m) => ({ default: m.PlanEditor })),
);
const RunView = lazy(() => import('@/routes/RunView').then((m) => ({ default: m.RunView })));
const AgentsRoute = lazy(() => import('@/routes/Agents').then((m) => ({ default: m.AgentsRoute })));
const ChatRoute = lazy(() => import('@/routes/Chat').then((m) => ({ default: m.ChatRoute })));
const FocusboardRoute = lazy(() =>
  import('@/routes/Focusboard').then((m) => ({ default: m.Focusboard })),
);
const SkillsRoute = lazy(() => import('@/routes/Skills').then((m) => ({ default: m.SkillsRoute })));
const WorkersRoute = lazy(() =>
  import('@/routes/Workers').then((m) => ({ default: m.WorkersRoute })),
);
const InsightsRoute = lazy(() =>
  import('@/routes/Insights').then((m) => ({ default: m.InsightsRoute })),
);
const GoapRoute = lazy(() => import('@/routes/Goap').then((m) => ({ default: m.GoapRoute })));
const PromptBundlesRoute = lazy(() =>
  import('@/routes/PromptBundles').then((m) => ({ default: m.PromptBundlesRoute })),
);
const SettingsRoute = lazy(() =>
  import('@/routes/Settings').then((m) => ({ default: m.SettingsRoute })),
);

// Minimal fallback while a route chunk loads. Stays out of the visual
// hierarchy so accessibility tooling doesn't trip over it.
function RouteFallback() {
  return <div aria-busy="true" aria-live="polite" className="min-h-[40vh]" />;
}

function Shell() {
  return (
    <>
      <AuroraBackground />
      <div className="wisp-aurora-scope relative z-[1] flex h-screen w-screen overflow-hidden">
        <Sidebar />
        <div className="flex flex-1 flex-col overflow-hidden">
          <TopBar />
          <AuthBanner />
          <main
            className="flex-1 overflow-auto focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-inset"
            tabIndex={0}
            aria-label="Main content"
          >
            <div className="mx-auto w-full max-w-screen-2xl p-6">
              <ErrorBoundary>
                <Suspense fallback={<RouteFallback />}>
                  <Outlet />
                </Suspense>
              </ErrorBoundary>
            </div>
          </main>
        </div>
        <CommandPalette />
      </div>
    </>
  );
}

export function App() {
  const theme = useUiStore((s) => s.theme);

  useEffect(() => {
    if (typeof document === 'undefined') return;
    const root = document.documentElement;
    root.classList.toggle('dark', theme === 'dark');
    // Wisp-theme variants are keyed on `data-theme` for parity with the
    // design handoff (chrome.jsx Toggle dispatches `appthemechange`).
    root.setAttribute('data-theme', theme === 'dark' ? 'dark' : 'light');
  }, [theme]);

  return (
    <Routes>
      <Route element={<Shell />}>
        <Route index element={<Home />} />
        <Route path="/projects/:projectId" element={<ProjectDetail />} />
        <Route path="/projects/:projectId/teams" element={<TeamBuilder />} />
        <Route path="/projects/:projectId/plan" element={<PlanEditor />} />
        <Route path="/projects/:projectId/run/:runId" element={<RunView />} />
        <Route path="/focus" element={<FocusboardRoute />} />
        <Route path="/focus/:projectId" element={<FocusboardRoute />} />
        <Route path="/agents" element={<AgentsRoute />} />
        <Route path="/chat" element={<ChatRoute />} />
        <Route path="/skills" element={<SkillsRoute />} />
        <Route path="/workers" element={<WorkersRoute />} />
        <Route path="/insights" element={<InsightsRoute />} />
        <Route path="/goap" element={<GoapRoute />} />
        <Route path="/prompt-bundles" element={<PromptBundlesRoute />} />
        <Route path="/settings" element={<SettingsRoute />} />
        <Route path="*" element={<NotFound />} />
      </Route>
    </Routes>
  );
}
