import type { QueueGeometry } from "./queueGeometry";

// Where every entry stands at progress `u` (WORKSPACE-QUEUE-ADR §VII.6's
// interpolation). Pure: `u` is the gesture's one number, signed — `u > 0` is
// travel forward, toward the feeds ahead — and `d` is the entry's place
// relative to focal AT REST (`d = i − p`). Every width and opacity in the
// queue is one of these functions of `u`; nothing else moves, and entries to
// the right slide by layout as the three clips below change width.
//
// THE GEOMETRY AT `u = ±1` IS THE NEXT RESTING STATE, which is what lets a
// commit swap every entry's `d` and reset `u` to 0 without a jump: `at(d, 1)`
// and `at(d − 1, 0)` agree on every width, and on every opacity that is
// visible (a line's list is clipped to nothing, whatever its opacity).
//
// The fades are staggered on purpose: two lists overlapping at once read as
// mud, so the outgoing list is mostly gone before the incoming one starts.
//
// AN ENTRY WITH NO LIST KEEPS ITS PREVIEW ROWS (`hasList: false`). A feed a
// walk or a long swipe passes through is a wash with no card tree (§VII.7), so
// the crossfade from preview to list would fade its rows out onto nothing: at
// a swipe's speed, every feed crossed flashed rows → blank slab → gone. So
// its rows stay at full opacity as it widens through focal and fade with the
// bar as it collapses to a line; backward, they rise with the bar as a line
// widens. Where the list does exist nothing changes.

export interface EntryMotion {
  /** The clip's width, px. */
  width: (u: number) => number;
  /** The full card list. */
  list: (u: number) => number;
  /** The bar and the numeral. */
  bar: (u: number) => number;
  /** The preview layer (§VII.5). */
  preview: (u: number) => number;
}

const clamp = (v: number) => Math.max(0, Math.min(1, v));
const lerp = (a: number, b: number, t: number) => a + (b - a) * t;
const fwd = (u: number) => Math.max(0, u);
const back = (u: number) => Math.max(0, -u);
const one = () => 1;
const zero = () => 0;

export function entryMotion(
  d: number,
  g: QueueGeometry,
  hasList = true,
): EntryMotion {
  const { focalW: FW, compactW: CW, lineW: L } = g;
  if (d === 0) {
    // Forward it collapses to a line, list and bar going together; back it
    // narrows to compact, the list giving way to the preview rows.
    return {
      width: (u) => (u >= 0 ? lerp(FW, L, fwd(u)) : lerp(FW, CW, back(u))),
      list: (u) => (u >= 0 ? 1 - clamp(1.3 * fwd(u)) : 1 - clamp(3 * back(u))),
      bar: (u) => 1 - clamp(1.3 * fwd(u)),
      preview: hasList
        ? (u) => clamp((back(u) - 0.3) * 2.5)
        : (u) => 1 - clamp(1.3 * fwd(u)),
    };
  }
  if (d === 1) {
    return {
      width: (u) => lerp(CW, FW, fwd(u)),
      list: (u) => clamp((fwd(u) - 0.3) * 2.5),
      bar: one,
      preview: hasList ? (u) => 1 - clamp(3 * fwd(u)) : one,
    };
  }
  if (d === -1) {
    const up = (u: number) => clamp(1.3 * back(u) - 0.1);
    return {
      width: (u) => lerp(L, FW, back(u)),
      list: up,
      bar: up,
      preview: hasList ? zero : up,
    };
  }
  if (d > 1) return { width: () => CW, list: zero, bar: one, preview: one };
  return { width: () => L, list: zero, bar: zero, preview: zero };
}
