"use client";

import { useState, type CSSProperties } from "react";
import { NAV_BAR_H, NAV_BAR_INSET } from "./NavBar";
import { useExplain } from "../../stores/explain";
import { useAboutOverlay } from "../../stores/aboutOverlay";
import { prefersReducedMotion } from "../../lib/workspace/motion";
import { LIGHT_ISLAND_STYLE } from "../../lib/palette/island";

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
// drawn from the bar-relative neutral tokens `--ah-ink` / `--ah-bone` /
// `--ah-stone-350` and are NOT islanded like the ∀ disc — so `html.dark`
// inverts ink and bone with the bar wholesale, and the mode-neutral stone tone
// stays put. No per-feed colourway ever reaches here.
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
  "width 140ms ease-out, height 140ms ease-out, background-color 140ms ease-out, border-color 140ms ease-out, color 140ms ease-out, font-size 140ms ease-out";

// Hover-name label tokens — the SAME treatment as the vessel's corner roundel
// name label (Vessel.tsx ROUNDEL_TOKENS), so the muster and the vessel speak
// one visual language (§V).
//
// THE LABEL IS ISLANDED; THE ROUNDELS ARE NOT. That split looks inconsistent
// and is the fix for a real dark-mode bug. The discs are global chrome and MUST
// invert with `html.dark` along with the bar they sit on (see the note above).
// The label is not on the bar — it floats over the FLOOR — and these two
// tokens invert asymmetrically: `bone` is in `DARK_SLUGS` and `ink-925` is not,
// so under `html.dark` the ground stayed dark while the text went dark with it,
// and a hovered feed name was a dark smudge on a dark pill. Islanding it pins
// both to canonical light, which is a dark pill with light text in EITHER mode
// — and that is exactly what the vessel's roundel label already does, because
// the vessel carries the island wholesale. So the "one visual language" claim
// above is only true with the island; without it, the two drifted apart the
// moment the mode flipped.
//
// It went unseen until 2026-08-24 because the label was clipped by its own
// scroll container and had never actually rendered (see the state note below).
const LABEL_BG = "var(--ah-ink-925)";
const LABEL_FG = "var(--ah-bone)";

const STATE_LABEL: Record<MusterState, string> = {
  in: "in view",
  off: "off screen",
  minimised: "minimised",
};

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
  // Panned off / minimised: 18px hollow disc, a 2px ring (the no-single-pixel
  // floor — never 1.5px, which slips the tripwire — §IV). Ink for on-floor,
  // stone-350 for minimised, so "away" reads as greyed and "present but
  // off-screen" as full ink.
  const tone = state === "minimised" ? "var(--ah-stone-350)" : "var(--ah-ink)";
  return {
    ...base,
    width: DISC_OFF,
    height: DISC_OFF,
    border: `2px solid ${tone}`,
    color: tone,
    fontSize: 11,
  };
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
      aria-label="Feeds"
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
        className="scroll-silent"
        // The muster is one Explain subject: report navRow.muster on entering
        // the track, clear on leaving. Per-roundel hover drives only the name
        // label below.
        onMouseEnter={() => {
          if (reportMusterHover)
            useExplain.getState().setHover({ kind: "navRow.muster" });
        }}
        onMouseLeave={() => {
          if (explainActive) useExplain.getState().setHover(null);
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
            ? `Go to Feed ${f.numeral}: ${f.name} (${STATE_LABEL[f.state]})`
            : `Go to Feed ${f.numeral} (${STATE_LABEL[f.state]})`;
          return (
            <div
              key={f.id}
              onMouseEnter={(e) => {
                setHoveredId(f.id);
                if (!f.name) return;
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
                    the vessel's corner roundel, and the mobile pip strip. */}
                {f.numeral}
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
        <div
          className="label-ui"
          aria-hidden
          style={{
            ...LIGHT_ISLAND_STYLE,
            position: "fixed",
            left: label.x,
            top: NAV_BAR_H + 6,
            transform: "translateX(-50%)",
            background: LABEL_BG,
            color: LABEL_FG,
            padding: "3px 8px",
            whiteSpace: "nowrap",
            boxShadow: "0 2px 6px rgba(0, 0, 0, 0.15)",
            opacity: hoveredId ? 1 : 0,
            pointerEvents: "none",
            transition: reduced ? undefined : "opacity 120ms ease-out",
          }}
        >
          {label.name}
        </div>
      )}
    </div>
  );
}
