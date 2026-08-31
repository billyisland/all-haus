import { create } from "zustand";

// =============================================================================
// useDashboardOverlay — opens the writer/publication dashboard in a workspace
// Glasshouse (frosted overlay, ForallMenu stays crisp above). In-memory only:
// like the messages overlay, it pushes no shareable URL. Deep links arrive as
// /reader?overlay=dashboard[&tab&context] (the retired /dashboard route
// redirects into that), handled by the deep-link effect in WorkspaceView, which
// calls open() with the seeded tab/context — e.g. straight to a publication's
// earnings.
// =============================================================================

interface DashboardOverlayState {
  isOpen: boolean;
  initialTab: string | null;
  initialContext: string | null;
  open: (opts?: { tab?: string | null; context?: string | null }) => void;
  close: () => void;
}

export const useDashboardOverlay = create<DashboardOverlayState>((set) => ({
  isOpen: false,
  initialTab: null,
  initialContext: null,
  open: (opts) =>
    set({
      isOpen: true,
      initialTab: opts?.tab ?? null,
      initialContext: opts?.context ?? null,
    }),
  close: () => set({ isOpen: false }),
}));
