import { create } from 'zustand';
import { persist } from 'zustand/middleware';

export type Theme = 'dark' | 'light';

interface UiState {
  selectedProjectId: string | null;
  theme: Theme;
  isPauseDialogOpen: boolean;
  setSelectedProjectId: (id: string | null) => void;
  setTheme: (t: Theme) => void;
  setPauseDialogOpen: (open: boolean) => void;
}

export const useUiStore = create<UiState>()(
  persist(
    (set) => ({
      selectedProjectId: null,
      theme: 'dark',
      isPauseDialogOpen: false,
      setSelectedProjectId: (id) => set({ selectedProjectId: id }),
      setTheme: (theme) => set({ theme }),
      setPauseDialogOpen: (open) => set({ isPauseDialogOpen: open }),
    }),
    {
      name: 'agent-harness-ui',
      partialize: (state) => ({ theme: state.theme }),
    },
  ),
);
