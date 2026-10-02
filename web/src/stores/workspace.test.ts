import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { useWorkspace } from "./workspace";
import {
  deriveGeometry,
  layoutFeedIds,
  locateSlot,
  FACTORY_W,
  type Viewport,
} from "../lib/workspace/layout";

// The store reads `typeof window` at CALL time, so a plain stub on globalThis
// is enough — no jsdom environment needed.
const store = new Map<string, string>();
const localStorage = {
  getItem: (k: string) => store.get(k) ?? null,
  setItem: (k: string, v: string) => void store.set(k, v),
  removeItem: (k: string) => void store.delete(k),
};

const V2 = (u: string) => `workspace:layout:v2:${u}`;
const V1 = (u: string) => `workspace:layout:${u}`;

const VP: Viewport = { w: 1400, h: 900};

/** Drop the in-memory store WITHOUT touching localStorage — the way a reload
 *  does, so a round-trip test actually reads what was persisted. */
function resetState() {
  useWorkspace.setState({
    userId: null,
    layout: { columns: [] },
    appearance: {},
    regimented: false,
    hydrated: false,
  });
}

function reset() {
  store.clear();
  resetState();
}

beforeEach(() => {
  vi.useFakeTimers();
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  (globalThis as any).window = { localStorage };
  reset();
});

afterEach(() => {
  vi.useRealTimers();
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  delete (globalThis as any).window;
});

/** The store writes debounced 200ms. */
function flushWrites() {
  vi.advanceTimersByTime(250);
}

function persisted(userId: string) {
  const raw = store.get(V2(userId));
  return raw ? JSON.parse(raw) : null;
}

describe("v1 migration (ADR §VIII)", () => {
  it("discards coordinates and carries every appearance field across", () => {
    store.set(
      V1("u"),
      JSON.stringify({
        // 5c-era: coordinates + the full appearance set.
        a: {
          x: 900,
          y: 240,
          w: 420,
          h: 700,
          brightness: "spring",
          density: "compact",
          orientation: "horizontal",
          textSize: 4,
        },
        // 5b-era: coordinates only.
        b: { x: 40, y: 40, w: 300, h: 600 },
        // 5a-era: position only.
        c: { x: 0, y: 0 },
      }),
    );

    useWorkspace.getState().hydrate("u");
    const s = useWorkspace.getState();

    // Coordinates are gone: nothing is placed until reconcileFeeds runs.
    expect(s.layout.columns).toEqual([]);
    expect(s.appearance).toEqual({
      a: {
        brightness: "spring",
        density: "compact",
        orientation: "horizontal",
        textSize: 4,
      },
    });
    // The v1 key is retired in the same pass, and v2 is written SYNCHRONOUSLY
    // so the deletion can never outrun the debounce.
    expect(store.get(V1("u"))).toBeUndefined();
    expect(persisted("u").appearance.a.textSize).toBe(4);
  });

  it("retires renamed scheme and density values on the way across", () => {
    store.set(
      V1("u"),
      JSON.stringify({
        a: { x: 0, y: 0, brightness: "primary", density: "full" },
      }),
    );
    useWorkspace.getState().hydrate("u");
    const look = useWorkspace.getState().appearance.a;
    expect(look.brightness).toBe("basic");
    expect(look.density).toBe("standard");
  });

  it("leaves v1 alone once a v2 layout exists", () => {
    store.set(V2("u"), JSON.stringify({ columns: [], appearance: {} }));
    store.set(V1("u"), JSON.stringify({ a: { x: 0, y: 0, textSize: 5 } }));
    useWorkspace.getState().hydrate("u");
    expect(useWorkspace.getState().appearance).toEqual({});
    expect(store.get(V1("u"))).toBeDefined();
  });

  it("survives a corrupt blob on either key", () => {
    store.set(V2("u"), "{not json");
    expect(() => useWorkspace.getState().hydrate("u")).not.toThrow();
    expect(useWorkspace.getState().layout.columns).toEqual([]);

    reset();
    store.set(V1("u2"), JSON.stringify([1, 2, 3]));
    expect(() => useWorkspace.getState().hydrate("u2")).not.toThrow();
    expect(useWorkspace.getState().appearance).toEqual({});
  });
});

describe("persistence", () => {
  it("round-trips a layout and its appearance through the v2 key", () => {
    useWorkspace.getState().hydrate("u");
    useWorkspace.getState().insertFeed("a");
    useWorkspace.getState().insertFeed("b");
    useWorkspace.getState().setVesselTextSize("a", 5);
    useWorkspace.getState().resizeSlot("b", { w: 400, h: 320 }, VP);
    flushWrites();

    resetState();
    useWorkspace.getState().hydrate("u");
    const s = useWorkspace.getState();
    expect(layoutFeedIds(s.layout)).toEqual(["a", "b"]);
    expect(s.appearance.a?.textSize).toBe(5);
    const b = s.layout.columns[1].slots[0];
    expect(b.w).toBe(400);
    expect(b.h).toBe(320);
  });

  it("drops a duplicate slot on read — one feed can only be in one place", () => {
    store.set(
      V2("u"),
      JSON.stringify({
        columns: [
          { id: "c1", slots: [{ feedId: "a", w: 640, h: null }] },
          { id: "c2", slots: [{ feedId: "a", w: 640, h: null }] },
        ],
        appearance: {},
      }),
    );
    useWorkspace.getState().hydrate("u");
    expect(layoutFeedIds(useWorkspace.getState().layout)).toEqual(["a"]);
  });

  it("defaults a slot with no usable width to factory width", () => {
    store.set(
      V2("u"),
      JSON.stringify({
        columns: [{ id: "c1", slots: [{ feedId: "a" }] }],
        appearance: {},
      }),
    );
    useWorkspace.getState().hydrate("u");
    const slot = useWorkspace.getState().layout.columns[0].slots[0];
    expect(slot.w).toBe(FACTORY_W);
    expect(slot.h).toBeNull();
  });
});

describe("reconcileFeeds", () => {
  it("places every visible feed from nothing — the first-run path (§III.4)", () => {
    useWorkspace.getState().hydrate("u");
    useWorkspace.getState().reconcileFeeds(["a", "b", "c"], ["a", "b", "c"]);
    const { layout } = useWorkspace.getState();
    // One column per seeded starter feed, list order, factory size.
    expect(layout.columns).toHaveLength(3);
    expect(layoutFeedIds(layout)).toEqual(["a", "b", "c"]);
    expect(layout.columns.every((c) => c.slots[0].w === FACTORY_W)).toBe(true);
  });

  it("prunes ghosts and hidden feeds, and keeps a hidden feed's character", () => {
    useWorkspace.getState().hydrate("u");
    useWorkspace.getState().reconcileFeeds(["a", "b", "c"], ["a", "b", "c"]);
    useWorkspace.getState().setVesselBrightness("b", "winter");
    useWorkspace.getState().setVesselBrightness("c", "autumn");

    // b hidden on another device, c deleted outright.
    useWorkspace.getState().reconcileFeeds(["a", "b"], ["a"]);
    const s = useWorkspace.getState();
    expect(layoutFeedIds(s.layout)).toEqual(["a"]);
    // Hidden keeps its character for when it comes back; deleted does not.
    expect(s.appearance.b?.brightness).toBe("winter");
    expect(s.appearance.c).toBeUndefined();
  });

  it("is a no-op when nothing changed", () => {
    useWorkspace.getState().hydrate("u");
    useWorkspace.getState().reconcileFeeds(["a", "b"], ["a", "b"]);
    const before = useWorkspace.getState().layout;
    useWorkspace.getState().reconcileFeeds(["a", "b"], ["a", "b"]);
    expect(useWorkspace.getState().layout).toBe(before);
  });

  it("appends a newly-visible feed without disturbing the arrangement", () => {
    useWorkspace.getState().hydrate("u");
    useWorkspace.getState().reconcileFeeds(["a", "b"], ["a", "b"]);
    const firstColumnId = useWorkspace.getState().layout.columns[0].id;
    useWorkspace.getState().reconcileFeeds(["a", "b", "n"], ["a", "b", "n"]);
    const { layout } = useWorkspace.getState();
    expect(layoutFeedIds(layout)).toEqual(["a", "b", "n"]);
    expect(layout.columns[0].id).toBe(firstColumnId);
  });
});

describe("mutations delegate to the layout module", () => {
  it("hide then unhide re-enters at the right end (§IV.5)", () => {
    useWorkspace.getState().hydrate("u");
    useWorkspace.getState().reconcileFeeds(["a", "b", "c"], ["a", "b", "c"]);
    useWorkspace.getState().removeFeed("a");
    expect(layoutFeedIds(useWorkspace.getState().layout)).toEqual(["b", "c"]);
    useWorkspace.getState().insertFeed("a");
    expect(layoutFeedIds(useWorkspace.getState().layout)).toEqual([
      "b",
      "c",
      "a",
    ]);
  });

  it("a drop into another column recomputes to a taut, legal floor", () => {
    useWorkspace.getState().hydrate("u");
    useWorkspace.getState().reconcileFeeds(["a", "b"], ["a", "b"]);
    useWorkspace
      .getState()
      .applyDrop("b", { kind: "into-column", columnIndex: 0, slotIndex: 0, h: 300 });
    const { layout } = useWorkspace.getState();
    expect(layout.columns).toHaveLength(1);
    expect(layout.columns[0].slots.map((s) => s.feedId)).toEqual(["b", "a"]);

    // The geometry that falls out is legal: no overlap, exact gutters.
    const geom = deriveGeometry(layout, VP);
    const a = geom.rects.get("a")!;
    const b = geom.rects.get("b")!;
    expect(b.y + b.h + 8).toBe(a.y);
  });

  it("resize clamps height to the stack remainder, not the viewport", () => {
    useWorkspace.getState().hydrate("u");
    useWorkspace.getState().reconcileFeeds(["a", "b"], ["a", "b"]);
    useWorkspace
      .getState()
      .applyDrop("b", { kind: "into-column", columnIndex: 0, slotIndex: 1, h: 300 });
    // One column, two slots: `a` cannot take the whole run.
    useWorkspace.getState().resizeSlot("a", { w: 640, h: 5000 }, VP);
    const col = useWorkspace.getState().layout.columns[0];
    const total = col.slots.reduce((n, s) => n + (s.h ?? 0), 0);
    expect(total + 8).toBeLessThanOrEqual(VP.h - 16);
  });

  it("restoreSlot reverts a failed hide to the captured column and index", () => {
    useWorkspace.getState().hydrate("u");
    useWorkspace.getState().reconcileFeeds(["a", "b", "c"], ["a", "b", "c"]);
    const before = useWorkspace.getState().layout;
    const at = locateSlot(before, "b")!;
    useWorkspace.getState().removeFeed("b");
    expect(layoutFeedIds(useWorkspace.getState().layout)).toEqual(["a", "c"]);
    useWorkspace.getState().restoreSlot(at);
    expect(useWorkspace.getState().layout).toEqual(before);
    flushWrites();
    expect(layoutFeedIds(persisted("u"))).toEqual(["a", "b", "c"]);
  });

  it("regimented is a view: materialize stamps it and leaves the mode", () => {
    useWorkspace.getState().hydrate("u");
    useWorkspace.getState().reconcileFeeds(["a", "b"], ["a", "b"]);
    useWorkspace.getState().setRegimented(true);
    expect(useWorkspace.getState().regimented).toBe(true);
    expect(store.get("workspace:regimented:u")).toBe("true");

    useWorkspace.getState().materializeRegimented(
      [
        { id: "b", sortRank: 1 },
        { id: "a", sortRank: 2 },
      ],
      VP,
    );
    const s = useWorkspace.getState();
    expect(s.regimented).toBe(false);
    expect(layoutFeedIds(s.layout)).toEqual(["b", "a"]);
  });

  it("hydrate clears the retired mode and parade keys, and keeps the layout key", () => {
    // C2 (WORKSPACE-QUEUE-ADR §XI): the desktop workspace is the queue, so the
    // mode switch and the parade ground are gone. Their per-device keys are
    // removed; the layout key is NOT, because its appearance half carries the
    // local-only text size the queue still reads.
    store.set("workspace:mode:u", "columns");
    store.set("workspace:regimented:u", "true");
    store.set(
      V2("u"),
      JSON.stringify({ columns: [], appearance: { a: { textSize: 4 } } }),
    );
    useWorkspace.getState().hydrate("u");
    expect(store.has("workspace:mode:u")).toBe(false);
    expect(store.has("workspace:regimented:u")).toBe(false);
    expect(useWorkspace.getState().regimented).toBe(false);
    expect(useWorkspace.getState().appearance.a?.textSize).toBe(4);
    expect(store.has(V2("u"))).toBe(true);
  });
});
