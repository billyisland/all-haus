import { GRID } from "./grid";
import { availableHeight, FACTORY_W, REGIMENTED_MIN_W } from "./layout";
import {
  QUEUE_COMPACT_RATIO,
  QUEUE_FOCAL_VW,
  VESSEL_PAD,
  VESSEL_WALL,
} from "../../components/workspace/tokens";

// The queue's geometry (WORKSPACE-QUEUE-ADR §VII.1). Pure, like
// `deriveGeometry`, and like it DERIVED, never stored: a window resize
// recomputes it and nothing is written.
//
// EVERY NUMBER IS THE FLOOR'S (D4). The focal width is clamped between the
// floor's own readable minimum (`REGIMENTED_MIN_W`) and a new vessel's width
// (`FACTORY_W`); every inset and gap is `GRID`, so a run of lines reads as the
// floor's gutter — wall / buffer / wall in even 8px bands; and the entry height
// is the one a single `null` slot gets on the floor, so a queue entry and a
// floor column stand the same height. Two ratios are the queue's own, and they
// live in tokens.ts beside the vessel numbers.

export interface QueueGeometry {
  /** The focal entry, and the chassis at every width (§VII.2). */
  focalW: number;
  /** A feed ahead. */
  compactW: number;
  /** A passed feed: the wall and nothing else. */
  lineW: number;
  /** Every entry. */
  entryH: number;
  /** The left inset, the top inset and every gap. */
  gap: number;
  /** The full card list's resting width — it never changes width (§VI.4). */
  fullListW: number;
  /** The preview layer's resting width. */
  previewListW: number;
}

const clamp = (lo: number, v: number, hi: number) =>
  Math.min(hi, Math.max(lo, v));
/** DOWN to the lattice, not to the nearest point on it: §VII.1's worked
 *  figure (1280 → 584) is a floor, where `snap` would give 592. Both bounds
 *  are lattice points, so flooring cannot leave the clamp's band. */
const floorGrid = (v: number) => Math.floor(v / GRID) * GRID;

/** `w` and `h` are the INSET viewport: `h` already shortened by the nav bar,
 *  as on the floor. */
export function queueGeometry(vp: { w: number; h: number }): QueueGeometry {
  const focalW = floorGrid(clamp(REGIMENTED_MIN_W, QUEUE_FOCAL_VW * vp.w, FACTORY_W));
  const compactW = floorGrid(QUEUE_COMPACT_RATIO * focalW);
  const interior = 2 * VESSEL_WALL + 2 * VESSEL_PAD;
  return {
    focalW,
    compactW,
    lineW: VESSEL_WALL,
    entryH: availableHeight(vp),
    gap: GRID,
    fullListW: focalW - interior,
    previewListW: compactW - interior,
  };
}
