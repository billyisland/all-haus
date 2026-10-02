import { create } from "zustand";
import type { QuoteTarget } from "../lib/publishNote";

// =============================================================================
// useCompose — the short-form compose REQUEST, honoured by whichever of the two
// compose surfaces is mounted (the global `ComposeOverlay` off the workspace,
// the workspace `Composer` on it). Article writing is the global EditorOverlay
// (useEditorOverlay) — the full ArticleEditor in a Glasshouse — not a compose
// mode. See web/src/stores/editorOverlay.ts.
//
// TWO MODES, AND A REPLY IS NEITHER OF THEM. A note and a quote are new
// top-level posts, and a pane over the floor is the right surface for one. A
// REPLY is a remark inside a conversation the reader is already looking at, so
// it is written IN SITU in the card's own footer (`NativeReplyBox`, mounted by
// `PostCardInteractive`) and never travels through this store — taking the
// screen away to write a sentence loses the thing being replied to.
//
// The mode was here until 2026-09-18, and its history is worth keeping because
// it is what the split protects against: reply and quote were once a SINGLE
// "reply" mode carrying a `QuoteTarget`, so every card's Reply button was, by
// construction, a request to publish a quote — a new note joining no
// conversation — while the article page's button labelled "Quote" asked for
// mode "reply". Neither was ever observed, because nothing mounted a composer
// on those surfaces (LayoutShell's gate); the naming was free to drift
// precisely because it could not be pressed. Whatever lands here later: a
// channel and its publisher are named the same thing, or they drift again.
// =============================================================================

type ComposeMode = "note" | "quote";

interface ComposeState {
  isOpen: boolean;
  mode: ComposeMode;
  quoteTarget: QuoteTarget | null;
  /** Set by `suspend`, cleared by every other transition. While it is set, a
   *  plain `openNote` RESUMES — mode and target as they were — because the
   *  writer pressing "New note" after a supersede is coming back for the
   *  draft the surface kept, and a draft written about a quote published
   *  without it is a different post. `openQuote` names its own target and
   *  always wins. */
  suspended: boolean;

  /** A top-level note. */
  openNote: () => void;
  /** A note quoting `target`. */
  openQuote: (target: QuoteTarget) => void;
  close: () => void;
  /** SUSPEND, NOT CLEAR — the compose twin of the pane rule. A composer that
   *  is SUPERSEDED (any ∀-menu destination, a profile opened from a byline)
   *  has not been abandoned by its writer; only the editor escalation is a
   *  genuine handover, and that one carries the text. So a supersede drops
   *  `isOpen` and keeps the mode and the target, which is what lets the
   *  surface put an unsent quote back rather than turning it into a note. */
  suspend: () => void;
}

export const useCompose = create<ComposeState>((set) => ({
  isOpen: false,
  mode: "note",
  quoteTarget: null,
  suspended: false,

  openNote: () =>
    set((s) =>
      s.suspended
        ? { isOpen: true, suspended: false }
        : { isOpen: true, mode: "note", quoteTarget: null, suspended: false },
    ),

  openQuote: (target) =>
    set({ isOpen: true, mode: "quote", quoteTarget: target, suspended: false }),

  close: () => {
    // The hand-back that used to live here moved to `Glasshouse`, which is
    // where the SUPERSEDE happens and therefore the only place that sees all
    // of them: this store's `close()` is one superseder out of many, and not
    // even the one the ∀ menu reaches (the workspace's own composer never
    // opens this store — `setComposerOpen("note")`). See
    // `scheduleAddressedPaneHandback`.
    set({ isOpen: false, quoteTarget: null, suspended: false })
  },

  suspend: () => set({ isOpen: false, suspended: true }),
}));
