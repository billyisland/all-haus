"use client";

import React from "react";
import { QuotedPostTile } from "../workspace/QuotedPostTile";
import { truncateText } from "../../lib/format";
import { safeHttpUrl } from "../../lib/external-links";
import type { Post } from "../../lib/post/types";
import type { VesselPalette } from "../workspace/tokens";

// =============================================================================
// QuotedEmbed — the depth-1 quoted post (§4 quote-embed row).
//
//   "full-child" (focal) → rendered as "mini" THIS PHASE. The §4.1 promotion to
//        a full feed-level child needs the /thread quote resolution (Phase 3);
//        documented scope cut.
//   "mini" (feed/parent/reply) → quoted-level mini (byline + body only).
//   "stub" / "none" (quoted/condensed) → a "quoted a post →" stub, or nothing.
//
// External quotes hydrate async via QuotedPostTile (keyed on the host item id).
// Native quotes render from the inline quotedPreview the adapter carries.
//
// `expanded` is the HOST's state, not the quote's: when the host card renders its
// own body in full, the inset renders untruncated too, so following a quoted note
// never requires opening it (which re-roots the thread away from the conversation
// the reader expanded the card to read). PostCard derives it from the host's
// resolved body mode.
// =============================================================================

type QuoteMode = "full-child" | "mini" | "stub" | "none";

export function QuotedEmbed({
  post,
  mode,
  expanded,
  palette,
  onQuoteOpen,
}: {
  post: Post;
  mode: QuoteMode;
  // The HOST card renders its own body in full ⇒ so does this quote.
  expanded?: boolean;
  palette: VesselPalette;
  // Re-root onto the quoted post (the host wires this to thread.reroot, or to
  // expand-as-fresh-focal on a collapsed feed card). When absent the quote tile
  // stays static. The id is the quoted post's deterministic post_id, carried on
  // the host as `post.quotes`.
  onQuoteOpen?: (quotedPostId: string) => void;
}) {
  if (mode === "none" || !post.quotes) return null;
  const quotedId = post.quotes;

  // In-place focus wins over any origin permalink: whenever the host wires
  // onQuoteOpen, a quote tile — native or external — focuses the quoted post
  // (re-root / fresh focal). The origin link stays reachable from the focused
  // post's own source-attribution line. stopPropagation throughout so the host
  // card's own click (expand/re-root) never fires from the tile.
  const openQuoted = onQuoteOpen ? () => onQuoteOpen(quotedId) : undefined;

  if (mode === "stub") {
    return (
      <button
        type="button"
        onClick={(e) => {
          e.stopPropagation();
          openQuoted?.();
        }}
        className="font-mono text-mono-xs uppercase tracking-[0.06em] mt-2 hover:opacity-80"
        style={{ background: "none", border: "none", padding: 0, cursor: openQuoted ? "pointer" : "default", color: palette.cardMeta }}
      >
        Quoted a post →
      </button>
    );
  }

  // External: async tile by the external_items id (full-child folds to mini this
  // phase). Must key on externalItemId — the /external-items/:id/quote endpoint
  // looks up `external_items WHERE id = $1`. feedItemId is the feed_items uuid
  // (a different id-space) and 404s, leaving the tile silently empty.
  const native = post.origin.protocol === "nostr" && !!post.author.pubkey;
  if (!native) {
    if (!post.externalItemId) return null;
    return (
      <QuotedPostTile
        itemId={post.externalItemId}
        expanded={expanded}
        palette={palette}
        onOpen={openQuoted}
      />
    );
  }

  // Native: render the inline preview as a quoted-level mini.
  const preview = post.quotedPreview;
  if (!preview || (!preview.title && !preview.excerpt)) {
    return (
      <button
        type="button"
        onClick={(e) => {
          e.stopPropagation();
          openQuoted?.();
        }}
        className="font-mono text-mono-xs uppercase tracking-[0.06em] mt-2 hover:opacity-80"
        style={{ background: "none", border: "none", padding: 0, cursor: openQuoted ? "pointer" : "default", color: palette.cardMeta }}
      >
        Quoted a post →
      </button>
    );
  }

  // Byline reads "Author · SOURCE" for an external quote (migration 102); native
  // quotes carry no source.
  const byline = [preview.author, preview.source].filter(Boolean).join(" · ");

  const inner = (
    <>
      {byline && (
        <div
          className="font-mono text-mono-xs uppercase tracking-[0.06em]"
          style={{ color: palette.quoteMeta }}
        >
          {byline}
        </div>
      )}
      {preview.title && (
        <div className="font-serif" style={{ color: palette.quoteText, fontSize: 14, marginTop: 2 }}>
          {preview.title}
        </div>
      )}
      {preview.excerpt && (
        <div
          className="whitespace-pre-wrap break-words"
          style={{ color: palette.quoteText, fontSize: 13, lineHeight: 1.5, marginTop: 2 }}
        >
          {expanded ? preview.excerpt : truncateText(preview.excerpt, 160)}
        </div>
      )}
    </>
  );

  // Interactive host (feed card / thread node): the tile focuses the quoted post
  // in place — the same grammar as QuotedPostTile's onOpen.
  if (openQuoted) {
    return (
      <div
        role="button"
        tabIndex={0}
        aria-label={`Open quoted post${preview.author ? ` by ${preview.author}` : ""}`}
        onClick={(e) => {
          e.stopPropagation();
          openQuoted();
        }}
        onKeyDown={(e) => {
          if (e.key === "Enter" || e.key === " ") {
            e.preventDefault();
            e.stopPropagation();
            openQuoted();
          }
        }}
        className="mt-2 cursor-pointer hover:opacity-90"
        style={{ background: palette.quoteBg, padding: "10px 12px" }}
      >
        {inner}
      </div>
    );
  }

  // Static context (no onQuoteOpen): an external quote with a permalink links
  // out to the origin. Click must not bubble to the card. Only http(s) is a
  // permitted href. This was the ONLY sink in the tree carrying that gate, and
  // its comment claimed "the gateway already enforces this", which was untrue
  // for as long as it stood (MIRROR-AUDIT-2026-09-08 §2.3). Both ends now do:
  // the writers refuse a non-http(s) value at persistence, and every render
  // sink goes through this one helper (web/tests/href-guard.test.ts).
  const safeUrl = safeHttpUrl(preview.url);
  if (safeUrl) {
    return (
      <a
        href={safeUrl}
        target="_blank"
        rel="noopener noreferrer"
        onClick={(e) => e.stopPropagation()}
        className="mt-2 block hover:opacity-90"
        style={{ background: palette.quoteBg, padding: "10px 12px" }}
      >
        {inner}
      </a>
    );
  }

  return (
    <div
      className="mt-2"
      style={{ background: palette.quoteBg, padding: "10px 12px" }}
    >
      {inner}
    </div>
  );
}
