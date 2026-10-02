"use client";

import Link from "next/link";
import type { ReactNode } from "react";
import { openSurfaceHref } from "../../stores/surfaceOverlay";
import { isModifiedClick } from "./ProfileLink";
import type { ExplainKind } from "../../lib/explain/registry";
import type { FeedScheme } from "../workspace/tokens";

// =============================================================================
// InwardLink — a real <Link> to an all.haus SURFACE (`/source/:id`, `/pub/:slug`,
// `/tag/:tag`), so new-tab / copy-link work, with a plain left-click intercepted
// by `openSurfaceHref` so inside the workspace it re-roots the surface overlay
// in place rather than escaping (`.claude/rules/web-overlays.md` › The escape
// ban). The surface counterpart of `ProfileLink`, which does the same for
// profile hrefs.
//
// Two homes use it: the card's provenance line (`PostOriginTag`, BYLINE-AND-
// PROVENANCE-ADR D7/D8) and the tier-C profile's "WRITING IN" line (D6, S4) —
// the same routing for the same object, so the source name never opens two
// different ways depending on which surface it was read off.
// =============================================================================

export function InwardLink({
  href,
  explain,
  className = "hover:underline",
  frameScheme,
  children,
}: {
  href: string;
  /** OPTIONAL, and absent is not a gap: a leaf with no caption of its own falls
   *  through to whatever surface it sits on (the pane's base kind, `reader`),
   *  which is the truth for the article body's own byline links. Only a leaf
   *  the Explain sequence is meant to STOP on gets a kind. */
  explain?: ExplainKind;
  className?: string;
  /** The launching feed's COLOURWAY (`palette.scheme`), handed to the surface
   *  overlay so the pane it opens wears that feed's ⊓ — the surface twin of
   *  `openProfileHref`'s third argument, which the card byline has always
   *  passed. Omit off a feed and the pane draws the house's ink ⊓. */
  frameScheme?: FeedScheme | null;
  children: ReactNode;
}) {
  return (
    <Link
      href={href}
      onClick={(e) => {
        // Don't let a host card's own click handler fire.
        e.stopPropagation();
        // Plain left-click re-roots the surface overlay in place; modified
        // clicks (new tab) fall through to the real link.
        if (!isModifiedClick(e) && openSurfaceHref(href, frameScheme)) {
          e.preventDefault();
        }
      }}
      className={className}
      style={{ color: "inherit" }}
      data-explain={explain}
    >
      {children}
    </Link>
  );
}
