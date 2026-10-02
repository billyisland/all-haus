"use client";

import { useState, type CSSProperties } from "react";
import { NAV_BAR_H, NAV_BAR_INSET } from "./NavBar";
import { useExplain } from "../../stores/explain";
import { useAboutOverlay } from "../../stores/aboutOverlay";
import { prefersReducedMotion } from "../../lib/workspace/motion";
import { LIGHT_ISLAND_STYLE } from "../../lib/palette/island";
import { RoundelLabel } from "./RoundelLabel";

// =============================================================================
// Muster — the run of numbered feed roundels in the desktop nav bar.
// NAV-ROW-MUSTER-ADR §IV. Docked at the bar's RIGHT end since 2026-08-25.
//
// A run of one roundel per LIVE feed (hidden included), in numeral order,
// reading left→right with 1 first. It answers "how many feeds do I have, and
// where am I among them" as ambient chrome (§II.2): it reports state and
// navigates; it never edits.
//
// THE TURN IS OVER, AND THIS IS THE OCCUPANT IT COST THE MOST.
// For one day (2026-08-24) the chrome ran up the left margin as a rail, and
// every occupant was supposed to hinge with it. The muster was built to —
// running bottom→top with its numerals turned −90° — and **that shipped and was
// wrong on sight**: a lone "1" turned on its side reads as a dash. It was
// corrected the same day to upright numerals reading top→bottom, which left it
// a standing exception to the rail's own governing rule. With the bar along the
// TOP the exception dissolves: a left→right run of upright numerals is both the
// natural reading order AND the arrangement rule, with nothing to except.
//
// The lesson the episode leaves is worth keeping even though the code that
// forced it is gone: **an arrangement rule never outranks the readability of
// the thing arranged.** If a future move asks a numeral to turn, the numeral
// wins.
//
// WHAT COMES BACK WITH THE MOVE: under the rail, top→bottom no longer
// corresponded to the floor's left→right, so the muster was a LIST rather than
// a scale model of the floor's axis. On the top bar the correspondence is back
// for free — Feed 1 is leftmost here and leftmost on the floor.
//
//   • NUMERALS ARE UPRIGHT. No rotation, no writing mode — the same numeral
//     form as a vessel's corner roundel and the mobile pip strip.
//   • THE RUN READS LEFT→RIGHT, 1 first. Plain `flexDirection: "row"`, so
//     paint order, DOM order, tab order and screen-reader order are all the
//     same 1..N and there is nothing to keep in sync. **Never flip the axis by
//     reversing `feeds`** — it looks identical and silently makes assistive
//     tech count backwards.
//   • IT DOCKS AT THE RIGHT END, not centred. `marginLeft: auto` (never
//     `justifyContent: flex-end` — that clips the START of an overflowing
//     scroll container, which is precisely the case a long feed list hits). The
//     `RIGHT_INSET` matches the lockup's own `left: 24`, so the two occupants
//     of the bar are inset equally from the ends they dock at.
//   • the hover name label floats BELOW its disc — out over the floor, the only
//     direction with room — and is set horizontally.
//
// CELLS ARE FIXED; DISCS ARE NOT. Each roundel owns a 32px cell (4 GRID: a 24px
// disc plus an 8px gutter). The cell WIDTH never changes, so NO ROUNDEL MOVES
// during a pan — the only thing panning changes is which discs are large (§IV,
// principle 3). Size, not position, encodes state; that is what keeps the bar
// off the "flicker in the corner of the eye" list.
//
// GLOBAL CHROME, NOT A FEED ISLAND (§IV.4 / §IV dark-mode note). The discs are
// drawn from the bar-relative neutral tokens `--ah-ink` / `--ah-bone` alone and
// are NOT islanded like the ∀ disc — so `html.dark` inverts the whole run with
// the bar wholesale. No per-feed colourway ever reaches here, and no
// mode-neutral one either: the stone ramp left this file with the hollow ring
// (see DISC_OFF_BG on why a mode-neutral grey cannot be a ground here).
//
// THREE STATES, ONE RAMP (2026-08-31). Every pip is now a SOLID disc; what
// changes is size and tone. In view: 24px ink, bone numeral. Off screen: 18px
// ink-at-alpha, bone numeral — the same pip, one step away. Minimised: 18px with
// the colourway turned over (bone ground, ink ring, ink glyph) and the numeral
// replaced by the ∀ disc's own close-X. The first two are DISTANCE and read as a
// ramp; the third is a different fact — shut, not far — and reads as a flip.
// The hollow ring the two away states used to share is gone: it made "off
// screen" and "minimised" siblings distinguished only by tint, which is the
// weakest possible signal for the strongest difference in the set.
//
// This is a separate fixed layer over the NavBar band rather than a child of
// NavBar: the state it needs (geometry, pan, the live feed list) lives in
// WorkspaceView, so the muster mounts there beside NavBar, exactly as the ∀
// lockup does via `ForallMenu anchor="row"`. NavBar stays the pure, empty band.
//
// Z-58, mirroring the bar and the mobile bar — above the Glasshouse scrim (55)
// and pane (56) so a roundel is clickable over an open pane (§VII); below the ∀
// disc (60). The click closes any open pane before scrolling (§V) — wired in
// WorkspaceView's `onGoTo`.
//
// PHASE 2: geometry, the three states, fixed cells, click-to-go, centring +
// overflow that clears the lockup.
//
// PHASE 3 (§VIII.3): the floating hover-name label (replacing the `title`
// stand-in), reduced-motion gate on the disc transition, the Explain
// `navRow.muster` label, and the §VII a11y pass (already a labelled group of
// aria-labelled buttons since Phase 2; the click guard below is the addition).
//
// HOW-divergence from §VII, owned: §VII imagined a passive
// `data-explain="navRow.muster"` tag the scrim's hit-test would find. But the
// as-built muster is a SEPARATE fixed layer ABOVE the floor-mode scrim (z-58 >
// 50) with `pointerEvents:auto` on its track — so pointermove over it never
// reaches the scrim and a passive tag is unreachable, exactly as for the ∀ disc
// (also z-60, also above the scrim). So the muster REPORTS ITS OWN HOVER to the
// engine (the disc pattern, ForallMenu.tsx), and the outer band keeps
// `data-explain-chrome` so any look-through path (wheel-forward, hit-test)
// still sees straight past it. A click while Explain is active sheds the
// annotations rather than navigating, mirroring the disc.
// =============================================================================

export type MusterState = "in" | "off" | "minimised";

export interface MusterFeed {
  id: string;
  /** Stable numeral (§III), assigned over the live set — may have gaps. */
  numeral: number;
  /** Descriptive feed name, for the hover title / aria label. May be empty. */
  name: string;
  state: MusterState;
}

// §IV geometry. The cell is fixed at 4 GRID; the disc grows within it.
const CELL = 32;
const DISC_IN = 24;
const DISC_OFF = 18;

// The run docks this far in from the bar's right end. It MATCHES the lockup's
// own `left: 24` (ForallMenu's row anchor), so the bar's two occupants are
// inset equally from the ends they dock at.
const RIGHT_INSET = 24;

// Reservation at the LEFT end alone, where the ∀ lockup lives (fixed container
// at `left: 24`, z-60). It was once reserved at BOTH ends, because a CENTRED
// track had to stay clear of the lockup without shifting its visual centre off
// the viewport's. A right-docked run grows towards the lockup from one side
// only, so one reservation is the whole rule; past it the track scrolls in
// place (§IV centring + overflow).
//
// SIZED FOR THE WIDER OF THE LOCKUP'S TWO STATES, WHICH IS NOT THE IDLE ONE.
// Idle, the lockup is 24 + disc 40 + gap 14 + the "all.haus" wordmark (~85 at
// 24px) ≈ 163. While an Explain program runs, the wordmark gives way to the
// "About all.haus" pill (ForallMenu's D3 chrome swap), which is ~144 wide —
// right edge at ~222. 232 is that plus one GRID.
//
// THIS RESERVE HAS ALREADY SHIPPED WRONG ONCE, sized off the idle state, and
// the consequence was not a near miss: on a short window with 20 feeds the
// track clamped and **Feed 1 vanished entirely behind the pill**, the muster
// appearing to start at 2 for as long as Explain was open. It costs exactly one
// cell to size for the larger state, and that is the right way round: a reserve
// that is only correct in one of two states the product actually enters is not
// a reserve. Sizing it dynamically was the other option and is worse — the
// track would reflow every time Explain opened, which is chrome moving under
// the reader's eye for no reason they can see.
//
// (The number survived the move from the rail unchanged, because the pill is
// the same pill: what was its height is now its width.)
const LEFT_RESERVE = 232;

// §IV: 120–160ms ease-out on radius and fill, matching the mobile pip and the
// vessel outline. Size + fill + ring + numeral colour all ride it, so a state
// flip reads as one settle. Gated off under prefers-reduced-motion (§VIII.3).
const DISC_TRANSITION =
  "width 140ms ease-out, height 140ms ease-out, background-color 140ms ease-out, box-shadow 140ms ease-out, color 140ms ease-out, font-size 140ms ease-out";

// The hover-name label is the shared `RoundelLabel` — the SAME treatment as
// the vessel's corner roundel name label, so the muster and the vessel speak
// one visual language (§V).
//
// THE LABEL IS ISLANDED; THE ROUNDELS ARE NOT. That split looks inconsistent
// and is the fix for a real dark-mode bug. The discs are global chrome and MUST
// invert with `html.dark` along with the bar they sit on (see the note above).
// The label is not on the bar — it floats over the FLOOR — and its tokens
// invert asymmetrically (`RoundelLabel.tsx` says how), so it carries the
// island in its placement, exactly as the vessel's label gets it from the
// vessel it sits on.
//
// It went unseen until 2026-08-24 because the label was clipped by its own
// scroll container and had never actually rendered (see the state note below).

const STATE_LABEL: Record<MusterState, string> = {
  in: "in view",
  off: "off screen",
  minimised: "minimised",
};

// THE OFF-SCREEN GREY IS INK AT ALPHA, NOT A STONE TOKEN (2026-08-31).
// It reads as "the present pip, greyed" — which is what it is — but the reason
// it cannot be `--ah-stone-350` is the un-islanded note above. The stone ramp is
// mode-NEUTRAL and ink/bone INVERT with the bar. That was harmless while grey
// was a ring beside a grey numeral (both stone, both static). The moment grey
// became a GROUND under a bone numeral the two had to invert together, or dark
// mode puts a near-black numeral on a mid-grey disc. Ink at alpha over the bar's
// own bone is the one construction that mirrors correctly in both modes — and it
// is composited over the bar, which is why the muster's band must stay a layer
// ABOVE NavBar's ground rather than a sibling beside it.
const DISC_OFF_BG = "rgb(var(--ah-ink-rgb) / 0.55)";

// The ring is an INSET BOX-SHADOW, never a border. A 2px border-width on a
// `box-sizing: border-box` disc eats 4px of the content box, which is where the
// X spans from — the glyph would come out a quarter smaller than the ∀ disc's
// and its strokes would fall under the no-single-pixel floor. The shadow draws
// the same 2px ring on the same radius and leaves the content box the full
// DISC_OFF.
const RING = "inset 0 0 0 2px var(--ah-ink)";

function discStyle(state: MusterState, reduced: boolean): CSSProperties {
  const base: CSSProperties = {
    display: "flex",
    alignItems: "center",
    justifyContent: "center",
    boxSizing: "border-box",
    borderRadius: "50%",
    padding: 0,
    lineHeight: 1,
    fontWeight: 500,
    cursor: "pointer",
    background: "transparent",
    border: "none",
    transition: reduced ? undefined : DISC_TRANSITION,
  };
  if (state === "in") {
    // 24px solid ink, bone numeral. No ring.
    return {
      ...base,
      width: DISC_IN,
      height: DISC_IN,
      background: "var(--ah-ink)",
      color: "var(--ah-bone)",
      fontSize: 12,
    };
  }
  if (state === "minimised") {
    // MINIMISED: the present pip with its colourway turned over — bone ground,
    // ink glyph — and the numeral replaced by the close-X (below). A hidden feed
    // is not a place you are near or far from; it is a place that is SHUT, and
    // the run says so with the same mark the ∀ disc uses for the same meaning.
    //
    // The ring is what keeps it a roundel. The bar's own ground is
    // `--ah-bone` (NavBar.tsx), so a bone disc has no rim of its own and the
    // flip would otherwise read as a bare X floating in the run — the roundel
    // per feed silently going missing exactly where the muster is meant to be
    // reporting one. With the ring it reads as a flip, which is the claim.
    return {
      ...base,
      width: DISC_OFF,
      height: DISC_OFF,
      position: "relative",
      background: "var(--ah-bone)",
      boxShadow: RING,
      color: "var(--ah-ink)",
    };
  }
  // OFF SCREEN: the present pip, one size down and greyed — same solid disc,
  // same bone numeral, so "off to the side" reads as a step along one ramp
  // rather than a different kind of thing. (Until 2026-08-31 both away states
  // were hollow rings and grey meant MINIMISED; the hollow form has left the
  // vocabulary entirely. Anything describing these states in the old
  // filled/hollow/grey terms — the Explain caption is the one — moves with it.)
  return {
    ...base,
    width: DISC_OFF,
    height: DISC_OFF,
    background: DISC_OFF_BG,
    color: "var(--ah-bone)",
    fontSize: 11,
  };
}

// The minimised pip's X — ForallMenu's close glyph in the same viewBox 56 frame
// with the same round caps, so it is recognisably the one mark: this is what
// "the ∀ disc when a pane is open" looks like on a 4-GRID roundel.
//
// It differs from the disc's in two numbers, and BOTH are consequences of the
// size rather than second thoughts about the form. **The stroke is opened
// 6 → 6.3**, forced: at DISC_OFF 6 units renders 1.93px, under the
// no-single-pixel floor (§IV), and 6.3 clears 2. **The span is pulled in from
// 11→45 to 17→39**, because the ∀ disc has 40px for its proportion and this has
// 18: at the disc's own span the arms landed on the ring and the pip read as ⊗,
// a crossed-out circle, rather than as a close mark inside a roundel.
//
// THE COORDINATES ARE NOT THE EXTENT — A ROUND CAP ADDS HALF A STROKE AT EACH
// END. At stroke 6.3 that is 3.15 units per end, so these lines actually paint
// 13.85→42.15 (≈0.505 of the frame), and the ∀ disc's own 11→45 paints ≈8→48 —
// which is why the disc can carry it and this cannot: the disc CLIPS its glyph
// at the rim (`forall-clip`, r=28), so its arms are cut flush and the overshoot
// never shows, while this roundel has no clip and the caps run into the ring.
// A first attempt at 14→42 was picked as "0.61 down to 0.5" off the raw
// coordinates and was invisible on screen — it paints 10.85→45.15, within a
// unit of what it replaced. Any future adjustment here is to the PAINTED
// extent; convert through the cap before believing a number.
//
// Spanning the content box at all is what the inset-shadow ring above buys; a
// bordered ring would have taken 4px of it before either number was chosen.
function MusterCloseGlyph() {
  return (
    <svg
      aria-hidden="true"
      viewBox="0 0 56 56"
      style={{ position: "absolute", inset: 0, width: "100%", height: "100%" }}
      stroke="currentColor"
      strokeWidth={6.3}
      strokeLinecap="round"
      fill="none"
    >
      <line x1="17" y1="17" x2="39" y2="39" />
      <line x1="39" y1="17" x2="17" y2="39" />
    </svg>
  );
}

export function Muster({
  feeds,
  onGoTo,
}: {
  feeds: MusterFeed[];
  onGoTo: (feedId: string) => void;
}) {
  // Which roundel's floating name label is showing (§V). Local hover state,
  // independent of Explain — the name label reads the same whether or not a
  // program is active.
  //
  // ONE LABEL, AT THE BAND, NOT ONE PER CELL. The label used to be an
  // absolutely-positioned child of its own cell, and it was clipped by the
  // track: `overflow-y: visible` beside an `overflow-x: auto` computes to
  // `auto`, so a label leaving a sideways-scrolling track vertically is clipped
  // exactly as one leaving a downward-scrolling track sideways was. (The
  // original bottom row never had enough feeds on screen to notice; the rail
  // made it obvious, and the fix outlives both.) So the label is hoisted OUT of
  // the scroll container and positioned from the hovered cell's measured
  // viewport x, the same `getBoundingClientRect` handoff `PipTrigger` uses to
  // anchor the pip panel.
  //
  // `label` deliberately OUTLIVES `hoveredId`: leaving a roundel clears the id
  // (so opacity goes to 0) but leaves the text and position in place, which is
  // what lets the fade-OUT play instead of the node vanishing mid-transition.
  const [hoveredId, setHoveredId] = useState<string | null>(null);
  const [label, setLabel] = useState<{ name: string; x: number } | null>(null);

  // Explain integration (§VII). The muster sits above the floor-mode scrim, so
  // it reports its own hover to the engine (the ∀-disc pattern) rather than
  // being found by the scrim's hit-test. Floor mode only: pane-mode Explain
  // annotates the pane alone, and About-open renders bubbles below the frost.
  const explainActive = useExplain((s) => s.isActive);
  const explainSurface = useExplain((s) => s.program?.surface);
  const aboutOpen = useAboutOverlay((s) => s.isOpen);
  const reportMusterHover =
    explainActive && explainSurface === "floor" && !aboutOpen;

  const reduced = prefersReducedMotion();

  if (feeds.length === 0) return null;

  return (
    // Full-width band overlaying the NavBar ground; only the track inside takes
    // pointer events, so the empty run beside it never eats a click.
    <div
      role="group"
      aria-label="Channels"
      // Global chrome, drawn straight through by every look-through path
      // (scrim hit-test, wheel-forward). Explain reaches the muster by its own
      // hover report, not this tag — see the header HOW-divergence note.
      data-explain-chrome=""
      style={{
        position: "fixed",
        left: 0,
        right: 0,
        top: 0,
        height: NAV_BAR_H,
        zIndex: 58,
        display: "flex",
        flexDirection: "row",
        // Centred on the LOCKUP's line, not the band's. The ∀ disc is not
        // centred in the bar (NavBar.tsx: its top is one GRID down and its
        // bottom is the band's edge), so `alignItems: center` against the bare
        // band would sit every roundel 4px above the disc — a misalignment
        // running the whole width of the screen between the two things the bar
        // holds. The padding moves the content box onto the disc's own span, and
        // then centring is correct again.
        paddingTop: NAV_BAR_INSET,
        alignItems: "center",
        // No `justifyContent` — the track docks itself with `marginLeft: auto`
        // below. `flex-end` would read the same and clip the START of the track
        // once it overflows, stranding Feed 1 left of the scroll origin.
        paddingRight: RIGHT_INSET,
        pointerEvents: "none",
      }}
    >
      <div
        // The muster is one Explain subject: report navRow.muster on entering
        // the track, clear on leaving. Per-roundel hover drives only the name
        // label below.
        onMouseEnter={() => {
          if (reportMusterHover)
            useExplain.getState().setHover({ kind: "navRow.muster" });
        }}
        onMouseLeave={() => {
          if (explainActive) useExplain.getState().setHover(null);
          // The floating name label belongs to the track, not to a roundel, so
          // leaving the track must take it with you — a per-roundel mouseleave
          // fires on the way to the NEXT roundel too, and clearing it there
          // would flicker the label off between every pair.
          setLabel(null);
        }}
        style={{
          display: "flex",
          // Plain `row`: 1 at the left, the highest numeral at the right, and
          // paint / DOM / tab / screen-reader order all the same 1..N. Nothing
          // here reverses anything — see the header on why that is the point.
          flexDirection: "row",
          alignItems: "center",
          // Docks the run at the right end of the band. `marginLeft: auto`
          // rather than the band's `justify-content`, because a flex `flex-end`
          // clips the start of an overflowing scroll container — the
          // long-feed-list case.
          marginLeft: "auto",
          // Grows leftward until it would meet the lockup; past that it scrolls
          // in place (§IV centring + overflow). scrollbar hidden — a native bar
          // inside the bar would draw a banned rule across it. `max()` floors
          // the track at one cell so a pathologically narrow viewport can never
          // collapse it to a negative width.
          maxWidth: `max(${CELL}px, calc(100vw - ${LEFT_RESERVE + RIGHT_INSET}px))`,
          overflowX: "auto",
          pointerEvents: "auto",
        }}
      >
        {feeds.map((f) => {
          const label = f.name
            ? `Go to Channel ${f.numeral}: ${f.name} (${STATE_LABEL[f.state]})`
            : `Go to Channel ${f.numeral} (${STATE_LABEL[f.state]})`;
          return (
            <div
              key={f.id}
              onMouseEnter={(e) => {
                setHoveredId(f.id);
                // AN UNNAMED FEED CLEARS THE LABEL, it does not just decline to
                // set one. Returning early left the PREVIOUS feed's name
                // floating — over the previous feed's position, since the x
                // came off that roundel — so hovering an unnamed feed printed
                // somebody else's name beside a numeral that is not theirs.
                // A feed's name is optional by design (`feeds_name_length` has
                // no floor), so this is the ordinary case, not an edge one.
                if (!f.name) {
                  setLabel(null);
                  return;
                }
                const r = e.currentTarget.getBoundingClientRect();
                setLabel({ name: f.name, x: r.left + r.width / 2 });
              }}
              onMouseLeave={() =>
                setHoveredId((cur) => (cur === f.id ? null : cur))
              }
              style={{
                width: CELL,
                flex: `0 0 ${CELL}px`,
                display: "flex",
                alignItems: "center",
                justifyContent: "center",
              }}
            >
              <button
                type="button"
                className="focus-ring font-sans"
                aria-label={label}
                onClick={() => {
                  // A click while Explain is active sheds the annotations
                  // rather than navigating (the disc's behaviour): the muster
                  // is above the scrim, so its click never reaches the scrim's
                  // own dismiss.
                  if (useExplain.getState().isActive) {
                    useExplain.getState().close();
                    return;
                  }
                  onGoTo(f.id);
                }}
                style={discStyle(f.state, reduced)}
              >
                {/* Upright, bare, and no wrapper. It was briefly turned −90° to
                    honour the left rail's hinge rule and read as a dash at Feed
                    1 — see the header. One numeral form on every surface: here,
                    the vessel's corner roundel, and the mobile pip strip.

                    A minimised feed shows the close-X instead — the numeral is
                    dropped, not overlaid, since the state it reports is "shut"
                    rather than "which one". The numeral survives in the aria
                    label, which is where a screen reader needs it. */}
                {f.state === "minimised" ? <MusterCloseGlyph /> : f.numeral}
              </button>
            </div>
          );
        })}
      </div>
      {/* §V floating name label — the vessel roundel's treatment, floated BELOW
          the bar (the muster sits along the screen's top edge, so below is the
          only side with room). `position: fixed`, a SIBLING of the scrolling
          track rather than a child of a cell, because the track clips (see the
          state note above); it is placed from the hovered cell's measured
          centre, so it stays pinned to its roundel.

          Kept mounted so the fade-out plays; pointer-inert either way. */}
      {label && (
        <RoundelLabel
          visible={hoveredId !== null}
          ariaHidden
          fade={!reduced}
          place={{
            ...LIGHT_ISLAND_STYLE,
            position: "fixed",
            left: label.x,
            top: NAV_BAR_H + 6,
            transform: "translateX(-50%)",
          }}
        >
          {label.name}
        </RoundelLabel>
      )}
    </div>
  );
}
