"use client";

import React from "react";
import { VoteControls } from "../ui/VoteControls";
import { ReportButton } from "../ui/ReportButton";
import type { Post } from "../../lib/post/types";
import type { VesselPalette } from "../workspace/tokens";

// =============================================================================
// PostActions — the all.haus reaction row (vote / reply / quote / report).
//
// §7: the all.haus scoresheet is minted for EVERY THING, so votes are available
// at every tier. Native content votes through the existing VoteControls (keyed on
// the nostr event id = post.version). Reply and Quote open the workspace composer
// (Quote → a NIP-18 quote note embedding this post); both are native-only and so
// are supplied by the host only when the post carries an author pubkey.
//
// haus mode:  "full" → buttons | "numerals-only" (condensed) → tally numeral only
//             | "none" (quoted) → nothing.
//
// REPORT IS THE PANEL ITSELF, NOT A CALLBACK (L6.3). It used to be a button
// calling `onReport`, and NOTHING ON THE SITE EVER PASSED ONE: not the
// workspace, not the thread, not the author page. So on every card the site
// renders, the control drew itself `disabled` and did nothing — a report
// control that is present, greyed and inert on every post is worse than an
// absent one, because it reads as a platform that has switched reporting off.
// Mounting `ReportButton` here removes the prop chain that was never wired and
// makes the affordance a fact about the component rather than a promise about
// its host. Its trigger takes this row's mono-caps register through
// `triggerClassName`, which is the seam that component already had.
//
// IT REPORTS THE POST BY BOTH OF ITS NAMES. `post.id` is `feed_items.post_id`,
// which every card carries — native or external — and is what makes an
// external card reportable at all. `post.version` is the Nostr event id on a
// native post and is what the REMOVAL path resolves by, so sending it too is
// what lets an operator act on a native report in one step rather than looking
// the event up. External posts carry no event id and send none: we do not host
// them and cannot tombstone them, which is exactly what the gateway refuses.
// =============================================================================

type HausMode = "full" | "numerals-only" | "none";

const ACTION_CLS =
  "font-mono text-mono-xs uppercase tracking-[0.02em] hover:opacity-80";

export function PostActions({
  post,
  haus,
  showReport,
  palette,
  density,
  isOwnContent,
  onReply,
  onQuote,
  onDelete,
}: {
  post: Post;
  haus: HausMode;
  showReport: boolean;
  palette: VesselPalette;
  density: string;
  isOwnContent?: boolean;
  onReply?: () => void;
  onQuote?: () => void;
  // Your own native comment only — the host decides (PostCardInteractive), and
  // passes the pressed control so the confirm can anchor off it.
  onDelete?: (anchor: HTMLElement) => void;
}) {
  if (density !== "standard") return null;
  if (haus === "none") return null;

  if (haus === "numerals-only") {
    const net = post.scoresheet.up - post.scoresheet.down;
    return (
      <span
        className="font-mono text-mono-xs uppercase tracking-[0.02em]"
        style={{ color: palette.cardMeta }}
      >
        {net > 0 ? `+${net}` : net}
      </span>
    );
  }

  const native = post.origin.protocol === "nostr" && !!post.author.pubkey;

  // YOU MAY READ A GATED CONVERSATION; YOU MAY NOT ADD TO IT.
  // ARTICLE-HEADED-CONVERSATIONS-ADR D6. On a post whose conversation ROOT is
  // paywalled and unreadable by this viewer, reply, quote and vote are absent —
  // SUPPRESSED, not drawn dead: an affordance that cannot work does not appear
  // (web/CLAUDE.md, "a permissions state must not wear an outage's words").
  // The head article card is included: a reader who cannot read the piece has
  // no business voting on it. What it keeps is its click — `reader-pane`, which
  // is the conversion path the whole policy is built on.
  //
  // `=== true` and not falsiness: the field is optional and ABSENT means nobody
  // resolved access for this post (every feed and log), which is not `false`.
  //
  // This is the UI half only. The write path is closed server-side and
  // independently — POST /replies 403s a gated target (D7) — because a UI rule
  // is not an access control. Quote needs no server twin: what it can carry is
  // `content_free` by construction (quote-preview.ts), the same free portion
  // the head card renders.
  const locked = post.rootLocked === true;
  // Report survives: reporting is not participation, and a reader who can see
  // the conversation must be able to report what is in it.

  return (
    <div
      onClick={(e) => e.stopPropagation()}
      className="flex items-center gap-3 mt-3 label-ui"
      style={{ color: palette.cardMeta }}
    >
      {native && post.version && !locked && (
        <VoteControls
          targetEventId={post.version}
          targetKind={post.type === "article" ? 30023 : 1}
          isOwnContent={!!isOwnContent}
          palette={palette}
        />
      )}
      {onReply && !locked && (
        <button
          type="button"
          onClick={onReply}
          data-explain="card.reply"
          className={ACTION_CLS}
          style={{ background: "none", border: "none", padding: 0, cursor: "pointer", color: palette.cardMeta }}
        >
          Reply
        </button>
      )}
      {onQuote && !locked && (
        <button
          type="button"
          onClick={onQuote}
          data-explain="card.quote"
          className={ACTION_CLS}
          style={{ background: "none", border: "none", padding: 0, cursor: "pointer", color: palette.cardMeta }}
        >
          Quote
        </button>
      )}
      {onDelete && (
        <button
          type="button"
          onClick={(e) => onDelete(e.currentTarget)}
          className={ACTION_CLS}
          style={{ background: "none", border: "none", padding: 0, cursor: "pointer", color: palette.cardMeta }}
        >
          Delete
        </button>
      )}
      {showReport && !isOwnContent && (
        // Not on your own post: there is nobody to report it to. The other
        // actions stay (you may reply to and quote yourself), so this is the
        // one place the row asks whose post it is.
        <span style={{ color: palette.cardMeta }}>
          <ReportButton
            targetPostId={post.id}
            // The event id is sent for a NATIVE card only: on an external one
            // `version` is a content hash (§2.4), and a hash filed as an event
            // id resolved the report as native content that matched nothing
            // (§0z item 6). The post id is what the gateway resolves by first
            // either way; the event id is the content's own identity beside it.
            targetNostrEventId={native ? (post.version ?? undefined) : undefined}
            triggerClassName={`${ACTION_CLS} bg-transparent border-0 p-0 cursor-pointer`}
          />
        </span>
      )}
    </div>
  );
}
