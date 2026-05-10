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
import { MissionControlV1Terminal } from '@/routes/missioncontrol/V1Terminal';
import { MissionControlV2Broadsheet } from '@/routes/missioncontrol/V2Broadsheet';
import { MissionControlV3Radar } from '@/routes/missioncontrol/V3Radar';
import { MissionControlV4SpecSheet } from '@/routes/missioncontrol/V4SpecSheet';
import { MissionControlV5Transit } from '@/routes/missioncontrol/V5Transit';
import { MissionControlV6Poster } from '@/routes/missioncontrol/V6Poster';
import { MissionControlV7Heatmap } from '@/routes/missioncontrol/V7Heatmap';
import { MissionControlV8Console } from '@/routes/missioncontrol/V8Console';
import { MissionControlV9Cockpit } from '@/routes/missioncontrol/V9Cockpit';
import { MissionControlV10Stream } from '@/routes/missioncontrol/V10Stream';
import { MissionControlV11Portfolio } from '@/routes/missioncontrol/V11Portfolio';
import { MissionControlV12Honeycomb } from '@/routes/missioncontrol/V12Honeycomb';
import { MissionControlV13Expose } from '@/routes/missioncontrol/V13Expose';
import { MissionControlV14NowPlaying } from '@/routes/missioncontrol/V14NowPlaying';
import { MissionControlV15Stream2 } from '@/routes/missioncontrol/V15Stream2';
import { MissionControlV16Focus } from '@/routes/missioncontrol/V16Focus';
import { MissionControlV17Dispatch } from '@/routes/missioncontrol/V17Dispatch';
import { MissionControlV18Cockpit2 } from '@/routes/missioncontrol/V18Cockpit2';
import { MissionControlV19Timeline } from '@/routes/missioncontrol/V19Timeline';
import { MissionControlV20Inbox } from '@/routes/missioncontrol/V20Inbox';
import { MissionControlCompare } from '@/routes/missioncontrol/Compare';
import { MissionControlCompare2 } from '@/routes/missioncontrol/Compare2';
import { MissionControlCompare3 } from '@/routes/missioncontrol/Compare3';
import { AgentsRoute } from '@/routes/Agents';
import { ChatRoute } from '@/routes/Chat';
import { useUiStore } from '@/store/ui';

function Shell() {
  return (
    <div className="flex h-screen w-screen overflow-hidden">
      <Sidebar />
      <div className="flex flex-1 flex-col overflow-hidden">
        <TopBar />
        <main className="flex-1 overflow-auto">
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
        <Route path="/mc/v1" element={<MissionControlV1Terminal />} />
        <Route path="/mc/v2" element={<MissionControlV2Broadsheet />} />
        <Route path="/mc/v3" element={<MissionControlV3Radar />} />
        <Route path="/mc/v4" element={<MissionControlV4SpecSheet />} />
        <Route path="/mc/v5" element={<MissionControlV5Transit />} />
        <Route path="/mc/v6" element={<MissionControlV6Poster />} />
        <Route path="/mc/v7" element={<MissionControlV7Heatmap />} />
        <Route path="/mc/v8" element={<MissionControlV8Console />} />
        <Route path="/mc/v9" element={<MissionControlV9Cockpit />} />
        <Route path="/mc/v10" element={<MissionControlV10Stream />} />
        <Route path="/mc/v11" element={<MissionControlV11Portfolio />} />
        <Route path="/mc/v12" element={<MissionControlV12Honeycomb />} />
        <Route path="/mc/v13" element={<MissionControlV13Expose />} />
        <Route path="/mc/v14" element={<MissionControlV14NowPlaying />} />
        <Route path="/mc/v15" element={<MissionControlV15Stream2 />} />
        <Route path="/mc/v16" element={<MissionControlV16Focus />} />
        <Route path="/mc/v17" element={<MissionControlV17Dispatch />} />
        <Route path="/mc/v18" element={<MissionControlV18Cockpit2 />} />
        <Route path="/mc/v19" element={<MissionControlV19Timeline />} />
        <Route path="/mc/v20" element={<MissionControlV20Inbox />} />
        <Route path="/mc/3" element={<MissionControlCompare3 />} />
        <Route path="/mc/2" element={<MissionControlCompare2 />} />
        <Route path="/mc" element={<MissionControlCompare />} />
        <Route path="/agents" element={<AgentsRoute />} />
        <Route path="/chat" element={<ChatRoute />} />
      </Route>
    </Routes>
  );
}
