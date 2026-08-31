"use client";

// =============================================================================
// ProfileLink — the sitewide profile affordance.
//
// Renders a real <Link> to the profile's canonical URL (so SSR, cmd/middle-click
// "open in new tab", and right-click "copy link" all work), but intercepts a
// plain left-click to open the URL-synced profile overlay (useProfile) in place
// instead of navigating away. The overlay pushes the same URL into history, so
// Back closes it and a refresh resolves to the full page.
//
// The target kind is derived from the href alone — /author/:id → external,
// /:username → native — so this is a drop-in for any existing
// `<Link href={profilePath}>`.
//
// THE CANONICAL NATIVE PROFILE URL HAS NO `@`. It is `/:username`, which is
// what the gateway's own `profilePath` emits (`lib/author-resolve.ts`) and what
// the `app/[username]` route serves. The `@?` in the matcher below is TOLERANCE
// ON THE OVERLAY PATH ONLY and must not be read as a second supported form:
// four call sites once built `href={`/@${username}`}`, and because this matcher
// quietly stripped the `@`, a plain left-click opened the overlay perfectly
// while new-tab, copy-link and every crawler got a 404 from the real route
// (§0q.3). All four were corrected; nothing should emit an `@` again.
// =============================================================================

import Link from "next/link";
import type { ComponentProps, MouseEvent } from "react";
import { useProfile } from "../../stores/profileOverlay";
import type { FeedScheme } from "../workspace/tokens";

/** Classify a profile href into an overlay target, or null if it isn't one. */
export function profileTargetFromHref(
  href: string,
):
  | { kind: "native"; username: string }
  | { kind: "external"; authorId: string }
  | null {
  const ext = href.match(/^\/author\/([^/?#]+)/);
  if (ext) return { kind: "external", authorId: decodeURIComponent(ext[1]) };
  // Root-level /:username — the native profile route. The optional `@` is
  // tolerance for a malformed href, not a supported URL form (see the header).
  const native = href.match(/^\/@?([^/?#]+)/);
  if (native && native[1]) return { kind: "native", username: native[1] };
  return null;
}

/** Open the profile overlay for a profile href. Returns true if it handled it.
 *  `frameScheme` (the launching feed's COLOURWAY, `palette.scheme`) is passed
 *  through when the profile was opened from a feed card, so the pane wears that
 *  feed's scheme entire; omit it elsewhere and the pane takes the global
 *  content palette. */
export function openProfileHref(
  href: string,
  frameScheme?: FeedScheme | null,
): boolean {
  const target = profileTargetFromHref(href);
  if (!target) return false;
  if (target.kind === "external")
    useProfile.getState().openExternal(target.authorId, frameScheme);
  else useProfile.getState().openNative(target.username, frameScheme);
  return true;
}

/** True for clicks that should keep the browser's default link behaviour
 *  (new tab / new window / non-primary button). */
export function isModifiedClick(e: MouseEvent): boolean {
  return e.metaKey || e.ctrlKey || e.shiftKey || e.altKey || e.button !== 0;
}

type ProfileLinkProps = Omit<ComponentProps<typeof Link>, "href"> & {
  href: string;
  /** The launching feed's COLOURWAY, forwarded to `openProfileHref` so the
   *  profile pane wears that feed entire (D2 as amended). The card byline and
   *  AuthorModal call `openProfileHref` directly and have always passed it;
   *  this makes the same thing reachable from the component. */
  frameScheme?: FeedScheme | null;
};

export function ProfileLink({
  href,
  onClick,
  frameScheme,
  ...rest
}: ProfileLinkProps) {
  return (
    <Link
      href={href}
      onClick={(e) => {
        onClick?.(e);
        if (e.defaultPrevented || isModifiedClick(e)) return;
        if (openProfileHref(href, frameScheme)) e.preventDefault();
      }}
      {...rest}
    />
  );
}
