import { create } from 'zustand';
import { persist } from 'zustand/middleware';

interface FocusState {
  lastFocusedProjectId: string | null;
  setLastFocusedProjectId: (id: string | null) => void;
}

export const useFocusStore = create<FocusState>()(
  persist(
    (set) => ({
      lastFocusedProjectId: null,
      setLastFocusedProjectId: (id) => set({ lastFocusedProjectId: id }),
    }),
    { name: 'wisp-focus' },
  ),
);
