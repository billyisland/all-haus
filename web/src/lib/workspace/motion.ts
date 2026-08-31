// Framer Motion config primitives shared by vessel gestures and the
// ∀→H→⊔ ceremonial animations.

import type { Transition } from "framer-motion";

export const VESSEL_DRAG_TRANSITION: Transition = {
  type: "spring",
  stiffness: 600,
  damping: 40,
  mass: 0.6,
};

export const VESSEL_DRAG_TRANSITION_REDUCED: Transition = {
  duration: 0,
};

export function prefersReducedMotion(): boolean {
  if (typeof window === "undefined") return false;
  return window.matchMedia("(prefers-reduced-motion: reduce)").matches;
}

// =============================================================================
// ∀ → H → ⊔ ceremony — Slice 9
//
// Two paces per WORKSPACE-DESIGN-SPEC.md §"The ∀-to-H-to-⊔ transformation"
// and WIREFRAME-DECISIONS-CONSOLIDATED.md Step 9:
//
//   ceremonial — first-login. ~3000ms. Crimson ∀ expands centre-screen,
//                parts into H, H is held (the slowest moment), crossbar
//                drops to form ⊔ base, horizontal bars snap into cards,
//                vessel settles populated.
//   responsive — feed-creation. ~1300ms. ∀ appears at the destination,
//                briefer H flash, crossbar resolves to ⊔ base, terminal
//                state is empty.
//
// All durations in ms. Phase order: forallIn → forallHold → partToH → hHold
// → crossbarDrop → (cardsSnap, ceremonial only) → settle. The driver in
// ForallCeremony advances `phase` on accumulated boundaries.
// =============================================================================

export interface CeremonyTiming {
  forallIn: number;
  forallHold: number;
  partToH: number;
  hHold: number;
  crossbarDrop: number;
  cardsSnap: number; // 0 for responsive (terminal state is empty)
  settle: number;
}

export const CEREMONY_TIMINGS: Record<
  "ceremonial" | "responsive",
  CeremonyTiming
> = {
  ceremonial: {
    forallIn: 280,
    forallHold: 200,
    partToH: 260,
    hHold: 1000,
    crossbarDrop: 500,
    cardsSnap: 450,
    settle: 300,
  },
  responsive: {
    forallIn: 160,
    forallHold: 120,
    partToH: 200,
    hHold: 350,
    crossbarDrop: 320,
    cardsSnap: 0,
    settle: 150,
  },
};

export function ceremonyTotal(t: CeremonyTiming): number {
  return (
    t.forallIn +
    t.forallHold +
    t.partToH +
    t.hHold +
    t.crossbarDrop +
    t.cardsSnap +
    t.settle
  );
}

// Reduced-motion fallback per ADR §2: a brief fade rather than the full
// transformation. The ceremony component swaps to this when the user has
// `prefers-reduced-motion: reduce` set.
export const REDUCED_MOTION_FADE_MS = 200;
