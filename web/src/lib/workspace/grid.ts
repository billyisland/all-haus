// The lattice every draggable surface snaps to: vessel position/size on the
// workspace floor, the canvas origin, and the Glasshouse pane's drag/resize.
//
// 20 → 10 (2026-07-20, finer placement) → 8 (2026-07-22). 8 restores the
// phase with the 4px design rhythm (Tailwind spacing + the 4px slab) that 10
// broke — the exact repair this comment used to anticipate — and it equals the
// vessel WALL (Vessel.tsx), so on the columnar floor a gutter between adjacent
// vessels reads as three even coloured bands: wall / buffer / wall. The grid
// is invisible; the stripes are how you feel it (WORKSPACE-COLUMN-LAYOUT-ADR
// §II.3). Still even, so panes and vessels land on whole pixels.
//
// Values persisted on the 10px lattice re-snap to 8 on the next gesture —
// invisible in practice, and it saves a two-lattice interregnum.
export const GRID = 8;

export function snap(v: number): number {
  return Math.round(v / GRID) * GRID;
}

// The vessel size envelope, shared by the Vessel component's resize clamps and
// by the layout module (which aliases the minimums as SLOT_MIN_W/SLOT_MIN_H) —
// one definition, so no module mirrors another's constant. There is no
// intrinsic default width any more: a slot's width is stored, and a new one
// takes FACTORY_W (layout.ts).
// 224, not the historical 220: the minimum must sit ON the 8px lattice, or the
// regimented parade's minimum-width columns (and the Math.max(SLOT_MIN_W, …)
// rect floor) land off-grid while the resize floor (snapAtLeast) rounds up to
// 224 — two different minimums in practice. 2026-07-22 audit fix.
export const VESSEL_MIN_W = 224;
export const VESSEL_MIN_H = 200;
export const VESSEL_MAX_W = 2000;
export const VESSEL_MAX_H = 2000;
