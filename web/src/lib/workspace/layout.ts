import {
  GRID,
  snap,
  VESSEL_MIN_W,
  VESSEL_MIN_H,
  VESSEL_MAX_W,
} from "./grid";

// The columnar floor (WORKSPACE-COLUMN-LAYOUT-ADR §III–§V). Pure geometry: no
// React, no DOM, no store.
//
// GEOMETRY IS DERIVED, NEVER STORED. What persists is an ORDER — columns left
// to right, slots top to bottom — plus per-slot sizes. Pixel positions,
// gutters and the scroll extent are computed from it here. A state that
// violates the spacing rules is UNREPRESENTABLE, so this module has no
// detect / resolve / heal counterpart: the free-coordinate floor's
// `collision.ts` (findRestingPosition, clampSizeClear, repairRestingLayout)
// and `canvas.ts` (signed origin, computeExtent) exist to escape states this
// model cannot enter, and both die with the floor rewrite (Slice 3).
//
// Two consequences worth stating up front, because they are what make the
// rest simple:
//
//   1. THE FLOOR IS FINITE AND TAUT. Every gutter is exactly GRID and the
//      scroll extent is the last column's right edge plus GRID. Dragging
//      cannot create empty space; hiding cannot leave holes.
//   2. DEGRADATION IS DERIVATION'S JOB. A shrunken viewport (window resize, or
//      Slice 4 subtracting the nav row) compresses `null` slots toward
//      SLOT_MIN_H first and then squeezes fixed heights proportionally. The
//      STORED layout is never rewritten by a resize — geometry is a function
//      of layout AND viewport, so growing the window restores what shrinking
//      it hid.

// =============================================================================
// Types
// =============================================================================

export interface Slot {
  feedId: string;
  /** px, snapped to GRID. Slots in one column may differ; the widest wins. */
  w: number;
  /** px snapped, or null = "fill the remaining share of the column". */
  h: number | null;
}

export interface Column {
  /** Stable id, not a feed id — a column outlives the feeds passing through. */
  id: string;
  slots: Slot[];
}

export interface WorkspaceLayout {
  columns: Column[];
}

export interface Viewport {
  w: number;
  /** The FLOOR's height, not the window's — `WorkspaceView` subtracts the nav
   *  bar before derivation, because the bar insets the scroll viewport rather
   *  than sitting inside it (NavBar.tsx). */
  h: number;
}

export interface Rect {
  x: number;
  y: number;
  w: number;
  h: number;
}

export interface Geometry {
  /**
   * Final canvas coordinates, centring already applied. There is exactly one
   * conversion seam and this is it — consumers position from these rects and
   * convert nowhere else. (The free-coordinate floor had two coordinate
   * spaces and a per-frame origin; both are gone.)
   */
  rects: Map<string, Rect>;
  /** Canvas width: the scroll extent, never narrower than the viewport. */
  floorWidth: number;
  /** The centring shift already baked into `rects`. Reported for reference. */
  offsetX: number;
  /** Per-column bounding boxes, left to right. Drop resolution reads these. */
  columns: { id: string; x: number; w: number }[];
  /** The vertical run every column's stack shares, from y = GRID. Carried
   *  here so drop resolution needs no second viewport argument. */
  columnH: number;
}

/** The three outcomes of §IV.2, in priority order. */
export type Drop =
  | { kind: "merge"; targetFeedId: string }
  | {
      kind: "into-column";
      columnIndex: number;
      slotIndex: number;
      h: number | null;
    }
  | { kind: "new-column"; boundaryIndex: number };

// =============================================================================
// Constants (§III.3)
// =============================================================================

/**
 * Slot size envelope. Aliases of the vessel envelope — one definition, so no
 * module mirrors another's constant.
 */
export const SLOT_MIN_W = VESSEL_MIN_W;
export const SLOT_MIN_H = VESSEL_MIN_H;
export const SLOT_MAX_W = VESSEL_MAX_W;

/**
 * The first-run vessel, and the regimented-mode vessel (§V): wide, and full
 * available height. FACTORY_H is `null` rather than a number because "fill the
 * column" is the model's own way of saying full height — a stored number would
 * go stale the moment the viewport changed.
 */
export const FACTORY_W = 640;
export const FACTORY_H: number | null = null;

/**
 * §V regimented-view minimum column width — the floor the parade scales down to
 * before it admits horizontal scroll. Deliberately MUCH wider than the absolute
 * SLOT_MIN_W vessel floor (224): the parade's job is a readable overview, not
 * cramming every feed onto one screen, so it stays comfortable and scrolls once
 * the feeds no longer fit at this width. Grid-aligned (400 = 50·GRID). Tunable.
 */
export const REGIMENTED_MIN_W = 400;

/**
 * §IV.2's rect split. Within EDGE_BAND of a rect's edge the drop resolves to
 * INSERTION at that boundary; the central region arms a merge. Without the
 * split, a taut floor leaves only the 8px gutters as insertion targets and
 * reordering becomes a precision game.
 */
export const EDGE_BAND = 48;

/**
 * §IV.1 auto-pan. A taut floor has no gesture slack to drag into, so holding
 * the drag near a viewport edge pans the floor under it — the only way a drag
 * reaches an off-screen column. Speed is px per animation frame at full
 * proximity, scaling linearly to 0 at the margin's inner edge.
 */
export const AUTOPAN_MARGIN = 48;
export const AUTOPAN_MAX_SPEED = 24;

// =============================================================================
// Internals
// =============================================================================

const floorGrid = (v: number) => Math.floor(v / GRID) * GRID;

/** Lattice-aligned and at least `min` — snap first, then floor at the lattice
 *  multiple that covers `min`, so the result is never off-grid. */
function snapAtLeast(v: number, min: number): number {
  return Math.max(Math.ceil(min / GRID) * GRID, snap(v));
}

let idCounter = 0;

/** Column ids are opaque and nothing orders by them (§XI). */
export function newColumnId(): string {
  try {
    return crypto.randomUUID();
  } catch {
    idCounter += 1;
    return `col-${idCounter}`;
  }
}

export function makeColumn(slots: Slot[]): Column {
  return { id: newColumnId(), slots };
}

/** The vertical run available to a column's stack: the viewport less the
 *  top/bottom buffers (§III.2).
 *
 *  THE NAV CHROME IS NOT RESERVED HERE. This used to subtract a `navRowH` for
 *  the fixed bottom nav row; that parameter was deleted when the chrome moved
 *  (left rail 2026-08-24, top bar 2026-08-25) and must not come back. Chrome
 *  now insets the floor's scroll VIEWPORT, and its cost is already paid in the
 *  `vp` `WorkspaceView` hands us — shortened by the bar's height. Reserving it
 *  again here would charge for it twice.
 *
 *  FLOORED TO THE GRID so the whole vertical axis lives on the lattice. The raw
 *  viewport height is arbitrary, so `vp.h - 2·GRID` is off-grid whenever
 *  `vp.h` is not a multiple of GRID. A `null` slot then fills the
 *  column to that off-grid H, but a FIXED slot can only reach `floorGrid(H)` (a
 *  resize snaps to the grid, and clampSlotSize caps at the grid multiple below
 *  H) — so a resized vessel could never line its bottom up with a null-filled
 *  neighbour, always `H mod GRID` px short (the regimented-mode "won't line up"
 *  bug). Flooring here makes H itself a grid multiple, so the max fixed height
 *  equals the null fill exactly; the up-to-GRID remainder just pads the bottom
 *  buffer, below the last row and invisible. SLOT_MIN_H is grid-aligned, so the
 *  floor branch stays on the lattice too. */
export function availableHeight(vp: Viewport): number {
  return Math.max(SLOT_MIN_H, floorGrid(vp.h - 2 * GRID));
}

/**
 * Heights for one column's slots, in order. Fixed slots take their stored `h`
 * (floored at the minimum); `null` slots divide the remainder equally. When
 * the stack cannot fit, `null` slots have already bottomed out at SLOT_MIN_H,
 * so the fixed heights squeeze proportionally toward the same floor.
 *
 * If even every slot at SLOT_MIN_H overflows H, the column overflows: a stack
 * of ten feeds in a 400px window has no useful rendering, and silently
 * dropping slots would lose feeds. Callers may scroll; nothing is rewritten.
 */
function columnHeights(slots: Slot[], H: number): number[] {
  const n = slots.length;
  if (n === 0) return [];
  const avail = H - (n - 1) * GRID;

  const fixedIdx: number[] = [];
  const nullIdx: number[] = [];
  slots.forEach((s, i) => (s.h === null ? nullIdx : fixedIdx).push(i));

  const heights = new Array<number>(n);
  let fixedTotal = 0;
  for (const i of fixedIdx) {
    heights[i] = Math.max(SLOT_MIN_H, floorGrid(slots[i].h as number));
    fixedTotal += heights[i];
  }

  let share = 0;
  if (nullIdx.length > 0) {
    share = Math.max(
      SLOT_MIN_H,
      Math.floor((avail - fixedTotal) / nullIdx.length),
    );
    for (const i of nullIdx) heights[i] = share;
  }

  const total = fixedTotal + share * nullIdx.length;
  if (total > avail && fixedIdx.length > 0) {
    const minFixed = fixedIdx.length * SLOT_MIN_H;
    const target = Math.max(minFixed, avail - share * nullIdx.length);
    const slack = fixedTotal - minFixed;
    const scale =
      slack > 0 ? Math.max(0, Math.min(1, (target - minFixed) / slack)) : 0;
    for (const i of fixedIdx) {
      heights[i] = Math.max(
        SLOT_MIN_H,
        Math.floor(SLOT_MIN_H + (heights[i] - SLOT_MIN_H) * scale),
      );
    }
  }

  return heights;
}

function columnWidth(col: Column): number {
  let w = SLOT_MIN_W;
  for (const s of col.slots) if (s.w > w) w = s.w;
  return w;
}

// =============================================================================
// Derivation (§III.2)
// =============================================================================

/**
 * The one pure function the whole floor renders from.
 *
 * Columns run left to right from a GRID buffer; each subsequent column starts
 * one GRID past the previous column's bounding right edge. Slots narrower than
 * their column left-align within it, so every vessel's numeral edge stays on
 * the shared gridline. `floorWidth` is the last column's right edge plus GRID
 * — taut, with no signed origin and no `computeExtent`. When the whole strip
 * is narrower than the viewport (the first-run state) it centres.
 */
export function deriveGeometry(
  layout: WorkspaceLayout,
  vp: Viewport,
): Geometry {
  const H = availableHeight(vp);
  const rects = new Map<string, Rect>();
  const columns: { id: string; x: number; w: number }[] = [];

  let x = GRID;
  for (const col of layout.columns) {
    const w = columnWidth(col);
    const heights = columnHeights(col.slots, H);
    let y = GRID;
    col.slots.forEach((slot, i) => {
      rects.set(slot.feedId, { x, y, w: Math.max(SLOT_MIN_W, slot.w), h: heights[i] });
      y += heights[i] + GRID;
    });
    columns.push({ id: col.id, x, w });
    x += w + GRID;
  }

  const contentWidth = layout.columns.length === 0 ? GRID : x;
  const offsetX = contentWidth < vp.w ? floorGrid((vp.w - contentWidth) / 2) : 0;

  if (offsetX !== 0) {
    for (const [id, r] of rects) rects.set(id, { ...r, x: r.x + offsetX });
    for (const c of columns) c.x += offsetX;
  }

  return {
    rects,
    floorWidth: Math.max(vp.w, contentWidth),
    offsetX,
    columns,
    columnH: H,
  };
}

// =============================================================================
// Drop resolution (§IV.2)
// =============================================================================

/**
 * Where a drag would land, resolved against the pointer.
 *
 * INDEX CONTRACT: the returned `columnIndex`/`slotIndex`/`boundaryIndex`
 * address `layout` AS PASSED — that is, with the lifted feed's slot STILL IN
 * PLACE. §IV.1 holds the slot open for the whole gesture (collapsing it live
 * would shrink `floorWidth` mid-drag, the browser would clamp `scrollLeft`,
 * and the floor would slide under the pointer), so geometry is stable and the
 * resolver runs against a fixed frame. `applyDrop` performs the removal and
 * the index adjustment it implies — never pre-remove the slot yourself.
 *
 * Every pointer position maps to some legal drop, which is what makes "drag as
 * far as you like" safe: release in empty space and the vessel takes the
 * nearest gap, one buffer from its neighbour, never lost.
 */
export function resolveDrop(
  layout: WorkspaceLayout,
  geom: Geometry,
  pointer: { x: number; y: number },
  lifted: { feedId: string; w: number; h: number | null },
): Drop {
  const cols = geom.columns;
  if (cols.length === 0) return { kind: "new-column", boundaryIndex: 0 };

  // Clamp y into the column run. The top and bottom buffers are GRID tall and
  // a pointer there means "the end of this stack", not "nowhere" — every
  // pointer position must resolve to some legal drop.
  const py = Math.min(GRID + geom.columnH, Math.max(GRID, pointer.y));

  // Which column's x-span holds the pointer? Outside them all, the pointer is
  // in a gutter or past an end: a new column at the nearest boundary.
  let ci = -1;
  for (let i = 0; i < cols.length; i++) {
    const c = cols[i];
    if (pointer.x >= c.x && pointer.x <= c.x + c.w) {
      ci = i;
      break;
    }
  }
  if (ci === -1) {
    let boundaryIndex = cols.length;
    for (let i = 0; i < cols.length; i++) {
      if (pointer.x < cols[i].x) {
        boundaryIndex = i;
        break;
      }
    }
    return { kind: "new-column", boundaryIndex };
  }

  const col = layout.columns[ci];
  const span = cols[ci];

  // The lifted feed's own slot is held open: it is not a merge target, and the
  // space it occupies reads as a gap — which is exactly how a drop back where
  // it came from resolves to a no-op.
  const occupied = col.slots
    .map((slot, slotIndex) => ({
      slotIndex,
      slot,
      rect: geom.rects.get(slot.feedId),
    }))
    .filter(
      (
        e,
      ): e is {
        slotIndex: number;
        slot: Slot;
        rect: Rect;
      } => !!e.rect && e.slot.feedId !== lifted.feedId,
    );

  // Hit-test against the SLOT'S OWN RECT, not the column span: a slot narrower
  // than its column left-aligns, and the visually empty band beside it must not
  // read as "over that feed" — a merge armed on empty ground is a false
  // affordance (2026-07-22 audit fix). A pointer in that band falls through to
  // rule 2 (a real y-gap) or the nearest-boundary fallback below.
  const hit = occupied.find(
    (e) =>
      pointer.x >= e.rect.x &&
      pointer.x <= e.rect.x + e.rect.w &&
      py >= e.rect.y &&
      py <= e.rect.y + e.rect.h,
  );

  if (hit) {
    // §IV.2 rule 1 — over a feed, split by zone. Bands never eat more than a
    // third of the rect, so a central merge region always exists however small
    // the vessel is.
    //
    // The vertical bands are CAPACITY-GATED (2026-07-22 audit fix): rule 2's
    // gap insertion checks the run it lands in, but a band insertion used to
    // check nothing — stacking a slot into a column that cannot hold another
    // SLOT_MIN_H overflows the column below the nav row, where the floor
    // (overflowY: hidden) has no vertical scroll to reach it. A move WITHIN
    // the column never changes the slot count, so it always passes.
    const H = geom.columnH;
    const stackFits =
      col.slots.some((s) => s.feedId === lifted.feedId) ||
      (occupied.length + 1) * SLOT_MIN_H + occupied.length * GRID <= H;
    const bandX = Math.min(EDGE_BAND, Math.floor(hit.rect.w / 3));
    const bandY = Math.min(EDGE_BAND, Math.floor(hit.rect.h / 3));
    const dLeft = pointer.x - hit.rect.x;
    const dRight = hit.rect.x + hit.rect.w - pointer.x;
    const dTop = py - hit.rect.y;
    const dBottom = hit.rect.y + hit.rect.h - py;

    const candidates: { d: number; drop: Drop }[] = [];
    if (dLeft < bandX)
      candidates.push({
        d: dLeft,
        drop: { kind: "new-column", boundaryIndex: ci },
      });
    if (dRight < bandX)
      candidates.push({
        d: dRight,
        drop: { kind: "new-column", boundaryIndex: ci + 1 },
      });
    if (stackFits && dTop < bandY)
      candidates.push({
        d: dTop,
        drop: {
          kind: "into-column",
          columnIndex: ci,
          slotIndex: hit.slotIndex,
          h: lifted.h,
        },
      });
    if (stackFits && dBottom < bandY)
      candidates.push({
        d: dBottom,
        drop: {
          kind: "into-column",
          columnIndex: ci,
          slotIndex: hit.slotIndex + 1,
          h: lifted.h,
        },
      });

    if (candidates.length > 0) {
      candidates.sort((a, b) => a.d - b.d);
      return candidates[0].drop;
    }
    return { kind: "merge", targetFeedId: hit.slot.feedId };
  }

  // §IV.2 rule 2 — a vertical gap in the stack, including above the first slot
  // and below the last. `h` auto-fits: the free run less the buffers the
  // insertion needs against whichever neighbours it actually has.
  const H = geom.columnH;
  const top = GRID;
  const bottom = top + H;
  let prevBottom = top;
  let prevExists = false;
  for (let k = 0; k <= occupied.length; k++) {
    const next = occupied[k];
    const nextTop = next ? next.rect.y : bottom;
    if (py >= prevBottom && py <= nextTop) {
      const neighbours = (prevExists ? 1 : 0) + (next ? 1 : 0);
      const run = nextTop - prevBottom;
      const fit = floorGrid(run - neighbours * GRID);
      const slotIndex = next ? next.slotIndex : col.slots.length;
      // Dropping back into the space its own slot vacated: a true no-op, so
      // the vessel keeps the height it was dragged at rather than auto-fitting
      // to the run it already fills.
      // Its own slot was skipped when building `occupied`, so the run that
      // brackets it always reports the index just past it.
      const ownIndex = col.slots.findIndex((s) => s.feedId === lifted.feedId);
      if (ownIndex !== -1 && slotIndex === ownIndex + 1)
        return {
          kind: "into-column",
          columnIndex: ci,
          slotIndex: ownIndex,
          h: lifted.h,
        };
      if (fit >= SLOT_MIN_H)
        return { kind: "into-column", columnIndex: ci, slotIndex, h: fit };
      break;
    }
    if (next) {
      prevBottom = next.rect.y + next.rect.h;
      prevExists = true;
    }
  }

  // A gutter too tight to take a slot, or the empty band beside a slot
  // narrower than its column: fall back to a new column at the nearer boundary
  // of this column. Placement always succeeds.
  const boundaryIndex =
    pointer.x - span.x < span.x + span.w - pointer.x ? ci : ci + 1;
  return { kind: "new-column", boundaryIndex };
}

// =============================================================================
// Mutations
// =============================================================================

function findSlot(
  layout: WorkspaceLayout,
  feedId: string,
): { columnIndex: number; slotIndex: number; slot: Slot } | null {
  for (let ci = 0; ci < layout.columns.length; ci++) {
    const si = layout.columns[ci].slots.findIndex((s) => s.feedId === feedId);
    if (si !== -1)
      return {
        columnIndex: ci,
        slotIndex: si,
        slot: layout.columns[ci].slots[si],
      };
  }
  return null;
}

/** Splice a feed's slot out, dropping the column if that empties it. */
function extract(layout: WorkspaceLayout, feedId: string) {
  const at = findSlot(layout, feedId);
  if (!at) return { layout, removed: null };
  const columns = layout.columns
    .map((c, i) =>
      i === at.columnIndex
        ? { ...c, slots: c.slots.filter((s) => s.feedId !== feedId) }
        : c,
    )
    .filter((c) => c.slots.length > 0);
  return { layout: { columns }, removed: at.slot };
}

const clamp = (v: number, lo: number, hi: number) =>
  Math.max(lo, Math.min(hi, v));

/**
 * Commit a resolved drop. See `resolveDrop`'s INDEX CONTRACT: the drop's
 * indices address the layout with the lifted slot STILL IN PLACE, so the slot
 * is spliced out here while its (possibly now empty) column is LEFT STANDING —
 * indices then line up with no arithmetic, and the empty column is pruned at
 * the end. Keeping the column object also preserves its id, which is what
 * makes a drop back into a one-slot column a genuine no-op rather than a
 * same-looking rebuild.
 *
 * `merge` is a no-op here by design: merging is a server call behind a
 * confirmation dialog, and the caller routes it (confirm -> server merge, then
 * `removeFeed`; decline -> nothing at all, because the source never left the
 * layout).
 */
export function applyDrop(
  layout: WorkspaceLayout,
  feedId: string,
  drop: Drop,
): WorkspaceLayout {
  if (drop.kind === "merge") return layout;

  const at = findSlot(layout, feedId);
  if (!at) return layout;

  const columns = layout.columns.map((c, i) =>
    i === at.columnIndex
      ? { ...c, slots: c.slots.filter((s) => s.feedId !== feedId) }
      : c,
  );

  if (drop.kind === "new-column") {
    columns.splice(
      clamp(drop.boundaryIndex, 0, columns.length),
      0,
      makeColumn([at.slot]),
    );
  } else {
    const ci = clamp(drop.columnIndex, 0, columns.length - 1);
    // Only a move WITHIN the source column shifts an index, and only for a
    // target below the vacated slot.
    const si =
      ci === at.columnIndex && at.slotIndex < drop.slotIndex
        ? drop.slotIndex - 1
        : drop.slotIndex;
    const slots = [...columns[ci].slots];
    slots.splice(clamp(si, 0, slots.length), 0, { ...at.slot, h: drop.h });
    columns[ci] = { ...columns[ci], slots };
  }

  return { columns: columns.filter((c) => c.slots.length > 0) };
}

/**
 * Whether committing `drop` would leave the layout structurally unchanged —
 * same columns, same slot order, same sizes (column IDENTITY is ignored: a
 * sole-slot column re-created at its own boundary is still a no-op). The
 * canonical case is a drop back into the lifted feed's own held-open slot —
 * the natural "never mind" release — but a band insertion immediately
 * adjacent to the vacated slot lands identically and must read the same way.
 *
 * The host checks this BEFORE committing: under regimented mode a committed
 * drop materialises the parade over the stored custom layout (§V), so a
 * no-op release must commit NOTHING — materialising on a changed-my-mind drop
 * would silently destroy the user's arrangement (2026-07-22 audit fix). In
 * custom mode it merely spares a pointless persist.
 */
export function dropIsNoop(
  layout: WorkspaceLayout,
  feedId: string,
  drop: Drop,
): boolean {
  if (drop.kind === "merge") return false;
  const next = applyDrop(layout, feedId, drop);
  if (next === layout) return true;
  if (next.columns.length !== layout.columns.length) return false;
  return next.columns.every((c, i) => {
    const o = layout.columns[i];
    return (
      c.slots.length === o.slots.length &&
      c.slots.every((s, j) => {
        const t = o.slots[j];
        return s.feedId === t.feedId && s.w === t.w && s.h === t.h;
      })
    );
  });
}

/** A new feed appends a new right-most column at factory size (§III.5).
 *  Idempotent — the bootstrap reconcile calls it over the whole feed list. */
export function insertFeed(
  layout: WorkspaceLayout,
  feedId: string,
): WorkspaceLayout {
  if (findSlot(layout, feedId)) return layout;
  return {
    columns: [
      ...layout.columns,
      makeColumn([{ feedId, w: FACTORY_W, h: FACTORY_H }]),
    ],
  };
}

/** Hide, delete, or merge-away: splice the slot, drop an emptied column, and
 *  let recomputation compact the floor (§IV.5). */
export function removeFeed(
  layout: WorkspaceLayout,
  feedId: string,
): WorkspaceLayout {
  const { layout: next, removed } = extract(layout, feedId);
  return removed ? next : layout;
}

/** Where a feed's slot sits, captured BEFORE a removal so a failed server
 *  call can put it back (`restoreSlot`). Column identity rides the id, so the
 *  restore survives unrelated columns moving in between. */
export interface SlotLocation {
  slot: Slot;
  columnId: string;
  columnIndex: number;
  slotIndex: number;
}

export function locateSlot(
  layout: WorkspaceLayout,
  feedId: string,
): SlotLocation | null {
  const at = findSlot(layout, feedId);
  if (!at) return null;
  return {
    slot: at.slot,
    columnId: layout.columns[at.columnIndex].id,
    columnIndex: at.columnIndex,
    slotIndex: at.slotIndex,
  };
}

/**
 * Put a removed slot back where it came from — the faithful revert for an
 * optimistic removal whose server call failed (the hide PATCH). Without this,
 * the revert was `insertFeed`, which re-enters at the right end at factory
 * size: a transient network failure REARRANGED the floor (2026-07-22 audit
 * fix). If the column still exists (by id) the slot splices back at its old
 * index; if the removal emptied and pruned it, the column is re-created at its
 * old position. A feed already placed again is left alone.
 */
export function restoreSlot(
  layout: WorkspaceLayout,
  removed: SlotLocation,
): WorkspaceLayout {
  if (findSlot(layout, removed.slot.feedId)) return layout;
  const ci = layout.columns.findIndex((c) => c.id === removed.columnId);
  if (ci !== -1) {
    const col = layout.columns[ci];
    const slots = [...col.slots];
    slots.splice(Math.min(removed.slotIndex, slots.length), 0, removed.slot);
    const columns = [...layout.columns];
    columns[ci] = { ...col, slots };
    return { columns };
  }
  const columns = [...layout.columns];
  columns.splice(Math.min(removed.columnIndex, columns.length), 0, {
    id: removed.columnId,
    slots: [removed.slot],
  });
  return { columns };
}

/** The slot a feed occupies, or null. Exported so the floor can read the
 *  lifted slot's own `w`/`h` when it hands `resolveDrop` its `lifted` argument
 *  — `h` in particular, because `null` (fill the column) must survive a drag
 *  rather than being frozen into a number by the DOM. */
export function slotFor(
  layout: WorkspaceLayout,
  feedId: string,
): Slot | null {
  return findSlot(layout, feedId)?.slot ?? null;
}

/**
 * §IV.3's clamps, without the commit. Width is free to the envelope maximum —
 * growing it grows the column's bounding width and the columns to the right
 * slide, so no clamp-at-neighbour is needed (the free-coordinate floor's
 * `clampSizeClear` has no successor). Height clamps at what the stack can
 * still hold: fixed-height siblings are not squeezed, `null` siblings compress
 * to SLOT_MIN_H.
 *
 * Split out from `resizeSlot` so the live gesture can clamp every FRAME
 * (the handle visibly stops where the commit would) with one definition of the
 * envelope, not two.
 */
export function clampSlotSize(
  layout: WorkspaceLayout,
  feedId: string,
  size: { w: number; h: number },
  vp: Viewport,
): { w: number; h: number } {
  const w = Math.min(SLOT_MAX_W, snapAtLeast(size.w, SLOT_MIN_W));
  const at = findSlot(layout, feedId);
  if (!at) return { w, h: snapAtLeast(size.h, SLOT_MIN_H) };

  const col = layout.columns[at.columnIndex];
  const H = availableHeight(vp);
  let siblingFloor = 0;
  col.slots.forEach((s, i) => {
    if (i === at.slotIndex) return;
    siblingFloor +=
      s.h === null ? SLOT_MIN_H : Math.max(SLOT_MIN_H, floorGrid(s.h));
  });
  const maxH = floorGrid(H - (col.slots.length - 1) * GRID - siblingFloor);
  const h = Math.max(
    SLOT_MIN_H,
    Math.min(Math.max(SLOT_MIN_H, maxH), snapAtLeast(size.h, SLOT_MIN_H)),
  );
  return { w, h };
}

/**
 * §IV.3. Commit a resize: clamp per `clampSlotSize`, then stamp the slot.
 */
export function resizeSlot(
  layout: WorkspaceLayout,
  feedId: string,
  size: { w: number; h: number },
  vp: Viewport,
): WorkspaceLayout {
  const at = findSlot(layout, feedId);
  if (!at) return layout;
  return withSlotSize(layout, feedId, clampSlotSize(layout, feedId, size, vp));
}

/**
 * Stamp a slot's size with no clamping. The live-resize preview path: the
 * gesture has already clamped (`clampSlotSize`), and feeding the proposal
 * through derivation is what makes the columns to the right slide WITH the
 * handle instead of jumping on release. Never a persistence path — `resizeSlot`
 * is.
 */
export function withSlotSize(
  layout: WorkspaceLayout,
  feedId: string,
  size: { w: number; h: number },
): WorkspaceLayout {
  const at = findSlot(layout, feedId);
  if (!at) return layout;
  const col = layout.columns[at.columnIndex];
  const slots = [...col.slots];
  slots[at.slotIndex] = { ...slots[at.slotIndex], w: size.w, h: size.h };
  const columns = [...layout.columns];
  columns[at.columnIndex] = { ...col, slots };
  return { columns };
}

/**
 * §V. The parade-ground view: every visible feed on screen at once, one column
 * each, numeral order, factory dimensions. If n at factory width overflows the
 * viewport, widths scale down uniformly; below REGIMENTED_MIN_W it admits
 * horizontal scroll rather than render uselessly narrow feeds. (The floor is
 * REGIMENTED_MIN_W, comfortably wider than SLOT_MIN_W — readability over fit.)
 *
 * This DERIVES a transient layout — it is a view over the feed list, never an
 * edit. The user's stored layout is untouched, which is what makes leaving
 * regimented mode trivial and crash-safe: there is no snapshot to lose.
 */
export function regimentedLayout(
  feeds: { id: string; sortRank: number }[],
  vp: Viewport,
): WorkspaceLayout {
  const ordered = [...feeds].sort(
    (a, b) => a.sortRank - b.sortRank || (a.id < b.id ? -1 : 1),
  );
  const n = ordered.length;
  if (n === 0) return { columns: [] };

  const avail = vp.w - (n + 1) * GRID;
  const fit = floorGrid(avail / n);
  const w = Math.max(REGIMENTED_MIN_W, Math.min(FACTORY_W, fit));

  return {
    columns: ordered.map((f) => makeColumn([{ feedId: f.id, w, h: null }])),
  };
}

/** First run, and the shape `reconcileFeeds` builds from nothing: one column
 *  per feed at factory size (§III.4). The gateway clones EVERY starter
 *  template for a new owner, so n is not assumed to be 1. */
export function layoutFromFeeds(feedIds: string[]): WorkspaceLayout {
  return {
    columns: feedIds.map((feedId) =>
      makeColumn([{ feedId, w: FACTORY_W, h: FACTORY_H }]),
    ),
  };
}

/** Every feed the layout places, in column-then-slot order. */
export function layoutFeedIds(layout: WorkspaceLayout): string[] {
  return layout.columns.flatMap((c) => c.slots.map((s) => s.feedId));
}
