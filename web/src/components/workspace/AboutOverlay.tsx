"use client";

// =============================================================================
// AboutOverlay — /about rendered in a workspace Glasshouse (EXPLAIN-ADR D3).
//
// Opened from the ∀ menu's "About" row (both desktop and mobile — on mobile it
// occupies the slot Explain would, since Explain has no hover branch there)
// and, during a floor-mode Explain program, from the "About all.haus" button
// that replaces the wordmark. Wraps the same AboutContent the standalone
// /about page renders, in the canonical frosted overlay, so the ForallMenu
// chrome stays crisp above it and Esc/✕/scrim-click all dismiss it; on mobile
// it is a full-screen sheet the disc-X minimises.
// =============================================================================

import { useAboutOverlay } from "../../stores/aboutOverlay";
import { Glasshouse } from "./Glasshouse";
import { AboutContent } from "../../app/about/AboutContent";

export function AboutOverlay() {
  const isOpen = useAboutOverlay((s) => s.isOpen);
  const close = useAboutOverlay((s) => s.close);
  if (!isOpen) return null;

  // 640px = the article max-width AboutContent already sets internally; the
  // inner scroll region fills the pane against --gh-h (the canonical body-owns-
  // its-scroll pattern). AboutContent's own padding carries the reading rhythm.
  return (
    <Glasshouse onClose={close} maxWidth={640} ariaLabel="About all.haus">
      <div className="overflow-y-auto max-h-[var(--gh-h)]">
        <AboutContent />
      </div>
    </Glasshouse>
  );
}
