"use client";

// =============================================================================
// ProfileOverlay — the single profile environment, opened over whatever surface
// the user is on. Driven by the useProfile store; mounted once globally in
// LayoutShell so any byline / profile link sitewide (ProfileLink) opens it in
// place. Renders, by target kind:
//   - native   → NativeProfilePanel (writer header + WriterActivity, by username)
//   - external → AuthorProfileView  (tier-A/B constructed profile, by author id)
// backed by a real URL (the store pushes /<username> or /author/<id>), so Back /
// Esc / scrim all close and restore the prior URL. Direct visits render the same
// profiles full-page ([username], author/[authorId]).
// =============================================================================

import { useEffect, useRef } from "react";
import { usePathname } from "next/navigation";
import { useProfile } from "../../stores/profileOverlay";
import { Glasshouse } from "./Glasshouse";
import { NativeProfilePanel } from "../profile/NativeProfilePanel";
import { PROFILE_PANE_WIDTH, profilePalette } from "../profile/ProfileChrome";
import { VESSEL_WALL } from "./tokens";
import { useResolvedDark } from "../../stores/colorScheme";
import { AuthorProfileView } from "../../app/author/[authorId]/AuthorProfileView";

export function ProfileOverlay() {
  const {
    isOpen,
    target,
    close,
    dismiss,
    _handlePop,
    frameScheme,
    enterFrom,
    focus,
    tab,
  } = useProfile();
  // The pane's own palette, so the ⊓ takes the SAME walls the tier-1 bar is
  // painted in and the two read as one vessel. Off a feed that is the feed's
  // colourway; elsewhere the global content palette, whose walls are ink — so
  // the profile always draws the house's ⊓ rather than only when a feed
  // happened to launch it.
  const dark = useResolvedDark();
  const palette = profilePalette(frameScheme, dark);

  // Glasshouse owns the chrome, Escape, and scroll-lock. We keep two URL-sync
  // concerns: (1) browser Back pops our pushed entry → _handlePop finalises
  // close on popstate; (2) a link *inside* the overlay (an article opening at
  // /article·/reader) router-navigates away — pathname leaves our target, so we
  // dismiss without fighting that navigation's own history entry.
  useEffect(() => {
    if (!isOpen) return;
    window.addEventListener("popstate", _handlePop);
    return () => window.removeEventListener("popstate", _handlePop);
  }, [isOpen, _handlePop]);

  const pathname = usePathname();
  // Only dismiss on navigation *after* the pushed URL has settled to our target,
  // so the initial open (pathname still on the prior surface for a tick) doesn't
  // self-dismiss.
  const settledRef = useRef(false);
  useEffect(() => {
    if (!isOpen || !target) {
      settledRef.current = false;
      return;
    }
    const targetPath =
      target.kind === "native"
        ? `/${target.username}`
        : `/author/${target.authorId}`;
    const current = decodeURIComponent(pathname ?? "");
    if (current === targetPath) {
      settledRef.current = true;
    } else if (settledRef.current) {
      dismiss();
    }
  }, [pathname, isOpen, target, dismiss]);

  if (!isOpen || !target) return null;

  return (
    <Glasshouse
      onClose={close}
      onSupersede={dismiss}
      // The profile is the second Glasshouse handoff on the platform (the
      // note→article escalation is the first): a byline inside the reader, and
      // a notification row inside the Messages inbox, both open this pane IN
      // THE PLACE OF the one the click was made in. Null off a pane, and the
      // arrival is unchanged there.
      enterFrom={enterFrom}
      selfHistory
      // One home with the standalone pages' column, so the two registers of one
      // surface cannot drift in width (`PROFILE_PANE_WIDTH`).
      maxWidth={PROFILE_PANE_WIDTH}
      ariaLabel="Profile"
      persistKey="profile"
      frameColor={palette.walls}
      // Tier 1 IS the top of the frame now (PROFILE-PANE-REDESIGN-ADR W3/D10),
      // so the ⊓'s top stroke would only draw a second, thinner bar over it,
      // and the pane's own ✕ — coloured for a white pane — would sit
      // low-contrast on the band and hover darker. The side rules stay, and
      // since they are now drawn in the SAME palette's walls as the bar itself,
      // the bar reads as the ⊓'s thick top rather than a slab dropped into a
      // frame of some other colour (D2 as amended).
      frameTopSlot
      // The rules are the VESSEL'S wall, not the reader's thinner echo of it
      // (§9.2): this pane is a feed, so it takes the feed's 8px. `PROFILE_INSET`
      // is `VESSEL_WALL + VESSEL_PAD` for the same reason — the frame is an
      // overlay in the pane's edge gutter, so the tiers inset past it.
      frameSideWidth={VESSEL_WALL}
      hideClose
      // Tier 1 IS the handle (Q5): the grip pill was a light fleck floating on
      // the band, and the bar is what a window is dragged by everywhere else.
      // Nominating it also buys back the drag area the bar had lost — the h1 is
      // a block element across the row, so bare-chrome dragging was the padding
      // strips alone. The pfp button, the handle link and the action buttons
      // still win over the handle (isDragSurface walks NO_DRAG_SELECTOR first).
      dragHandleSelector=".ah-profile-bar"
      // The profile opens to the window bottom by default (2026-08-28): it is a
      // reading surface — a bio and then an unbounded log — and a pane sized to
      // its content stopped short of the floor at a different place for every
      // person. `fillHeight` is only a DEFAULT; a dragged position still
      // re-derives the room below it.
      fillHeight
    >
      {/* The scroll body carries NO horizontal padding: tier 1 is full-bleed,
          and a pad here would inset the bar and leave a stripe of pane down
          each side of it. The tiers own their own insets (D9). The base Explain
          kind rides ProfileSurface, which both branches render. */}
      {/* `h-`, not `max-h-`: with fillHeight the pane already reaches the
          window bottom, so the scroll region must FILL it — capped, the body
          would stop at its content and leave a pale slab of bare pane beneath a
          short profile. The bodies pass minHeight="100%" for the same reason. */}
      <div className="overflow-y-auto h-[var(--gh-h)]">
        {target.kind === "native" ? (
          <NativeProfilePanel
            username={target.username}
            onClose={close}
            scheme={frameScheme}
            focus={focus}
            tab={tab}
          />
        ) : (
          <AuthorProfileView
            authorId={target.authorId}
            inOverlay
            onClose={close}
            scheme={frameScheme}
          />
        )}
      </div>
    </Glasshouse>
  );
}
