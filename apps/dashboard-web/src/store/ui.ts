import { create } from 'zustand';
import { persist } from 'zustand/middleware';

export type Theme = 'dark' | 'light';

interface UiState {
  selectedProjectId: string | null;
  theme: Theme;
  isPauseDialogOpen: boolean;
  sidebarCollapsed: boolean;
  favoriteProjectIds: string[];
  setSelectedProjectId: (id: string | null) => void;
  setTheme: (t: Theme) => void;
  setPauseDialogOpen: (open: boolean) => void;
  toggleSidebar: () => void;
  setSidebarCollapsed: (collapsed: boolean) => void;
  toggleFavorite: (id: string) => void;
}

export const useUiStore = create<UiState>()(
  persist(
    (set) => ({
      selectedProjectId: null,
      theme: 'dark',
      isPauseDialogOpen: false,
      sidebarCollapsed: false,
      favoriteProjectIds: [],
      setSelectedProjectId: (id) => set({ selectedProjectId: id }),
      setTheme: (theme) => set({ theme }),
      setPauseDialogOpen: (open) => set({ isPauseDialogOpen: open }),
      toggleSidebar: () => set((s) => ({ sidebarCollapsed: !s.sidebarCollapsed })),
      setSidebarCollapsed: (collapsed) => set({ sidebarCollapsed: collapsed }),
      toggleFavorite: (id) =>
        set((s) => ({
          favoriteProjectIds: s.favoriteProjectIds.includes(id)
            ? s.favoriteProjectIds.filter((x) => x !== id)
            : [...s.favoriteProjectIds, id],
        })),
    }),
    {
      // Renaming would wipe existing localStorage for all users — keep the
      // legacy key from the project's "Agent Harness" era.
      name: 'agent-harness-ui',
      partialize: (state) => ({
        theme: state.theme,
        sidebarCollapsed: state.sidebarCollapsed,
        favoriteProjectIds: state.favoriteProjectIds,
      }),
    },
  ),
);
