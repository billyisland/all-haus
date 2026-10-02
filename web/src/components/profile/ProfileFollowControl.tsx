"use client";

import { useRef, useState } from "react";
import Link from "next/link";
import { useAuth } from "../../stores/auth";
import {
  useFeedFollow,
  isFeedFollowable,
  type FeedFollowTarget,
} from "../../hooks/useFeedFollow";
import { FeedFollowMenu } from "../feed/FeedFollowMenu";
import { BarButton } from "./ProfileChrome";
import { AnchoredPopover } from "../ui/AnchoredPopover";
import { Pointer } from "../ui/Pointer";
import type { VesselPalette } from "../workspace/tokens";

// =============================================================================
// ProfileFollowControl — the follow affordance for a full profile surface
// (the native profile bar, AuthorProfileView, SourceSurface).
//
// ONE CONTROL FOR BOTH KINDS OF TARGET: a "Follow ▾" menu of the viewer's
// feeds, each row toggling membership. A profile is a feed-LESS surface, so
// nothing about the context can decide which feed a follow lands in, and the
// reader is asked rather than guessed at.
//
// The native branch used to be a plain global toggle. Since the reach
// retirement (migration 177, §9.16) the `follows` row alone puts nothing in
// front of anybody, so that button wrote a relationship the reader could not
// then find — reported from the outside as "I followed someone back and I
// don't know where they ended up". §9.16's ruling (operator 2026-08-10,
// reaffirmed 2026-09-18) is that native follow takes the same branch external
// follow already took, and that the last feed leaving drops the follow. The
// mechanism is `useFeedFollow`; this file is the profile's chrome for it.
//
// Logged-out viewers get a full-page → /auth link (the workspace is login-
// gated; every logged-out follow CTA goes to /auth full-page by design).
// =============================================================================

export function ProfileFollowControl({
  target,
  palette,
}: {
  target: FeedFollowTarget;
  /** Present ⇒ the control sits on the profile's tier-1 bar, where `.btn`
   *  (ink on ink) is invisible: drive the trigger off the bar tokens instead.
   *  The open menu stays glasshouse — floating material is the outermost layer
   *  (web/CLAUDE.md) and its neutral slugs already invert with the mode. */
  palette?: VesselPalette;
}) {
  const { user, loading } = useAuth();

  if (loading) return null;
  if (!user) {
    // Logged out. D12's reasoning — "tier 1 already carries the one `Log in`
    // link" — was reversed on 2026-09-02: the profile bar carries NO action
    // logged out, because the sitewide top bar's right end IS `Log in` and the
    // two sat forty pixels apart offering the same destination. This control is
    // a different offer (follow this person, which needs an account), so it
    // keeps its own way in on the standalone author page.
    // On a BAR the offer takes the bar's own tone, never `.btn` — which is
    // ink on ink against `barBg` and vanished in dark mode. Off a bar (the
    // source surface) `.btn` is correct.
    return palette ? (
      <BarButton palette={palette} variant="primary" href="/auth">
        Log in to follow
      </BarButton>
    ) : (
      <Link href="/auth" className="btn py-1.5 px-4 text-ui-xs">
        Log in to follow
      </Link>
    );
  }

  return <FeedFollowPicker target={target} palette={palette} />;
}

function FeedFollowPicker({
  target,
  palette,
}: {
  target: FeedFollowTarget;
  palette?: VesselPalette;
}) {
  const [open, setOpen] = useState(false);
  const wrapRef = useRef<HTMLDivElement>(null);
  const state = useFeedFollow(target, open);

  // A protocol we can't add (e.g. email) has no follow gesture at all.
  if (!isFeedFollowable(target)) return null;

  const label = state.following ? "Following" : "Follow";

  // Escape and outside-click both live in `AnchoredPopover`: the panel is
  // portalled out of this subtree, so a `wrapRef.contains` test would dismiss
  // on every click INSIDE the menu.
  return (
    // The tag rides the wrapper so the trigger and the open picker both answer
    // as the one gesture. Native and external keep separate copy keys: the
    // mechanism converged, the sentence about where a follow lives has not.
    <div
      ref={wrapRef}
      data-explain={
        target.type === "user" ? "profile.follow" : "profile.followFeeds"
      }
      className="relative inline-block"
    >
      {palette ? (
        <BarButton
          palette={palette}
          variant={state.following ? "secondary" : "primary"}
          onClick={() => setOpen((o) => !o)}
        >
          {label} <Pointer direction="down" size="sm" className="ml-1" />
        </BarButton>
      ) : (
        <button
          onClick={() => setOpen((o) => !o)}
          className={`transition-colors py-1.5 px-4 text-ui-xs ${
            state.following ? "btn-soft" : "btn"
          }`}
        >
          {label} <Pointer direction="down" size="sm" className="ml-1" />
        </button>
      )}

      {/* Portalled, and `align="end"`, because this control sits at the RIGHT
          end of the profile bar: an absolute `left-0` panel ran 92px past the
          pane's edge and was sliced by its ⊓ wall. */}
      <AnchoredPopover
        anchorRef={wrapRef}
        open={open}
        onDismiss={() => setOpen(false)}
        align="end"
        width={240}
        ariaLabel="Choose which channels carry this author"
        className="p-1.5"
      >
        <FeedFollowMenu state={state} register="glasshouse" />
      </AnchoredPopover>
    </div>
  );
}
