"use client";

// =============================================================================
// PersonCard — one person, as a card, in the profile's Followers and Following
// views (PROFILE-PANE-REDESIGN-ADR D11, as amended 2026-09-02).
//
// Those two views were the last logs on the profile still drawing rows: a
// 36px avatar on a `hover:bg-grey-100` strip, ink and grey hard-coded. Tier 4
// is a card log — `PostCardInteractive` on `palette.cardBg`, `FEED_LOG_STYLE`'s
// column — and a row rig under the same button row read as a different surface
// reached by accident. Worse, the hard-coded pair ignored the pane's palette
// entirely, so a profile opened from a green feed drew grey strips inside it and
// a dark-mode profile drew black-on-black.
//
// So the person takes the same shell the post does: `palette.cardBg`, the
// card's own 16px padding and `GAP_PX.feed` bottom margin, which is what makes
// the 20px feed rhythm when spread inside `FEED_LOG_STYLE` (§9.2).
//
// The identity block is a `ProfileLink` and the actions sit BESIDE it rather
// than inside — buttons nested in an anchor are invalid, and the Following
// view's unfollow/subscribe cluster is exactly that case. Where a card carries
// no actions the link still only spans the identity block, so the two views
// present one shape.
// =============================================================================

import type { ReactNode } from "react";
import { ProfileLink } from "../ui/ProfileLink";
import { Avatar } from "../ui/Avatar";
import { CARD_PADDING } from "../post/chassis";
import { GAP_PX } from "../../lib/post/level-spec";
import type { VesselPalette } from "../workspace/tokens";

export function PersonCard({
  palette,
  href,
  avatar,
  name,
  handle,
  badge,
  trailing,
}: {
  palette: VesselPalette;
  href: string;
  avatar: string | null;
  name: string;
  /** The `@username`, drawn under the name. Omitted for a person who has none. */
  handle?: string;
  /** A chip beside the name (the owner's "Subscriber" mark). */
  badge?: ReactNode;
  /** The card's right end: a date, or the own-profile action cluster. */
  trailing?: ReactNode;
}) {
  return (
    <div
      className="flex items-center gap-3"
      style={{
        background: palette.cardBg,
        padding: CARD_PADDING.standard,
        marginBottom: GAP_PX.feed,
      }}
    >
      <ProfileLink
        href={href}
        className="focus-ring flex items-center gap-3 min-w-0 flex-1 transition-opacity hover:opacity-80"
      >
        <Avatar src={avatar} name={name} size={40} />
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-2">
            <p
              className="text-ui-sm font-sans truncate"
              style={{ color: palette.cardTitle }}
            >
              {name}
            </p>
            {badge}
          </div>
          {handle && (
            <p
              className="text-ui-xs"
              style={{ color: palette.cardStandfirst }}
            >
              {handle}
            </p>
          )}
        </div>
      </ProfileLink>

      {trailing && (
        <div className="flex items-center gap-2 flex-shrink-0">{trailing}</div>
      )}
    </div>
  );
}
