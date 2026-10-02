// =============================================================================
// The stretched measure — how much of a stretched pane a column of prose takes.
//
// A resizable Glasshouse (the two writers and the reader) can be dragged to any
// width the window allows, and the two things a prose column could do with that
// width are both wrong at the extremes. Take ALL of it and a note composed in a
// 1400px pane runs at ~180 characters a line, which is unreadable — that is what
// the note composer's `w-full` textarea did. Take NONE of it and the pane's
// extra width is dead parchment either side of a column that never moves — that
// is what the editor's and the reader's hard `max-w-article` did.
//
// So the column takes a DECREASING SHARE of each further pixel, easing from the
// measure it rests at toward a ceiling it never passes:
//
//     m(w) = CEIL − (CEIL − REST) · e^(−(w − restW) / EFOLD)
//
// An exponential approach rather than a clamped ramp because the ramp has a
// knee: the measure would track the drag exactly and then stop dead at the cap,
// and the corner is visible as a stall under the pointer. This curve has no
// corner anywhere — it responds immediately, then settles — which is the whole
// of what "elegant" means here.
//
// THE PIVOT IS THE PANE'S OWN REST WIDTH, NOT A CONSTANT. Each surface opens at
// a different default (`widthFor`: the editor and native reader 1000, the
// external reader 736, the composers 640), and pivoting on a shared number would
// move every pane's measure at REST — a change to how the surfaces look before
// anybody touches anything. Pivoting on each pane's own default means nothing
// moves until the member stretches, which is exactly what was asked for.
// `spare` is floored at 0, so shrinking a pane below its default simply holds
// the rest measure (the column is parent-limited there anyway).
//
// THE NUMBERS ARE BOTH EXISTING TOKENS. The curve runs from `maxWidth.article`
// (640 — the reader's canonical column, and what the editor was pinned to) to
// `maxWidth.feed` (780 — the widest running text the design language already
// sets). It invents no new width; it interpolates between two the house holds.
// Pinned against tailwind.config.js by web/tests/stretched-measure.test.ts,
// because a token moving while this file does not is silent in both directions.
//
// ROUNDED TO AN EVEN NUMBER, for the reason centreX snaps the pane's own left
// edge (Glasshouse.tsx): every consumer centres the column with `mx-auto`, so an
// odd measure inside an even content box lands the column on a half-pixel left
// edge and renders all of its text faintly fuzzy. Every surface's content box is
// even (pane widths snap to the 8px lattice; the paddings are 24/40/48/144), so
// an even measure keeps the centring on whole pixels.
// =============================================================================

/** The measure at rest — `maxWidth.article`, the reader's canonical column. */
export const MEASURE_REST = 640;
/** The ceiling the curve eases toward and never passes — `maxWidth.feed`. */
export const MEASURE_CEIL = 780;
/**
 * The e-folding distance: the px of stretch that buys the first 1 − 1/e (≈63%)
 * of the available gain. 360 makes a 200px drag on the editor worth ~60px of
 * measure — felt at once, plainly damped, and essentially settled by the time
 * the pane fills a wide monitor.
 */
export const MEASURE_EFOLD = 360;

/**
 * The prose measure for a pane of `paneW` whose default (unstretched) width is
 * `restW`. Returns `MEASURE_REST` when the pane is at or below its default.
 */
export function stretchedMeasure(paneW: number, restW: number): number {
  const spare = Math.max(0, paneW - restW);
  const m =
    MEASURE_CEIL - (MEASURE_CEIL - MEASURE_REST) * Math.exp(-spare / MEASURE_EFOLD);
  return Math.round(m / 2) * 2;
}
