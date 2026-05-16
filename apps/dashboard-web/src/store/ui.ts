import { create } from 'zustand';
import { persist } from 'zustand/middleware';

export type Theme = 'dark' | 'light';

interface UiState {
  selectedProjectId: string | null;
  theme: Theme;
  isPauseDialogOpen: boolean;
  sidebarCollapsed: boolean;
  setSelectedProjectId: (id: string | null) => void;
  setTheme: (t: Theme) => void;
  setPauseDialogOpen: (open: boolean) => void;
  toggleSidebar: () => void;
  setSidebarCollapsed: (collapsed: boolean) => void;
}

export const useUiStore = create<UiState>()(
  persist(
    (set) => ({
      selectedProjectId: null,
      theme: 'dark',
      isPauseDialogOpen: false,
      sidebarCollapsed: false,
      setSelectedProjectId: (id) => set({ selectedProjectId: id }),
      setTheme: (theme) => set({ theme }),
      setPauseDialogOpen: (open) => set({ isPauseDialogOpen: open }),
      toggleSidebar: () => set((s) => ({ sidebarCollapsed: !s.sidebarCollapsed })),
      setSidebarCollapsed: (collapsed) => set({ sidebarCollapsed: collapsed }),
    }),
    {
      name: 'agent-harness-ui',
      partialize: (state) => ({
        theme: state.theme,
        sidebarCollapsed: state.sidebarCollapsed,
      }),
    },
  ),
);
