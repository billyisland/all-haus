"use client";

// =============================================================================
// SurfaceOverlay — the single non-profile content-surface environment, opened
// over whatever surface the user is on. Driven by the useSurfaceOverlay store;
// mounted once globally in LayoutShell so a source / tag / publication link
// anywhere (e.g. the FeedComposer source rows) opens it in place rather than
// escaping the workspace to the black topbar. Renders, by target kind:
//   - source      → SourceSurface     (external feed surface, by id)
//   - tag         → TagBrowser         (tag browser, by name)
//   - publication → PublicationPanel   (publication home/about/masthead/archive)
// backed by a real URL (the store pushes /source/<id>, /tag/<name>, /pub/<slug>),
// so Back / Esc / scrim all close and restore the prior URL. Direct visits render
// the same surfaces full-page. Mirrors workspace/ProfileOverlay.tsx.
// =============================================================================

import { useEffect, useRef } from "react";
import { usePathname } from "next/navigation";
import {
  useSurfaceOverlay,
  surfacePathMatches,
} from "../../stores/surfaceOverlay";
import { Glasshouse } from "./Glasshouse";
import { SourceSurface } from "../../app/source/[id]/SourceSurface";
import { TagBrowser } from "../../app/tag/[tag]/TagBrowser";
import { PublicationPanel } from "../publication/PublicationPanel";
import { profilePalette } from "../profile/ProfileChrome";
import { useResolvedDark } from "../../stores/colorScheme";

export function SurfaceOverlay() {
  const { isOpen, target, close, dismiss, _handlePop, frameScheme } =
    useSurfaceOverlay();
  // The pane's own palette. Off a feed that is the feed's colourway (a source
  // opened from a green feed's card or from the reader bar wears the green ⊓);
  // elsewhere the global content palette, whose walls are ink — so the surface
  // always draws the house's ⊓ rather than only when a feed happened to launch
  // it. `profilePalette` is the one home for that pairing (its header): the
  // scheme branch must be islanded and the global one must not, which is why
  // only the FRAME colours are taken here and the body stays glasshouse white.
  const dark = useResolvedDark();
  const palette = profilePalette(frameScheme, dark);

  // Glasshouse owns the chrome, Escape, and scroll-lock. We keep two URL-sync
  // concerns: (1) browser Back pops our pushed entry → _handlePop finalises
  // close on popstate; (2) a link *inside* the overlay router-navigates away —
  // pathname leaves our target, so we dismiss without fighting that
  // navigation's own history entry. Mirrors ProfileOverlay.
  useEffect(() => {
    if (!isOpen) return;
    window.addEventListener("popstate", _handlePop);
    return () => window.removeEventListener("popstate", _handlePop);
  }, [isOpen, _handlePop]);

  const pathname = usePathname();
  // Only dismiss on navigation *after* the pushed URL has settled to our target,
  // so the initial open (pathname still on the prior surface for a tick) doesn't
  // self-dismiss. We match the surface's *base* path (not the exact URL) so a
  // publication switching sub-view (home↔about↔masthead↔archive) stays open and
  // only a real navigation away dismisses.
  const settledRef = useRef(false);
  useEffect(() => {
    if (!isOpen || !target) {
      settledRef.current = false;
      return;
    }
    if (surfacePathMatches(target, pathname ?? "")) {
      settledRef.current = true;
    } else if (settledRef.current) {
      dismiss();
    }
  }, [pathname, isOpen, target, dismiss]);

  if (!isOpen || !target) return null;

  const ariaLabel =
    target.kind === "source"
      ? "Source"
      : target.kind === "tag"
        ? "Tag"
        : "Publication";

  return (
    <Glasshouse
      onClose={close}
      onSupersede={dismiss}
      selfHistory
      maxWidth={780}
      ariaLabel={ariaLabel}
      persistKey="surface"
      // The ⊓, as every other over-workspace content pane draws it. Absent
      // until 2026-08-30, which is why a source opened from the reader bar
      // arrived with no frame at all while the reader it came from had one.
      frameColor={palette.walls}
      frameTextColor={palette.barText}
      // A publication's cover is flush to the pane's edges (its masthead is the
      // same block the public page carries), so scrolled content would run
      // straight under the drag grip. The seam is the pane's own background and
      // is invisible at rest — every body here keeps its own top padding clear
      // of it — so it costs the source and tag surfaces nothing and covers the
      // same collision when they scroll.
      topSeam
    >
      {/* Each surface body supplies its own inner padding (PageShell / mx-auto
          wrapper); we only own the scroll container. C4: it also carries the
          per-target base Explain kind, so all three surfaces inherit one here
          (leaves + the tagged card chassis answer first via closest). */}
      <div
        data-explain={
          target.kind === "source"
            ? "source"
            : target.kind === "tag"
              ? "tag"
              : "pub"
        }
        className="overflow-y-auto max-h-[var(--gh-h)]"
      >
        {target.kind === "source" && <SourceSurface id={target.id} />}
        {target.kind === "tag" && (
          <TagBrowser tagName={target.name.toLowerCase()} inOverlay />
        )}
        {target.kind === "publication" && (
          <PublicationPanel slug={target.slug} view={target.view} />
        )}
      </div>
    </Glasshouse>
  );
}
