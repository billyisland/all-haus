import { create } from "zustand";

// =============================================================================
// useMessagesOverlay — opens the direct-messages surface in a workspace
// Glasshouse (frosted overlay, ForallMenu stays crisp above). In-memory only:
// it pushes no shareable URL. Deep links arrive as /reader?overlay=messages
// [&conversation=<id>] (the retired /messages + /messages/[id] routes redirect
// into that), handled by the deep-link dispatcher in WorkspaceView. Callers may
// seed an initial conversation to pre-select.
// =============================================================================

interface MessagesOverlayState {
  isOpen: boolean;
  conversationId: string | null;
  open: (opts?: { conversationId?: string | null }) => void;
  close: () => void;
}

export const useMessagesOverlay = create<MessagesOverlayState>((set) => ({
  isOpen: false,
  conversationId: null,
  open: (opts) =>
    set({ isOpen: true, conversationId: opts?.conversationId ?? null }),
  close: () => set({ isOpen: false }),
}));
