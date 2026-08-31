import { describe, it, expect } from "vitest";
import { GRID } from "./grid";
import {
  deriveGeometry,
  resolveDrop,
  applyDrop,
  dropIsNoop,
  insertFeed,
  removeFeed,
  resizeSlot,
  locateSlot,
  restoreSlot,
  regimentedLayout,
  layoutFromFeeds,
  layoutFeedIds,
  makeColumn,
  availableHeight,
  SLOT_MIN_W,
  SLOT_MIN_H,
  FACTORY_W,
  REGIMENTED_MIN_W,
  EDGE_BAND,
  type WorkspaceLayout,
  type Viewport,
  type Geometry,
  type Rect,
  type Drop,
} from "./layout";

// The invariants under test (WORKSPACE-COLUMN-LAYOUT-ADR §II–§V). The model's
// whole claim is that an illegal state is UNREPRESENTABLE, so the tests that
// matter are the ones asserting no sequence of gestures can produce one: every
// pointer position resolves to a legal drop, and applying any legal drop
// yields a layout whose derived geometry is still taut and non-overlapping.
//
// This file replaces `collision.test.ts` at Slice 3, and inherits its
// property-corpus discipline: fixtures pin the reasoning, a randomised corpus
// guards the universal claim, and the corpus spans resize-scale sizes because
// a corpus that stops where legal gestures keep going proves nothing.

const VP: Viewport = { w: 1440, h: 900};

function overlaps(a: Rect, b: Rect): boolean {
  return !(
    a.x >= b.x + b.w ||
    a.x + a.w <= b.x ||
    a.y >= b.y + b.h ||
    a.y + a.h <= b.y
  );
}

/** A layout is legal iff every feed appears exactly once and no column is
 *  empty — the two shapes the mutations must never produce. */
function expectLegalLayout(layout: WorkspaceLayout, label = "") {
  const ids = layoutFeedIds(layout);
  expect(new Set(ids).size, `${label}: duplicate feed`).toBe(ids.length);
  for (const c of layout.columns) {
    expect(c.slots.length, `${label}: empty column`).toBeGreaterThan(0);
  }
}

/** Every geometric claim §II makes, checked at once. */
function expectTautGeometry(layout: WorkspaceLayout, vp: Viewport, label = "") {
  const geom = deriveGeometry(layout, vp);
  const rects = [...geom.rects.values()];

  for (let i = 0; i < rects.length; i++) {
    for (let j = i + 1; j < rects.length; j++) {
      expect(overlaps(rects[i], rects[j]), `${label}: rects overlap`).toBe(
        false,
      );
    }
  }

  // Column gutters are exactly GRID; the first column sits one GRID in.
  for (let i = 0; i < geom.columns.length; i++) {
    const c = geom.columns[i];
    if (i === 0) {
      expect(c.x - geom.offsetX, `${label}: left buffer`).toBe(GRID);
    } else {
      const prev = geom.columns[i - 1];
      expect(c.x - (prev.x + prev.w), `${label}: column gutter`).toBe(GRID);
    }
  }

  // Slot gutters within a column are exactly GRID, and slots left-align.
  layout.columns.forEach((col, ci) => {
    let prev: Rect | null = null;
    for (const slot of col.slots) {
      const r = geom.rects.get(slot.feedId);
      expect(r, `${label}: missing rect`).toBeTruthy();
      if (!r) continue;
      expect(r.x, `${label}: slot left-aligns in column`).toBe(
        geom.columns[ci].x,
      );
      expect(r.w, `${label}: slot within column bounds`).toBeLessThanOrEqual(
        geom.columns[ci].w,
      );
      if (prev) {
        expect(r.y - (prev.y + prev.h), `${label}: slot gutter`).toBe(GRID);
      } else {
        expect(r.y, `${label}: top buffer`).toBe(GRID);
      }
      prev = r;
    }
  });

  return geom;
}

// =============================================================================
// deriveGeometry (§III.2)
// =============================================================================

describe("deriveGeometry", () => {
  it("centres a strip narrower than the viewport (the first-run state)", () => {
    const layout = layoutFromFeeds(["a"]);
    const geom = deriveGeometry(layout, VP);
    expect(geom.floorWidth).toBe(VP.w);
    expect(geom.offsetX).toBeGreaterThan(0);
    const r = geom.rects.get("a")!;
    // Equal margins either side, to within the lattice.
    expect(Math.abs(r.x - (VP.w - (r.x + r.w)))).toBeLessThanOrEqual(GRID);
  });

  it("centres n starter columns too — first run is not assumed to be one feed", () => {
    const geom = deriveGeometry(layoutFromFeeds(["a", "b"]), VP);
    expect(geom.offsetX).toBeGreaterThan(0);
    expect(geom.columns).toHaveLength(2);
    expect(geom.columns[1].x - (geom.columns[0].x + geom.columns[0].w)).toBe(
      GRID,
    );
  });

  it("left-aligns and reports a taut extent once content exceeds the viewport", () => {
    const layout = layoutFromFeeds(["a", "b", "c"]);
    const geom = deriveGeometry(layout, { w: 900, h: 900});
    expect(geom.offsetX).toBe(0);
    const last = geom.columns[geom.columns.length - 1];
    expect(geom.floorWidth).toBe(last.x + last.w + GRID);
  });

  it("fills the column with a single null slot", () => {
    const layout = layoutFromFeeds(["a"]);
    const geom = deriveGeometry(layout, VP);
    expect(geom.rects.get("a")!.h).toBe(availableHeight(VP));
  });

  it("divides the remainder equally between null slots", () => {
    const layout: WorkspaceLayout = {
      columns: [
        makeColumn([
          { feedId: "a", w: FACTORY_W, h: null },
          { feedId: "b", w: FACTORY_W, h: null },
        ]),
      ],
    };
    const geom = deriveGeometry(layout, VP);
    const a = geom.rects.get("a")!;
    const b = geom.rects.get("b")!;
    expect(a.h).toBe(b.h);
    expect(a.h + b.h + GRID).toBeLessThanOrEqual(availableHeight(VP));
  });

  it("takes the widest slot as the column's bounding width", () => {
    const layout: WorkspaceLayout = {
      columns: [
        makeColumn([
          { feedId: "a", w: 320, h: 300 },
          { feedId: "b", w: 640, h: 300 },
        ]),
      ],
    };
    const geom = deriveGeometry(layout, VP);
    expect(geom.columns[0].w).toBe(640);
    expect(geom.rects.get("a")!.w).toBe(320);
  });

  it("compresses null slots before squeezing fixed ones on a shrunken viewport", () => {
    const layout: WorkspaceLayout = {
      columns: [
        makeColumn([
          { feedId: "fixed", w: 400, h: 600 },
          { feedId: "fill", w: 400, h: null },
        ]),
      ],
    };
    // 676 of run for a 600 + fill stack: the fill slot bottoms out at the
    // minimum first, and only then does the fixed slot give way.
    const short = { w: 1440, h: 700};
    const geom = deriveGeometry(layout, short);
    expect(geom.rects.get("fill")!.h).toBe(SLOT_MIN_H);
    expect(geom.rects.get("fixed")!.h).toBeLessThan(600);
    expect(geom.rects.get("fixed")!.h).toBeGreaterThanOrEqual(SLOT_MIN_H);
  });

  it("never rewrites the stored layout when the viewport shrinks", () => {
    const layout: WorkspaceLayout = {
      columns: [makeColumn([{ feedId: "a", w: 400, h: 600 }])],
    };
    const before = JSON.stringify(layout);
    deriveGeometry(layout, { w: 600, h: 400});
    expect(JSON.stringify(layout)).toBe(before);
    // …and the stored height is honoured again once the room comes back.
    expect(deriveGeometry(layout, VP).rects.get("a")!.h).toBe(600);
  });

  it("keeps every rect inside the available height", () => {
    const layout: WorkspaceLayout = {
      columns: [
        makeColumn([
          { feedId: "a", w: 400, h: 5000 },
          { feedId: "b", w: 400, h: null },
        ]),
      ],
    };
    const geom = deriveGeometry(layout, VP);
    const H = availableHeight(VP);
    for (const r of geom.rects.values()) {
      expect(r.y).toBeGreaterThanOrEqual(GRID);
      expect(r.y + r.h).toBeLessThanOrEqual(GRID + H);
    }
  });

  // The nav ROW used to be reserved here, via a `navRowH` on the viewport. The
  // chrome that replaced it (now NavBar.tsx, a top bar) insets the floor's scroll
  // viewport instead, so the whole height is the floor's again and the only
  // thing derivation still holds back is the two GRID buffers. Reserving the
  // bar is `WorkspaceView`'s job and shows up here only as a shorter `vp.h`.
  it("gives a filling slot the whole viewport height less the two buffers", () => {
    const layout = layoutFromFeeds(["a"]);
    const geom = deriveGeometry(layout, VP);
    expect(availableHeight(VP)).toBe(880); // 900 - 2·GRID, floored to the grid
    expect(geom.rects.get("a")!.h).toBe(availableHeight(VP));
  });

  it("the rail's cost is width only: narrowing vp.w re-centres, height holds", () => {
    const RAIL = 56;
    const layout = layoutFromFeeds(["a"]);
    const wide = deriveGeometry(layout, VP);
    const railed = deriveGeometry(layout, { ...VP, w: VP.w - RAIL });
    expect(railed.rects.get("a")!.h).toBe(wide.rects.get("a")!.h);
    // Content centres in whatever width it is handed, to within a GRID (the
    // offset is grid-floored). This is the whole of what the rail costs.
    const offCentre = (g: Geometry, w: number) => {
      const r = g.rects.get("a")!;
      return r.x + r.w / 2 - w / 2;
    };
    expect(Math.abs(offCentre(wide, VP.w))).toBeLessThan(GRID);
    expect(Math.abs(offCentre(railed, VP.w - RAIL))).toBeLessThan(GRID);
  });

  it("handles an empty layout", () => {
    const geom = deriveGeometry({ columns: [] }, VP);
    expect(geom.rects.size).toBe(0);
    expect(geom.floorWidth).toBe(VP.w);
  });
});

// =============================================================================
// Mutations
// =============================================================================

describe("insertFeed / removeFeed", () => {
  it("appends a new right-most column at factory size", () => {
    const layout = insertFeed(layoutFromFeeds(["a"]), "b");
    expect(layout.columns).toHaveLength(2);
    expect(layout.columns[1].slots[0]).toEqual({
      feedId: "b",
      w: FACTORY_W,
      h: null,
    });
  });

  it("is idempotent — the bootstrap reconcile runs it over the whole list", () => {
    const once = insertFeed(layoutFromFeeds(["a"]), "b");
    expect(insertFeed(once, "b")).toBe(once);
  });

  it("drops a column the removal empties, and compacts", () => {
    const layout = layoutFromFeeds(["a", "b", "c"]);
    const next = removeFeed(layout, "b");
    expect(next.columns).toHaveLength(2);
    expect(layoutFeedIds(next)).toEqual(["a", "c"]);
    expectTautGeometry(next, VP, "after remove");
  });

  it("keeps a column that still holds slots", () => {
    const layout: WorkspaceLayout = {
      columns: [
        makeColumn([
          { feedId: "a", w: 400, h: null },
          { feedId: "b", w: 400, h: null },
        ]),
      ],
    };
    const next = removeFeed(layout, "a");
    expect(next.columns).toHaveLength(1);
    expect(layoutFeedIds(next)).toEqual(["b"]);
  });

  it("leaves the layout untouched for an unknown feed", () => {
    const layout = layoutFromFeeds(["a"]);
    expect(removeFeed(layout, "zzz")).toBe(layout);
  });
});

describe("resizeSlot", () => {
  const stack: WorkspaceLayout = {
    columns: [
      makeColumn([
        { feedId: "a", w: 400, h: 300 },
        { feedId: "b", w: 400, h: 300 },
      ]),
    ],
  };

  it("lets width grow freely — the columns to the right just slide", () => {
    const next = resizeSlot(stack, "a", { w: 1200, h: 300 }, VP);
    const slot = next.columns[0].slots[0];
    expect(slot.w).toBe(1200);
    expect(deriveGeometry(next, VP).columns[0].w).toBe(1200);
  });

  it("clamps height at the stack remainder, not squeezing a fixed sibling", () => {
    const next = resizeSlot(stack, "a", { w: 400, h: 5000 }, VP);
    const h = next.columns[0].slots[0].h!;
    // Sibling keeps its 300, which renders at its grid-floored height; the
    // resized slot takes the largest lattice height that fits in what is left.
    const siblingH = 300 - (300 % GRID);
    const remainder = availableHeight(VP) - GRID - siblingH;
    expect(h).toBe(remainder - (remainder % GRID));
    expectTautGeometry(next, VP, "after resize");
  });

  it("compresses a null sibling to the minimum, no further", () => {
    const mixed: WorkspaceLayout = {
      columns: [
        makeColumn([
          { feedId: "a", w: 400, h: 300 },
          { feedId: "b", w: 400, h: null },
        ]),
      ],
    };
    const next = resizeSlot(mixed, "a", { w: 400, h: 5000 }, VP);
    const remainder = availableHeight(VP) - GRID - SLOT_MIN_H;
    expect(next.columns[0].slots[0].h).toBe(remainder - (remainder % GRID));
  });

  it("floors at the slot minimums and lands on the lattice", () => {
    const next = resizeSlot(stack, "a", { w: 10, h: 10 }, VP);
    const slot = next.columns[0].slots[0];
    expect(slot.w).toBeGreaterThanOrEqual(SLOT_MIN_W);
    expect(slot.h).toBeGreaterThanOrEqual(SLOT_MIN_H);
    expect(slot.w % GRID).toBe(0);
    expect(slot.h! % GRID).toBe(0);
  });

  // Regression: in regimented mode every column is a single `h: null` slot that
  // fills to availableHeight(vp). At an off-grid viewport height, a resized
  // (fixed-h) feed dragged to its max used to stop `H mod GRID` px short of a
  // null neighbour's bottom — impossible to line up on the grid. availableHeight
  // is now floored, so max fixed == null fill exactly.
  it("lets a resized feed line its bottom up with a null neighbour at an off-grid height", () => {
    // 903 - 16 (buffers) = 887, deliberately NOT a GRID multiple.
    const odd: Viewport = { w: 1440, h: 903 };
    const H = availableHeight(odd);
    expect(H % GRID).toBe(0); // the whole vertical axis is on the lattice

    const parade: WorkspaceLayout = {
      columns: [
        makeColumn([{ feedId: "a", w: FACTORY_W, h: null }]),
        makeColumn([{ feedId: "b", w: FACTORY_W, h: null }]),
      ],
    };
    // Drag "a" as tall as possible; it becomes a fixed-height slot.
    const resized = resizeSlot(parade, "a", { w: FACTORY_W, h: 100000 }, odd);
    const geom = deriveGeometry(resized, odd);
    const a = geom.rects.get("a")!;
    const b = geom.rects.get("b")!; // still null → fills the column
    expect(a.y + a.h).toBe(b.y + b.h); // bottoms line up to the pixel
  });
});

// =============================================================================
// Drop resolution (§IV.2)
// =============================================================================

describe("resolveDrop", () => {
  const three = layoutFromFeeds(["a", "b", "c"]);
  const vp: Viewport = { w: 900, h: 900};
  const geom = deriveGeometry(three, vp);
  const lifted = { feedId: "a", w: FACTORY_W, h: null as number | null };

  const centreOf = (id: string) => {
    const r = geom.rects.get(id)!;
    return { x: r.x + r.w / 2, y: r.y + r.h / 2 };
  };

  it("arms a merge in the central region of another feed", () => {
    expect(resolveDrop(three, geom, centreOf("b"), lifted)).toEqual({
      kind: "merge",
      targetFeedId: "b",
    });
  });

  it("resolves the outer band to insertion at the nearer column boundary", () => {
    const r = geom.rects.get("b")!;
    const left = resolveDrop(
      three,
      geom,
      { x: r.x + 4, y: r.y + r.h / 2 },
      lifted,
    );
    expect(left).toEqual({ kind: "new-column", boundaryIndex: 1 });
    const right = resolveDrop(
      three,
      geom,
      { x: r.x + r.w - 4, y: r.y + r.h / 2 },
      lifted,
    );
    expect(right).toEqual({ kind: "new-column", boundaryIndex: 2 });
  });

  it("resolves the top and bottom bands to stacking above and below", () => {
    const r = geom.rects.get("b")!;
    const above = resolveDrop(
      three,
      geom,
      { x: r.x + r.w / 2, y: r.y + 4 },
      lifted,
    );
    expect(above).toMatchObject({
      kind: "into-column",
      columnIndex: 1,
      slotIndex: 0,
    });
    const below = resolveDrop(
      three,
      geom,
      { x: r.x + r.w / 2, y: r.y + r.h - 4 },
      lifted,
    );
    expect(below).toMatchObject({
      kind: "into-column",
      columnIndex: 1,
      slotIndex: 1,
    });
  });

  it("keeps a central merge region at the smallest legal vessel", () => {
    // The bands never eat more than a third of the rect, so merge stays
    // reachable even on a slot at both minimums.
    const narrow: WorkspaceLayout = {
      columns: [
        makeColumn([{ feedId: "a", w: FACTORY_W, h: null }]),
        makeColumn([
          { feedId: "b", w: SLOT_MIN_W, h: SLOT_MIN_H },
          { feedId: "d", w: SLOT_MIN_W, h: null },
        ]),
      ],
    };
    expect(2 * EDGE_BAND).toBeLessThan(SLOT_MIN_W);
    const g = deriveGeometry(narrow, vp);
    const r = g.rects.get("b")!;
    expect(
      resolveDrop(narrow, g, { x: r.x + r.w / 2, y: r.y + r.h / 2 }, lifted),
    ).toEqual({ kind: "merge", targetFeedId: "b" });
  });

  it("never offers the lifted feed's own slot as a merge target", () => {
    expect(resolveDrop(three, geom, centreOf("a"), lifted)).toMatchObject({
      kind: "into-column",
      columnIndex: 0,
      slotIndex: 0,
    });
  });

  it("resolves a drop back into the held-open slot to a true no-op", () => {
    const drop = resolveDrop(three, geom, centreOf("a"), lifted);
    expect(applyDrop(three, "a", drop)).toEqual(three);
  });

  it("takes the vacated space as a gap in a shared column", () => {
    const stacked: WorkspaceLayout = {
      columns: [
        makeColumn([
          { feedId: "a", w: 400, h: null },
          { feedId: "b", w: 400, h: null },
        ]),
        makeColumn([{ feedId: "c", w: 400, h: null }]),
      ],
    };
    const g = deriveGeometry(stacked, vp);
    const own = g.rects.get("a")!;
    const drop = resolveDrop(
      stacked,
      g,
      { x: own.x + own.w / 2, y: own.y + own.h / 2 },
      { feedId: "a", w: 400, h: null },
    );
    expect(applyDrop(stacked, "a", drop)).toEqual(stacked);
  });

  it("inserts a new column when dropped in the gutter between two", () => {
    const c0 = geom.columns[0];
    const drop = resolveDrop(
      three,
      geom,
      { x: c0.x + c0.w + GRID / 2, y: 400 },
      lifted,
    );
    expect(drop).toEqual({ kind: "new-column", boundaryIndex: 1 });
  });

  it("inserts at the far end when dropped past the last column", () => {
    expect(
      resolveDrop(three, geom, { x: 100000, y: 400 }, lifted),
    ).toEqual({ kind: "new-column", boundaryIndex: 3 });
    expect(resolveDrop(three, geom, { x: -100000, y: 400 }, lifted)).toEqual({
      kind: "new-column",
      boundaryIndex: 0,
    });
  });

  it("auto-fits into a gap left by fixed heights below the last slot", () => {
    const shortStack: WorkspaceLayout = {
      columns: [
        makeColumn([{ feedId: "b", w: 400, h: 300 }]),
        makeColumn([{ feedId: "a", w: 400, h: null }]),
      ],
    };
    const g = deriveGeometry(shortStack, vp);
    const col0 = g.columns[0];
    const drop = resolveDrop(
      shortStack,
      g,
      { x: col0.x + col0.w / 2, y: GRID + availableHeight(vp) - 20 },
      { feedId: "a", w: 400, h: null },
    );
    expect(drop.kind).toBe("into-column");
    if (drop.kind !== "into-column") return;
    expect(drop.columnIndex).toBe(0);
    expect(drop.slotIndex).toBe(1);
    // The run below the fixed slot (which renders at its grid-floored height),
    // less the one buffer the insertion needs.
    const fixedH = 300 - (300 % GRID);
    expect(drop.h).toBe(availableHeight(vp) - fixedH - GRID);
  });

  it("resolves an empty layout to the first column", () => {
    expect(
      resolveDrop({ columns: [] }, deriveGeometry({ columns: [] }, vp), { x: 5, y: 5 }, lifted),
    ).toEqual({ kind: "new-column", boundaryIndex: 0 });
  });

  it("gates the vertical bands on stack capacity — a full column takes no new slot", () => {
    // H = 700 − 16 = 684: three min-height slots (616) fit, a fourth (824)
    // would overflow below the nav row, where the floor cannot scroll.
    const short: Viewport = { w: 1440, h: 700};
    const full: WorkspaceLayout = {
      columns: [
        makeColumn([
          { feedId: "s1", w: 400, h: null },
          { feedId: "s2", w: 400, h: null },
          { feedId: "s3", w: 400, h: null },
        ]),
        makeColumn([{ feedId: "x", w: 400, h: null }]),
      ],
    };
    const g = deriveGeometry(full, short);
    const top = g.rects.get("s1")!;
    // Cross-column drop into the top band: must NOT resolve into-column.
    const drop = resolveDrop(
      full,
      g,
      { x: top.x + top.w / 2, y: top.y + 4 },
      { feedId: "x", w: 400, h: null },
    );
    expect(drop.kind).not.toBe("into-column");
    // …and applying whatever it resolved to keeps every column within
    // capacity.
    if (drop.kind !== "merge") {
      const next = applyDrop(full, "x", drop);
      const H = availableHeight(short);
      for (const col of next.columns) {
        const n = col.slots.length;
        expect(n * SLOT_MIN_H + (n - 1) * GRID).toBeLessThanOrEqual(H);
      }
    }
  });

  it("still offers the band insertion when the stack has room", () => {
    const tall: Viewport = { w: 1440, h: 900}; // H = 884 ≥ 824
    const stack: WorkspaceLayout = {
      columns: [
        makeColumn([
          { feedId: "s1", w: 400, h: null },
          { feedId: "s2", w: 400, h: null },
          { feedId: "s3", w: 400, h: null },
        ]),
        makeColumn([{ feedId: "x", w: 400, h: null }]),
      ],
    };
    const g = deriveGeometry(stack, tall);
    const top = g.rects.get("s1")!;
    expect(
      resolveDrop(
        stack,
        g,
        { x: top.x + top.w / 2, y: top.y + 4 },
        { feedId: "x", w: 400, h: null },
      ),
    ).toMatchObject({ kind: "into-column", columnIndex: 0, slotIndex: 0 });
  });

  it("lets a full column reorder within itself — the count does not change", () => {
    const short: Viewport = { w: 1440, h: 700};
    const full: WorkspaceLayout = {
      columns: [
        makeColumn([
          { feedId: "s1", w: 400, h: null },
          { feedId: "s2", w: 400, h: null },
          { feedId: "s3", w: 400, h: null },
        ]),
      ],
    };
    const g = deriveGeometry(full, short);
    const top = g.rects.get("s1")!;
    // s3 dropped on s1's top band: a move within its own column, allowed even
    // though the column is at capacity.
    expect(
      resolveDrop(
        full,
        g,
        { x: top.x + top.w / 2, y: top.y + 4 },
        { feedId: "s3", w: 400, h: null },
      ),
    ).toMatchObject({ kind: "into-column", columnIndex: 0, slotIndex: 0 });
  });

  it("does not arm a merge from the empty band beside a narrower slot", () => {
    // Column width follows the widest slot (640); the narrow slot leaves a
    // visually empty band to its right, which must not read as "over it".
    const mixed: WorkspaceLayout = {
      columns: [
        makeColumn([
          { feedId: "wide", w: 640, h: 300 },
          { feedId: "narrow", w: SLOT_MIN_W, h: 300 },
        ]),
        makeColumn([{ feedId: "x", w: 400, h: null }]),
      ],
    };
    const g = deriveGeometry(mixed, vp);
    const narrow = g.rects.get("narrow")!;
    const drop = resolveDrop(
      mixed,
      g,
      // Right of the narrow slot's rect, inside the column's span, level with
      // the slot's centre.
      { x: narrow.x + narrow.w + 100, y: narrow.y + narrow.h / 2 },
      { feedId: "x", w: 400, h: null },
    );
    expect(drop.kind).not.toBe("merge");
    // Dead centre of the narrow slot itself still arms as before.
    expect(
      resolveDrop(
        mixed,
        g,
        { x: narrow.x + narrow.w / 2, y: narrow.y + narrow.h / 2 },
        { feedId: "x", w: 400, h: null },
      ),
    ).toEqual({ kind: "merge", targetFeedId: "narrow" });
  });
});

// =============================================================================
// dropIsNoop (§V's no-op guard)
// =============================================================================

describe("dropIsNoop", () => {
  const vp: Viewport = { w: 900, h: 900};

  it("is true for a drop back into the held-open slot", () => {
    const three = layoutFromFeeds(["a", "b", "c"]);
    const geom = deriveGeometry(three, vp);
    const r = geom.rects.get("a")!;
    const drop = resolveDrop(
      three,
      geom,
      { x: r.x + r.w / 2, y: r.y + r.h / 2 },
      { feedId: "a", w: FACTORY_W, h: null },
    );
    expect(dropIsNoop(three, "a", drop)).toBe(true);
  });

  it("is true for a band insertion that lands identically beside the vacated slot", () => {
    const stacked: WorkspaceLayout = {
      columns: [
        makeColumn([
          { feedId: "a", w: 400, h: null },
          { feedId: "b", w: 400, h: null },
        ]),
      ],
    };
    // "Above b" in the pre-removal layout is exactly where a already sits.
    expect(
      dropIsNoop(stacked, "a", {
        kind: "into-column",
        columnIndex: 0,
        slotIndex: 1,
        h: null,
      }),
    ).toBe(true);
  });

  it("is true for a sole slot re-created as its own column at its own boundary", () => {
    const two = layoutFromFeeds(["a", "b"]);
    expect(
      dropIsNoop(two, "a", { kind: "new-column", boundaryIndex: 0 }),
    ).toBe(true);
    // …but not at the FAR boundary, which reorders the columns.
    expect(
      dropIsNoop(two, "a", { kind: "new-column", boundaryIndex: 2 }),
    ).toBe(false);
  });

  it("is false for a real move, a resize-by-drop, and a merge", () => {
    const two = layoutFromFeeds(["a", "b"]);
    expect(
      dropIsNoop(two, "a", {
        kind: "into-column",
        columnIndex: 1,
        slotIndex: 0,
        h: null,
      }),
    ).toBe(false);
    // Same position but a different committed height is a change.
    const stacked: WorkspaceLayout = {
      columns: [
        makeColumn([
          { feedId: "a", w: 400, h: 300 },
          { feedId: "b", w: 400, h: null },
        ]),
      ],
    };
    expect(
      dropIsNoop(stacked, "a", {
        kind: "into-column",
        columnIndex: 0,
        slotIndex: 0,
        h: 400,
      }),
    ).toBe(false);
    expect(dropIsNoop(two, "a", { kind: "merge", targetFeedId: "b" })).toBe(
      false,
    );
  });
});

// =============================================================================
// locateSlot / restoreSlot (the hide-revert pair)
// =============================================================================

describe("locateSlot / restoreSlot", () => {
  it("puts a removed slot back at its column and index", () => {
    const stacked: WorkspaceLayout = {
      columns: [
        makeColumn([
          { feedId: "a", w: 400, h: 300 },
          { feedId: "b", w: 320, h: null },
          { feedId: "c", w: 400, h: null },
        ]),
      ],
    };
    const at = locateSlot(stacked, "b")!;
    const removed = removeFeed(stacked, "b");
    expect(restoreSlot(removed, at)).toEqual(stacked);
  });

  it("re-creates a pruned column at its old position", () => {
    const three = layoutFromFeeds(["a", "b", "c"]);
    const at = locateSlot(three, "b")!;
    const removed = removeFeed(three, "b");
    expect(removed.columns).toHaveLength(2);
    const restored = restoreSlot(removed, at);
    expect(layoutFeedIds(restored)).toEqual(["a", "b", "c"]);
    expect(restored.columns[1].id).toBe(at.columnId);
    expect(restored.columns[1].slots[0]).toEqual(at.slot);
  });

  it("leaves the layout alone when the feed is already placed again", () => {
    const three = layoutFromFeeds(["a", "b", "c"]);
    const at = locateSlot(three, "b")!;
    // The feed came back some other way (unhide) before the revert landed.
    expect(restoreSlot(three, at)).toBe(three);
  });

  it("returns null for a feed with no slot", () => {
    expect(locateSlot(layoutFromFeeds(["a"]), "zzz")).toBeNull();
  });
});

// =============================================================================
// applyDrop (§IV.2 index contract)
// =============================================================================

describe("applyDrop", () => {
  it("is a no-op for a merge — the caller owns the server flow", () => {
    const layout = layoutFromFeeds(["a", "b"]);
    expect(applyDrop(layout, "a", { kind: "merge", targetFeedId: "b" })).toBe(
      layout,
    );
  });

  it("moves a feed into another column, adjusting for the emptied one", () => {
    const layout = layoutFromFeeds(["a", "b"]);
    // Indices address the layout WITH a's slot still in place (§IV.1).
    const next = applyDrop(layout, "a", {
      kind: "into-column",
      columnIndex: 1,
      slotIndex: 0,
      h: 300,
    });
    expect(next.columns).toHaveLength(1);
    expect(next.columns[0].slots.map((s) => s.feedId)).toEqual(["a", "b"]);
    expect(next.columns[0].slots[0].h).toBe(300);
    expectLegalLayout(next);
  });

  it("reorders within a column without an off-by-one", () => {
    const layout: WorkspaceLayout = {
      columns: [
        makeColumn([
          { feedId: "a", w: 400, h: null },
          { feedId: "b", w: 400, h: null },
          { feedId: "c", w: 400, h: null },
        ]),
      ],
    };
    // "below c" addresses slot index 3 in the pre-removal layout.
    const next = applyDrop(layout, "a", {
      kind: "into-column",
      columnIndex: 0,
      slotIndex: 3,
      h: null,
    });
    expect(next.columns[0].slots.map((s) => s.feedId)).toEqual(["b", "c", "a"]);
  });

  it("re-creates the column when the lift emptied the very one targeted", () => {
    const layout = layoutFromFeeds(["a", "b"]);
    const next = applyDrop(layout, "a", {
      kind: "into-column",
      columnIndex: 0,
      slotIndex: 0,
      h: null,
    });
    expect(layoutFeedIds(next).sort()).toEqual(["a", "b"]);
    expectLegalLayout(next);
  });

  it("splits a stack out into a new column at the requested boundary", () => {
    const layout: WorkspaceLayout = {
      columns: [
        makeColumn([
          { feedId: "a", w: 400, h: null },
          { feedId: "b", w: 400, h: null },
        ]),
      ],
    };
    const next = applyDrop(layout, "a", {
      kind: "new-column",
      boundaryIndex: 1,
    });
    expect(next.columns).toHaveLength(2);
    expect(layoutFeedIds(next)).toEqual(["b", "a"]);
    expectTautGeometry(next, VP, "after split");
  });

  it("carries the dragged size into a new column", () => {
    const layout: WorkspaceLayout = {
      columns: [
        makeColumn([{ feedId: "a", w: 720, h: 480 }]),
        makeColumn([{ feedId: "b", w: 400, h: null }]),
      ],
    };
    const next = applyDrop(layout, "a", {
      kind: "new-column",
      boundaryIndex: 2,
    });
    expect(next.columns[1].slots[0]).toEqual({ feedId: "a", w: 720, h: 480 });
  });

  it("leaves the layout untouched for an unknown feed", () => {
    const layout = layoutFromFeeds(["a"]);
    expect(
      applyDrop(layout, "zzz", { kind: "new-column", boundaryIndex: 0 }),
    ).toBe(layout);
  });
});

// =============================================================================
// Regimented mode (§V)
// =============================================================================

describe("regimentedLayout", () => {
  it("puts every visible feed in its own column, numeral order", () => {
    const layout = regimentedLayout(
      [
        { id: "c", sortRank: 3 },
        { id: "a", sortRank: 1 },
        { id: "b", sortRank: 2 },
      ],
      VP,
    );
    expect(layoutFeedIds(layout)).toEqual(["a", "b", "c"]);
    expect(layout.columns).toHaveLength(3);
  });

  it("uses factory width when the feeds already fit", () => {
    const layout = regimentedLayout([{ id: "a", sortRank: 1 }], VP);
    expect(layout.columns[0].slots[0].w).toBe(FACTORY_W);
  });

  it("scales widths down uniformly so n feeds fit on screen", () => {
    // On the 1440px viewport, 3 feeds still scale down (below factory) yet fit
    // above REGIMENTED_MIN_W, so the floor stays exactly one viewport wide.
    const feeds = Array.from({ length: 3 }, (_, i) => ({
      id: `f${i}`,
      sortRank: i,
    }));
    const layout = regimentedLayout(feeds, VP);
    const w = layout.columns[0].slots[0].w;
    expect(w).toBeLessThan(FACTORY_W);
    expect(w).toBeGreaterThan(REGIMENTED_MIN_W);
    expect(new Set(layout.columns.map((c) => c.slots[0].w)).size).toBe(1);
    expect(deriveGeometry(layout, VP).floorWidth).toBe(VP.w);
  });

  it("admits horizontal scroll rather than render below the minimum width", () => {
    // Enough feeds that even REGIMENTED_MIN_W overflows the viewport — the parade
    // holds the readable minimum and scrolls instead of cramming narrower.
    const feeds = Array.from({ length: 12 }, (_, i) => ({
      id: `f${i}`,
      sortRank: i,
    }));
    const layout = regimentedLayout(feeds, VP);
    expect(layout.columns[0].slots[0].w).toBe(REGIMENTED_MIN_W);
    expect(deriveGeometry(layout, VP).floorWidth).toBeGreaterThan(VP.w);
  });

  it("handles no feeds", () => {
    expect(regimentedLayout([], VP).columns).toHaveLength(0);
  });
});

// =============================================================================
// Properties — the universal claims
// =============================================================================

describe("layout properties", () => {
  // Deterministic PRNG (mulberry32) — reproducible failures, no flakes.
  function prng(seed: number) {
    let s = seed;
    return () => {
      s = (s + 0x6d2b79f5) | 0;
      let t = Math.imul(s ^ (s >>> 15), 1 | s);
      t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
  }

  function randomLayout(rand: () => number, n: number): WorkspaceLayout {
    const pick = (lo: number, hi: number) => lo + Math.floor(rand() * (hi - lo));
    const columns = [];
    let next = 0;
    while (next < n) {
      const take = Math.min(n - next, pick(1, 4));
      const slots = [];
      for (let i = 0; i < take; i++) {
        slots.push({
          feedId: `f${next++}`,
          // Widths run to resize scale: a corpus that stops where legal
          // gestures keep going proves nothing about them.
          w: pick(SLOT_MIN_W, 1800),
          h: rand() < 0.4 ? null : pick(SLOT_MIN_H, 900),
        });
      }
      columns.push(makeColumn(slots));
    }
    return { columns };
  }

  it("derives a taut, non-overlapping floor for any layout and viewport", () => {
    const rand = prng(0x9e3779b9);
    const pick = (lo: number, hi: number) => lo + Math.floor(rand() * (hi - lo));
    for (let trial = 0; trial < 2000; trial++) {
      const layout = randomLayout(rand, pick(1, 9));
      const vp: Viewport = {
        w: pick(320, 2400),
        h: pick(400, 1600),
      };
      const geom = expectTautGeometry(layout, vp, `trial ${trial}`);
      const last = geom.columns[geom.columns.length - 1];
      const content = last.x - geom.offsetX + last.w + GRID;
      expect(geom.floorWidth, `trial ${trial}: extent`).toBe(
        Math.max(vp.w, content),
      );
    }
  });

  it("keeps every rect inside the available height whenever the stack can fit", () => {
    const rand = prng(0x1234567);
    const pick = (lo: number, hi: number) => lo + Math.floor(rand() * (hi - lo));
    for (let trial = 0; trial < 1500; trial++) {
      const layout = randomLayout(rand, pick(1, 9));
      const vp: Viewport = { w: pick(320, 2400), h: pick(400, 1600)};
      const H = availableHeight(vp);
      const geom = deriveGeometry(layout, vp);
      for (const col of layout.columns) {
        const n = col.slots.length;
        // Below this the column cannot render usefully at all and is allowed
        // to overflow rather than silently drop feeds (columnHeights' doc).
        if (n * SLOT_MIN_H + (n - 1) * GRID > H) continue;
        for (const slot of col.slots) {
          const r = geom.rects.get(slot.feedId)!;
          expect(r.y, `trial ${trial}`).toBeGreaterThanOrEqual(GRID);
          expect(r.y + r.h, `trial ${trial}`).toBeLessThanOrEqual(GRID + H);
        }
      }
    }
  });

  it("resolves every pointer position to a drop whose application is legal", () => {
    const rand = prng(0xabcdef);
    const pick = (lo: number, hi: number) => lo + Math.floor(rand() * (hi - lo));
    for (let trial = 0; trial < 3000; trial++) {
      const n = pick(1, 8);
      const layout = randomLayout(rand, n);
      const vp: Viewport = { w: pick(320, 2400), h: pick(500, 1400)};
      const geom = deriveGeometry(layout, vp);
      const liftedId = `f${pick(0, n)}`;
      const liftedSlot = layout.columns
        .flatMap((c) => c.slots)
        .find((s) => s.feedId === liftedId)!;
      // Sample well beyond the floor on both axes: a drag may end anywhere.
      const pointer = {
        x: pick(-400, geom.floorWidth + 400),
        y: pick(-200, vp.h + 200),
      };
      const drop: Drop = resolveDrop(layout, geom, pointer, {
        feedId: liftedId,
        w: liftedSlot.w,
        h: liftedSlot.h,
      });
      const label = `trial ${trial} (${liftedId} @ ${pointer.x},${pointer.y})`;

      if (drop.kind === "merge") {
        expect(drop.targetFeedId, `${label}: self-merge`).not.toBe(liftedId);
        continue;
      }
      const next = applyDrop(layout, liftedId, drop);
      expectLegalLayout(next, label);
      expect(layoutFeedIds(next).sort(), `${label}: feed lost`).toEqual(
        layoutFeedIds(layout).sort(),
      );
      expectTautGeometry(next, vp, label);
    }
  });

  it("stays legal and taut across long random gesture sequences", () => {
    const rand = prng(0x5eed);
    const pick = (lo: number, hi: number) => lo + Math.floor(rand() * (hi - lo));
    for (let trial = 0; trial < 300; trial++) {
      const vp: Viewport = { w: pick(600, 2000), h: pick(600, 1200)};
      let layout = layoutFromFeeds(
        Array.from({ length: pick(1, 6) }, (_, i) => `f${i}`),
      );
      let nextId = layout.columns.length;

      for (let step = 0; step < 20; step++) {
        const ids = layoutFeedIds(layout);
        const roll = rand();
        if (roll < 0.12) {
          layout = insertFeed(layout, `f${nextId++}`);
        } else if (roll < 0.22 && ids.length > 1) {
          layout = removeFeed(layout, ids[pick(0, ids.length)]);
        } else if (roll < 0.4) {
          layout = resizeSlot(
            layout,
            ids[pick(0, ids.length)],
            { w: pick(100, 2600), h: pick(100, 2600) },
            vp,
          );
        } else {
          const geom = deriveGeometry(layout, vp);
          const liftedId = ids[pick(0, ids.length)];
          const slot = layout.columns
            .flatMap((c) => c.slots)
            .find((s) => s.feedId === liftedId)!;
          const drop = resolveDrop(
            layout,
            geom,
            { x: pick(-200, geom.floorWidth + 200), y: pick(-100, vp.h + 100) },
            { feedId: liftedId, w: slot.w, h: slot.h },
          );
          // A merge is a server round-trip; its layout effect is the source
          // feed leaving (§IV.4).
          layout =
            drop.kind === "merge"
              ? removeFeed(layout, liftedId)
              : applyDrop(layout, liftedId, drop);
        }
        const label = `trial ${trial} step ${step}`;
        expectLegalLayout(layout, label);
        expectTautGeometry(layout, vp, label);
        // No gesture may stack a column past what the viewport can hold
        // (2026-07-22 audit fix): starting from single-slot columns, band
        // insertions are capacity-gated and gap insertions prove their run,
        // so every column always fits its slots at minimum height.
        for (const col of layout.columns) {
          const n = col.slots.length;
          expect(
            n * SLOT_MIN_H + (n - 1) * GRID,
            `${label}: column over capacity`,
          ).toBeLessThanOrEqual(availableHeight(vp));
        }
      }
    }
  });
});
