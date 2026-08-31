import { create } from "zustand";

// =============================================================================
// useLedgerOverlay — opens the reading-tab / earnings ledger in a workspace
// Glasshouse (frosted overlay, ForallMenu stays crisp above). In-memory only:
// like the notifications overlay, it pushes no shareable URL. Deep links arrive
// as /reader?overlay=ledger (the retired /ledger route — and the /account
// shim before it — redirect into that), handled by the deep-link dispatcher in
// WorkspaceView.
// =============================================================================

interface LedgerOverlayState {
  isOpen: boolean;
  open: () => void;
  close: () => void;
}

export const useLedgerOverlay = create<LedgerOverlayState>((set) => ({
  isOpen: false,
  open: () => set({ isOpen: true }),
  close: () => set({ isOpen: false }),
}));
