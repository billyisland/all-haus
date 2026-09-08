"use client";

// =============================================================================
// AboutOverlay — /about rendered in a workspace Glasshouse (EXPLAIN-ADR D3).
//
// Opened from the ∀ menu's "About" row (both desktop and mobile — on mobile it
// occupies the slot Explain would, since Explain has no hover branch there)
// and, during a floor-mode Explain program, from the "About all.haus" button
// that replaces the wordmark. Wraps the same AboutContent the standalone
// /about page renders, so the ForallMenu chrome stays crisp above it and
// Esc/✕/scrim-click all dismiss it; on mobile it is a full-screen sheet the
// disc-X minimises.
//
// THE FRAME (2026-09-04). It used to be a bare white pane holding the public
// page's own ⊔ vessel — a container inside a container, in the one register
// where the pane already IS the container. It is now the house's ⊓, built the
// way the profile pane builds it (PROFILE-PANE-REDESIGN-ADR W3/§9.2) rather
// than the way the reader does: an INVERTED feed vessel — top bar plus side
// rules, open at the bottom — at the VESSEL'S OWN 8px wall, not the reader's
// deliberately thinner 4px echo. About is not echoing a feed it was launched
// from; it has no feed, so it is drawn as one.
//
// The bar carries the pane's slug and nothing else. The reader's bar splits
// into two identities because a post HAS two (source and title, D1); About has
// one thing to say, so the left end says it and the ✕ sits at the right.
//
// Three Glasshouse props follow from the bar rather than decorating it, exactly
// as they do on the reader: `frameTopSlot` (the bar IS the ⊓'s top, so the
// frame must not stroke a second thinner one over it), `hideClose` (the shared
// ✕ is grey-on-white and would sit low-contrast on the band, hovering DARKER)
// and `dragHandleSelector` (the grip pill would be a fleck floating on it).
//
// COLOUR: `globalContentPalette(dark)`, un-islanded — the pairing every
// feed-agnostic pane takes (ProfileChrome's PALETTE note). Handed to the cards
// through `PublicPaletteProvider` so the interior, the bar and the prose all
// come off ONE palette and cannot pair wrongly; resolving `basic` per-primitive
// instead would put stone-600 standfirsts on a dark ground in dark mode.
// =============================================================================

import { useAboutOverlay } from "../../stores/aboutOverlay";
import { Glasshouse } from "./Glasshouse";
import { AboutContent } from "../../app/about/AboutContent";
import { PublicPaletteProvider } from "../public/palette";
import {
  globalContentPalette,
  PANE_BAR_H,
  VESSEL_WALL,
  type VesselPalette,
} from "./tokens";
import { useResolvedDark } from "../../stores/colorScheme";

/** The pane's slug — the one thing its bar has to say. */
const SLUG = "About all.haus";

export function AboutOverlay() {
  const isOpen = useAboutOverlay((s) => s.isOpen);
  const close = useAboutOverlay((s) => s.close);
  const dark = useResolvedDark();
  const palette = globalContentPalette(dark);
  if (!isOpen) return null;

  // 720 = the `prose` measure the standalone page sets (PublicShell), so the
  // two registers of one surface set text to the same column.
  return (
    <Glasshouse
      onClose={close}
      maxWidth={720}
      ariaLabel={SLUG}
      persistKey="about"
      frameColor={palette.walls}
      frameTextColor={palette.barText}
      // The bar IS the ⊓'s thick top, and the rules are the VESSEL'S wall
      // rather than the reader's thinner echo of it — the pane is being a feed
      // container, not referring to one. AboutContent's pane register insets
      // its cards past that wall (WALL + PAD), which is the condition
      // `frameSideWidth` documents.
      frameTopSlot
      frameSideWidth={VESSEL_WALL}
      hideClose
      dragHandleSelector=".ah-pane-bar"
    >
      <AboutBar onClose={close} palette={palette} />
      {/* The bar is in flow above this, so the body's share of the pane is what
          the bar leaves — the one constant, subtracted once. */}
      <div
        className="overflow-y-auto"
        style={{ maxHeight: `calc(var(--gh-h) - ${PANE_BAR_H}px)` }}
      >
        <PublicPaletteProvider value={palette}>
          <AboutContent inOverlay />
        </PublicPaletteProvider>
      </div>
    </Glasshouse>
  );
}

// -----------------------------------------------------------------------------
// AboutBar — the pane's thickened top: the slug at the left end, the ✕ at the
// right. Painted from the pane's ONE palette (`barBg`/`barText`, the sanctioned
// pair), which is the same object the ⊓'s rules take their colour from, so the
// bar reads as the frame's top rather than a slab dropped into a frame of some
// other colour. Shares `.ah-pane-bar` with the reader — one shape, two panes.
// -----------------------------------------------------------------------------
function AboutBar({
  onClose,
  palette,
}: {
  onClose: () => void;
  palette: VesselPalette;
}) {
  return (
    <div
      className="ah-pane-bar"
      style={{
        height: PANE_BAR_H,
        background: palette.barBg,
        color: palette.barText,
      }}
    >
      {/* `flex: 1` via the reader's own source rule would tie About to a
          reader-named class; the slug is short and never truncates, so it just
          takes the room and pushes the ✕ to the end. */}
      <span className="label-ui" style={{ flex: "1 1 auto", minWidth: 0 }}>
        {SLUG}
      </span>
      <button
        type="button"
        onClick={onClose}
        aria-label="Close"
        className="ah-pane-bar-close"
        style={{ color: "inherit" }}
      >
        ✕
      </button>
    </div>
  );
}
