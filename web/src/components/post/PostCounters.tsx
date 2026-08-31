"use client";

import React from "react";
import type { Post } from "../../lib/post/types";
import type { VesselPalette } from "../workspace/tokens";
import type { PostInteractions } from "../../hooks/usePostInteractions";

// =============================================================================
// PostCounters — the ORIGIN platform's like/reply/repost tallies (external only).
//
// Two modes of operation:
//  - READ-ONLY (no `interactions`): renders post.originCounts as static numerals.
//    Native (§6) and tiers without origin counters are collapsed to "none" by
//    resolveSpec, so this only shows for external where counts exist.
//  - INTERACTIVE (`interactions` present): renders the fused count+action row
//    (heart / reply / repost buttons), the parity successor to VesselCard's
//    EngagementRow — counts come from interactions.liveCounts (fresh-on-expand +
//    optimistic deltas) and the buttons drive origin interact-back.
//
//   "static" / "fresh-on-expand" → full row | "inline-numerals" (condensed) → compact
// =============================================================================

type CountersMode = "fresh-on-expand" | "static" | "inline-numerals" | "none";

export function PostCounters({
  post,
  mode,
  palette,
  interactions,
}: {
  post: Post;
  mode: CountersMode;
  palette: VesselPalette;
  interactions?: PostInteractions;
}) {
  const counts = interactions?.liveCounts ?? post.originCounts;
  if (mode === "none" || !counts) return null;

  const proto = post.origin.protocol;
  const hideRepost = proto === "nostr_external" || proto === "rss" || proto === "email";
  const hideLike = proto === "rss" || proto === "email";
  const hideReply = proto === "rss" || proto === "email";

  // Interactive row (parity with EngagementRow) when the post can interact back.
  if (interactions && mode !== "inline-numerals") {
    return (
      <InteractiveRow
        counts={counts}
        palette={palette}
        interactions={interactions}
        hideLike={hideLike}
        hideReply={hideReply}
        hideRepost={hideRepost}
      />
    );
  }

  const { like, reply, repost } = counts;
  const parts: string[] = [];
  if (!hideLike && like > 0) parts.push(`♥ ${like}`);
  if (!hideReply && reply > 0) parts.push(`↩ ${reply}`);
  if (!hideRepost && repost > 0) parts.push(`⇄ ${repost}`);
  if (parts.length === 0) return null;

  const inline = mode === "inline-numerals";
  return (
    <div
      className={`font-mono text-mono-xs uppercase tracking-[0.02em] ${inline ? "" : "mt-2"} flex items-center gap-3`}
      style={{ color: palette.cardMeta }}
    >
      {parts.map((p) => (
        <span key={p}>{p}</span>
      ))}
    </div>
  );
}

function InteractiveRow({
  counts,
  palette,
  interactions,
  hideLike,
  hideReply,
  hideRepost,
}: {
  counts: { like: number; reply: number; repost: number };
  palette: VesselPalette;
  interactions: PostInteractions;
  hideLike: boolean;
  hideReply: boolean;
  hideRepost: boolean;
}) {
  const { liked, reposted, onLike, onRepost, onToggleReply, likeDisabled, repostDisabled, replyDisabled } =
    interactions;
  const showLike = !hideLike && (counts.like > 0 || !!onLike);
  const showReply = !hideReply && (counts.reply > 0 || !!onToggleReply);
  const showRepost = !hideRepost && (counts.repost > 0 || !!onRepost);
  if (!showLike && !showReply && !showRepost) return null;

  return (
    <div
      onClick={(e) => e.stopPropagation()}
      className="flex items-center gap-3 mt-2 font-mono text-mono-xs uppercase tracking-[0.02em]"
      style={{ color: palette.cardMeta }}
    >
      {showLike && (
        <button
          type="button"
          onClick={onLike}
          disabled={!onLike || liked}
          className="flex items-center gap-1 hover:opacity-80 disabled:opacity-50"
          style={{
            background: "none",
            border: "none",
            padding: 0,
            cursor: onLike && !liked ? "pointer" : "default",
            color: liked ? palette.crimson : palette.cardMeta,
          }}
          title={likeDisabled ? "Connect account to interact" : liked ? "Liked" : "Like"}
        >
          <svg width="12" height="12" viewBox="0 0 24 24" fill={liked ? "currentColor" : "none"} stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
            <path d="M20.84 4.61a5.5 5.5 0 0 0-7.78 0L12 5.67l-1.06-1.06a5.5 5.5 0 0 0-7.78 7.78l1.06 1.06L12 21.23l7.78-7.78 1.06-1.06a5.5 5.5 0 0 0 0-7.78z" />
          </svg>
          {counts.like > 0 && counts.like}
        </button>
      )}
      {showReply && (
        <button
          type="button"
          onClick={onToggleReply}
          disabled={!onToggleReply}
          className="flex items-center gap-1 hover:opacity-80 disabled:opacity-50"
          style={{
            background: "none",
            border: "none",
            padding: 0,
            cursor: onToggleReply ? "pointer" : "default",
            color: palette.cardMeta,
          }}
          title={replyDisabled ? "Connect account to interact" : "Reply"}
        >
          <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
            <path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z" />
          </svg>
          {counts.reply > 0 && counts.reply}
        </button>
      )}
      {showRepost && (
        <button
          type="button"
          onClick={onRepost}
          disabled={!onRepost || reposted}
          className="flex items-center gap-1 hover:opacity-80 disabled:opacity-50"
          style={{
            background: "none",
            border: "none",
            padding: 0,
            cursor: onRepost && !reposted ? "pointer" : "default",
            color: reposted ? palette.crimson : palette.cardMeta,
          }}
          title={repostDisabled ? "Connect account to interact" : reposted ? "Reposted" : "Repost"}
        >
          <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
            <polyline points="17 1 21 5 17 9" />
            <path d="M3 11V9a4 4 0 0 1 4-4h14" />
            <polyline points="7 23 3 19 7 15" />
            <path d="M21 13v2a4 4 0 0 1-4 4H3" />
          </svg>
          {counts.repost > 0 && counts.repost}
        </button>
      )}
    </div>
  );
}
