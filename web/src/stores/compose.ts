import { create } from "zustand";
import type { QuoteTarget } from "../lib/publishNote";
import type { NoteEvent } from "../lib/ndk";

// Note/reply compose only. Article writing is the global EditorOverlay
// (useEditorOverlay) — the full ArticleEditor in a Glasshouse — not a compose
// mode. See web/src/stores/editorOverlay.ts.
type ComposeMode = "note" | "reply";

interface ComposeState {
  isOpen: boolean;
  mode: ComposeMode;
  replyTarget: QuoteTarget | null;

  open: (mode?: ComposeMode, replyTarget?: QuoteTarget) => void;
  close: () => void;

  /** FeedView registers this so the overlay can prepend new notes to the feed. */
  onPublished: ((note: NoteEvent) => void) | null;
  setOnPublished: (cb: ((note: NoteEvent) => void) | null) => void;
}

export const useCompose = create<ComposeState>((set) => ({
  isOpen: false,
  mode: "note",
  replyTarget: null,
  onPublished: null,

  open: (mode = "note", replyTarget) =>
    set({
      isOpen: true,
      mode,
      replyTarget: replyTarget ?? null,
    }),

  close: () =>
    set({
      isOpen: false,
      replyTarget: null,
    }),

  setOnPublished: (cb) => set({ onPublished: cb }),
}));
