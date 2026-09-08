"use client";

import React from "react";
import { VoteControls } from "../ui/VoteControls";
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
// Report is native-only and already gated by resolveSpec (showReport).
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
  onReport,
}: {
  post: Post;
  haus: HausMode;
  showReport: boolean;
  palette: VesselPalette;
  density: string;
  isOwnContent?: boolean;
  onReply?: () => void;
  onQuote?: () => void;
  onReport?: () => void;
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
      {showReport && (
        <button
          type="button"
          onClick={onReport}
          disabled={!onReport}
          className="font-mono text-mono-xs uppercase tracking-[0.02em] hover:opacity-80 disabled:opacity-50"
          style={{ background: "none", border: "none", padding: 0, cursor: onReport ? "pointer" : "default", color: palette.cardMeta }}
        >
          Report
        </button>
      )}
    </div>
  );
}
