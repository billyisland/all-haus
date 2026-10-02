import { describe, it, expect } from "vitest";
import { entryMotion } from "./queueMotion";
import { queueGeometry } from "./queueGeometry";

// WORKSPACE-QUEUE-ADR §VII.6. The property that matters is the seam: a
// commit swaps every entry's place and resets `u` to 0 in one frame, so the
// state at `u = ±1` must BE the next resting state, entry by entry.

const g = queueGeometry({ w: 1280, h: 752 });
const US = [-1, -0.75, -0.5, -0.31, -0.1, 0, 0.1, 0.31, 0.5, 0.75, 1];
const DS = [-3, -2, -1, 0, 1, 2, 3];

describe("entryMotion", () => {
  it("rests where the queue at rest stands", () => {
    const at = (d: number) => {
      const m = entryMotion(d, g);
      return [m.width(0), m.list(0), m.bar(0), m.preview(0)];
    };
    expect(at(0)).toEqual([g.focalW, 1, 1, 0]);
    expect(at(1)).toEqual([g.compactW, 0, 1, 1]);
    expect(at(2)).toEqual([g.compactW, 0, 1, 1]);
    expect(at(-1)[0]).toBe(g.lineW);
    expect(at(-2)[0]).toBe(g.lineW);
  });

  it("arrives forward exactly where the next rest begins", () => {
    for (const d of DS) {
      const a = entryMotion(d, g);
      const b = entryMotion(d - 1, g);
      expect(a.width(1)).toBe(b.width(0));
      // A line's list and bar are clipped to nothing, so only a visible
      // entry's opacities have to agree.
      if (d - 1 >= 0) {
        expect(a.list(1)).toBe(b.list(0));
        expect(a.bar(1)).toBe(b.bar(0));
        expect(a.preview(1)).toBe(b.preview(0));
      }
    }
  });

  it("arrives back exactly where the next rest begins", () => {
    for (const d of DS) {
      const a = entryMotion(d, g);
      const b = entryMotion(d + 1, g);
      expect(a.width(-1)).toBe(b.width(0));
      if (d + 1 >= 0) {
        expect(a.list(-1)).toBe(b.list(0));
        expect(a.bar(-1)).toBe(b.bar(0));
        expect(a.preview(-1)).toBe(b.preview(0));
      }
    }
  });

  it("moves only focal and the neighbour it trades with", () => {
    for (const u of US) {
      for (const d of DS) {
        const m = entryMotion(d, g);
        const moves = m.width(u) !== m.width(0);
        const expected =
          u !== 0 && (d === 0 || (u > 0 && d === 1) || (u < 0 && d === -1));
        expect(moves).toBe(expected);
      }
    }
  });

  it("keeps every width inside its band and every opacity in [0, 1]", () => {
    for (const u of US) {
      for (const d of DS) {
        const m = entryMotion(d, g);
        expect(m.width(u)).toBeGreaterThanOrEqual(g.lineW);
        expect(m.width(u)).toBeLessThanOrEqual(g.focalW);
        for (const f of [m.list, m.bar, m.preview]) {
          expect(f(u)).toBeGreaterThanOrEqual(0);
          expect(f(u)).toBeLessThanOrEqual(1);
        }
      }
    }
  });

  it("staggers the crossfade: the outgoing list is mostly gone before the incoming one shows", () => {
    // Forward: focal's list against the next feed's.
    const f0 = entryMotion(0, g);
    const f1 = entryMotion(1, g);
    expect(f1.list(0.3)).toBe(0);
    expect(f0.list(0.3)).toBeCloseTo(0.61);
    expect(f1.preview(0.34)).toBeCloseTo(0);
    // Back: focal's list is gone at a third; its preview starts at 0.3.
    expect(f0.list(-1 / 3)).toBeCloseTo(0);
    expect(f0.preview(-0.3)).toBe(0);
    expect(f0.preview(-0.7)).toBeCloseTo(1);
  });

  it("keeps a list-less entry's preview rows through focal, and keeps every seam", () => {
    for (const d of DS) {
      const a = entryMotion(d, g, false);
      const f = entryMotion(d - 1, g, false);
      const b = entryMotion(d + 1, g, false);
      if (d - 1 >= 0) expect(a.preview(1)).toBe(f.preview(0));
      if (d + 1 >= 0) expect(a.preview(-1)).toBe(b.preview(0));
      for (const u of US) {
        expect(a.preview(u)).toBeGreaterThanOrEqual(0);
        expect(a.preview(u)).toBeLessThanOrEqual(1);
      }
    }
    // Arriving forward and sitting at focal, the rows never fade.
    for (const u of [0, 0.3, 0.6, 1]) expect(entryMotion(1, g, false).preview(u)).toBe(1);
    expect(entryMotion(0, g, false).preview(0)).toBe(1);
    expect(entryMotion(0, g, false).preview(-1)).toBe(1);
    // Leaving forward, they go with the bar.
    const z = entryMotion(0, g, false);
    for (const u of [0.2, 0.5, 0.8]) expect(z.preview(u)).toBe(z.bar(u));
    // A line widening back brings them up with the bar.
    const l = entryMotion(-1, g, false);
    for (const u of [-0.2, -0.5, -0.8]) expect(l.preview(u)).toBe(l.bar(u));
    // With a list, nothing changed.
    for (const d of DS) {
      for (const u of US) {
        expect(entryMotion(d, g, true).preview(u)).toBe(entryMotion(d, g).preview(u));
      }
    }
  });
});
