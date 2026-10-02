import { describe, it, expect } from "vitest";
import { queueGeometry } from "./queueGeometry";
import { deriveGeometry, FACTORY_W, REGIMENTED_MIN_W } from "./layout";
import { GRID } from "./grid";

// WORKSPACE-QUEUE-ADR §VII.1. The worked figures are the ADR's own; the rest
// are properties every viewport must hold.

describe("queueGeometry", () => {
  it("matches §VII.1's worked widths", () => {
    expect(queueGeometry({ w: 1280, h: 752 }).focalW).toBe(584);
    expect(queueGeometry({ w: 1440, h: 852 }).focalW).toBe(640);
  });

  it("clamps the focal width to the floor's band, and the compact to 0.48 of it", () => {
    const narrow = queueGeometry({ w: 600, h: 700 });
    expect(narrow.focalW).toBe(REGIMENTED_MIN_W);
    expect(narrow.compactW).toBe(192);
    const wide = queueGeometry({ w: 4000, h: 700 });
    expect(wide.focalW).toBe(FACTORY_W);
    expect(wide.compactW).toBe(304);
  });

  it("stands an entry as tall as a single null slot on the floor", () => {
    for (const h of [500, 752, 801, 999]) {
      const vp = { w: 1280, h };
      const floor = deriveGeometry(
        { columns: [{ id: "c", slots: [{ feedId: "f", w: FACTORY_W, h: null }] }] },
        vp,
      );
      expect(queueGeometry(vp).entryH).toBe(floor.rects.get("f")!.h);
    }
  });

  it("keeps every width on the lattice and in order, at every viewport", () => {
    for (let w = 320; w <= 3000; w += 37) {
      const g = queueGeometry({ w, h: 800 });
      for (const v of [g.focalW, g.compactW, g.lineW, g.gap, g.entryH])
        expect(v % GRID).toBe(0);
      expect(g.focalW).toBeGreaterThanOrEqual(REGIMENTED_MIN_W);
      expect(g.focalW).toBeLessThanOrEqual(FACTORY_W);
      expect(g.lineW).toBeLessThan(g.compactW);
      expect(g.compactW).toBeLessThan(g.focalW);
      expect(g.previewListW).toBeGreaterThan(0);
      expect(g.fullListW).toBeGreaterThan(g.previewListW);
    }
  });
});
