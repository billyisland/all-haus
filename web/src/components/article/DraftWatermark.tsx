// =============================================================================
// DraftWatermark — the standing "this is not published" mark on /preview/:draftId
//
// It replaced a crimson strap at the top of the reader. The strap was a band of
// chrome across the one surface whose whole job is fidelity: a preview that
// wears furniture the live article does not is a preview of something else. A
// watermark states the same fact without taking any of the page.
//
// THE MONO VOICE IS THE RIGHT ONE and not a preference: mono is the house's
// infrastructure register — labels, metadata, system status — and "this is a
// draft" is a fact the SYSTEM is stating about the page, not a thing the piece
// says about itself. It is `.label-ui`'s own voice at stamp size.
//
// WEIGHT 400, BECAUSE THAT IS WHAT SHIPS. Only the 400 face of IBM Plex Mono is
// in `/fonts`; a heavier `font-weight` would have the browser synthesise one by
// smearing the 400, which at this size is a visible defect rather than a subtle
// one. The mark carries instead on scale and on the wash's alpha.
//
// -----------------------------------------------------------------------------
// FLUSH MEANS THE INK BOX, NOT THE ADVANCE BOX — and in this face the difference
// is not subtle. A glyph's advance carries a side bearing at each end, and in
// Plex Mono "DRAFT" those two are nothing like equal: the D sits 0.093em inside
// its cell and the T's arm only 0.021em inside its own. So laying the ADVANCE
// edge to edge — the obvious reading of "full width", and what this did before —
// leaves the D more than four times further off the window edge than the T, an
// asymmetry you can see without measuring.
//
// So the viewBox IS the ink rectangle. Its width is the ink width (not the
// advance), its height is the cap height, and the text origin is pulled LEFT by
// the D's own bearing so the ink starts at x=0 — which puts the T's arm on
// x=1000 by construction rather than by adjustment. The advance overhangs the
// box at both ends and is allowed to: `overflow: visible` on the svg, since
// clipping at exactly the ink edge would shave the antialiasing off the two
// strokes the whole arrangement exists to place.
//
// A pleasant consequence: with the box equal to the ink, "is it centred" stops
// being a question. The wrapper centres the box, the box IS the word, so the
// word is centred vertically and spans the width — no baseline to place by eye,
// and no em box (which reserves a descent this word does not use) in the way.
//
// EVERY RATIO HERE IS MEASURED, not taken from a metrics table: canvas
// `measureText('DRAFT')` on the rendered face, per em. The descent measures 0,
// which is the claim that the ink is exactly the cap block — confirmed rather
// than assumed, and what lets the baseline sit on the box's bottom edge.
//
// And `getBBox()` is the wrong instrument for checking any of this, which is
// worth knowing before reaching for it: on a `<text>` node Chromium returns the
// EM box — 1.3em tall, its top above the viewBox — so it will report the word
// badly off centre while the ink is within a pixel of true.
//
// THE WIDTH IS PINNED rather than set in CSS because under `font-display: swap`
// the first paint is a fallback face with different metrics, and a CSS-sized
// word would jump to a new width when Plex lands. `textLength` is set to the
// face's own natural advance, so `lengthAdjust`'s default (`spacing`) does
// nothing: the letterforms are never touched and the tracking stays Plex's.
// -----------------------------------------------------------------------------
//
// Colour, layer and the `pointer-events` waiver are all in `.ah-draft-watermark`
// (globals.css), beside the alpha's dark-mode re-declaration.
//
// `aria-hidden` because the fact is already in the page's own text — the header
// dateline reads "Draft — saved <date>" under preview — and a screen reader
// meeting a bare "DRAFT" mid-prose hears an interjection, not a watermark. The
// mark is the sighted reading of a fact that is stated in words elsewhere; if
// that dateline ever goes, this needs a label rather than the hide.
// =============================================================================

/** Measured off the rendered face, per em: `measureText('DRAFT')` at 1000px.
 *  Ink width is the advance (3em, mono × 5 glyphs) less both side bearings. */
const ADVANCE_PER_EM = 3
const INK_W_PER_EM = 2.886
const LSB_PER_EM = 0.093
const CAP_PER_EM = 0.704

/** The design box is the INK box: 1000 units wide = the window's full width. */
const BOX_W = 1000
const FONT_SIZE = BOX_W / INK_W_PER_EM
const BOX_H = FONT_SIZE * CAP_PER_EM
/** Pull the origin left by the D's bearing, so the ink — not the cell — starts
 *  at the window's edge. The advance overhangs at both ends; the svg lets it. */
const ORIGIN_X = -FONT_SIZE * LSB_PER_EM
/** Descent is 0, so the baseline IS the box's bottom edge. */
const BASELINE = BOX_H

export function DraftWatermark() {
  return (
    <div className="ah-draft-watermark" aria-hidden="true">
      <svg viewBox={`0 0 ${BOX_W} ${BOX_H}`} preserveAspectRatio="xMidYMid meet" focusable="false">
        <text x={ORIGIN_X} y={BASELINE} fontSize={FONT_SIZE} textLength={FONT_SIZE * ADVANCE_PER_EM}>
          DRAFT
        </text>
      </svg>
    </div>
  )
}
