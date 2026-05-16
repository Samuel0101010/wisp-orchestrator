import { create } from 'zustand';
import { persist } from 'zustand/middleware';

export type Theme = 'dark' | 'light';

/* One-time migration from the legacy 'agent-harness-ui' localStorage key to
   'wisp-ui'. Runs at module load (before zustand reads the new key) so user
   state (theme, sidebar-collapsed, favorites) survives the rename. */
if (typeof window !== 'undefined' && typeof window.localStorage !== 'undefined') {
  const legacy = window.localStorage.getItem('agent-harness-ui');
  const current = window.localStorage.getItem('wisp-ui');
  if (legacy && !current) {
    window.localStorage.setItem('wisp-ui', legacy);
    window.localStorage.removeItem('agent-harness-ui');
  }
}

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
      name: 'wisp-ui',
      partialize: (state) => ({
        theme: state.theme,
        sidebarCollapsed: state.sidebarCollapsed,
        favoriteProjectIds: state.favoriteProjectIds,
      }),
    },
  ),
);
