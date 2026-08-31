import { create } from "zustand";
import {
  type ExplainKind,
  explainCardCopy,
  explainCopy,
} from "../lib/explain/registry";

// =============================================================================
// Explain engine store — the state machine (EXPLAIN-ADR D12).
//
//   idle → active on open(program), back on close().
//
// Two concurrent channels inside `active`, no mode enum:
//   - pinned: the sequential cursor `index` into `annotations`, driven by
//     next/prev. RENDERED ONLY BY FIRST-RUN (2026-07-15): the Explain program
//     is hover-only, so its resolved sequence is never walked.
//   - hover:  transient, resolved live from the pointer by the overlay; does
//     not touch `index`. The overlay renders it AT the cursor (2026-07-15),
//     and suppresses it during first-run.
//
// Ephemeral chrome, so NO history push (D12) — Explain is not a shareable URL.
// The store is DOM-free: annotation resolution (registry snapshot → ordered
// sequence) is the caller's job (slice 4/5); `open` receives a resolved program.
// =============================================================================

// A resolved, positionable annotation. The DOM element is NOT stored — the
// overlay measures the live rect at render (D11), keyed by { kind, key }.
export interface Annotation {
  kind: ExplainKind;
  // feedId for vessel/leaf instances; absent for singletons + card kinds.
  key?: string;
  copy: string;
  // First-run floor beats free-float over the floor (D8).
  alwaysFloat?: boolean;
  // First-run beat 6 carries the explicit dismiss affordance (§6).
  done?: boolean;
}

export type ExplainProgramKind = "explain" | "firstrun";

// Which surface the program annotates, decided at open() and fixed for the
// program's life (D10 reversal, 2026-07-15 second session): "floor" is the
// workspace canvas (the original form); "pane" annotates the open Glasshouse —
// the scrim/bubble bands rise above the pane (z-57/58 vs 50/53), hit-testing
// resolves only tags inside the pane, and the pane closing closes Explain
// with it. First-run is always "floor".
export type ExplainSurface = "floor" | "pane";

// A resolved program: which flavour + the annotation sequence built at open().
export interface Program {
  kind: ExplainProgramKind;
  surface: ExplainSurface;
  annotations: Annotation[];
}

export interface HoverTarget {
  kind: ExplainKind;
  key?: string;
  // Per-instance copy parameter, read off the element's data-explain-param by
  // the overlay's hit-test (2026-07-16). Today only card flavours use it (a
  // Bluesky post vs an RSS item vs a native article); resolution lives in
  // registry.ts::explainCardCopy.
  param?: string;
}

interface ExplainState {
  isActive: boolean;
  program: Program | null;
  annotations: Annotation[]; // resolved at open()
  index: number; // pinned cursor
  hover: HoverTarget | null;
  // D11 drag suspension: the feedId of a vessel being dragged, else null. While
  // set, the overlay suspends the pinned bubble and suppresses hover (a bubble
  // chasing a dragged object is noise). Inert under v1's frozen floor — the
  // scrim swallows pointerdown, so a vessel drag cannot begin while Explain is
  // active — but the seam is complete for the sanctioned v2 (D1) that forwards
  // pointer deltas to the surface.
  draggingFeedId: string | null;
  open: (p: Program) => void;
  next: () => void;
  prev: () => void;
  pin: (t: HoverTarget) => void; // D1 click-pin
  setHover: (t: HoverTarget | null) => void;
  setDragging: (feedId: string | null) => void;
  close: () => void;
}

function sameTarget(a: HoverTarget, b: HoverTarget): boolean {
  return (
    a.kind === b.kind &&
    (a.key ?? undefined) === (b.key ?? undefined) &&
    (a.param ?? undefined) === (b.param ?? undefined)
  );
}

export const useExplain = create<ExplainState>((set, get) => ({
  isActive: false,
  program: null,
  annotations: [],
  index: 0,
  hover: null,
  draggingFeedId: null,

  open: (p) =>
    set({
      isActive: true,
      program: p,
      annotations: p.annotations,
      index: 0,
      hover: null,
      draggingFeedId: null,
    }),

  next: () =>
    set((s) => ({
      index: Math.min(s.index + 1, Math.max(0, s.annotations.length - 1)),
    })),

  prev: () => set((s) => ({ index: Math.max(s.index - 1, 0) })),

  pin: (t) => {
    // DORMANT (2026-07-15): click-pin was deleted from the Explain program
    // (any click dismisses; the hover bubble already rides the cursor). Kept as
    // the D1 seam in case a pinning affordance returns. If revived for card
    // kinds, thread an INSTANCE key through the hit → pin path first: a
    // keyless card annotation anchors to the representative instance (the
    // lowest-rank vessel's leaf), not the one that was clicked (§0d.2,
    // 2026-07-15 audit).
    const { annotations } = get();
    const existing = annotations.findIndex((a) => sameTarget(a, t));
    if (existing >= 0) {
      set({ index: existing });
      return;
    }
    // Hover-only instance target (a non-representative card, D5): mint its
    // annotation on the fly and pin it (D1). `vessel` is always in-sequence, so
    // this only reaches non-forking kinds — explainCopy needs no fromStarter.
    set((s) => ({
      annotations: [
        ...s.annotations,
        {
          kind: t.kind,
          key: t.key,
          copy:
            t.kind === "card" ? explainCardCopy(t.param) : explainCopy(t.kind),
        },
      ],
      index: s.annotations.length,
    }));
  },

  setHover: (t) => set({ hover: t }),

  setDragging: (feedId) => set({ draggingFeedId: feedId }),

  close: () =>
    set({
      isActive: false,
      program: null,
      annotations: [],
      index: 0,
      hover: null,
      draggingFeedId: null,
    }),
}));
