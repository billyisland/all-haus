"use client";

import React from "react";
import { resolveSpec } from "../../lib/post/level-spec";
import { explainCardFlavour } from "../../lib/explain/registry";
import type { Level, Post } from "../../lib/post/types";
import { PostCardShell, type CardContext, type PipOpen } from "./chassis";
import { PostByline } from "./PostByline";
import { PostBody } from "./PostBody";
import { PostMedia } from "./PostMedia";
import { QuotedEmbed } from "./QuotedEmbed";
import { PostCounters } from "./PostCounters";
import { PostActions } from "./PostActions";
import { PostOriginTag } from "./PostOriginTag";
import type { PostInteractions } from "../../hooks/usePostInteractions";

// =============================================================================
// PostCard — the ONE card. Renders a Post at any §3 level via the §4 matrix.
//
// UNIVERSAL-POST-ADR Phase 2. The level + tier resolve once (resolveSpec) into a
// flat spec; the dumb leaf components each receive resolved values, never the raw
// level/tier — so a Post renders identically across levels except the matrix
// deltas (text scale, indent, gap, gated affordances).
//
// This phase is RENDER-ONLY: the click callbacks are wired but the workspace
// swap (Phase-2 commit 6) mounts only level="feed" and delegates expand to the
// legacy path; thread re-root is Phase 3, the reader pane is Phase R.
// =============================================================================

// Smallest text we will render after the matrix textScale (min base 11.5 × 0.85
// ≈ 9.8); floor keeps the deepest levels legible.
const READABILITY_FLOOR_PX = 10.5;

export function PostCard({
  post,
  level,
  ctx,
  onPipOpen,
  onReply,
  onQuote,
  onReport,
  onExpand,
  onCollapse,
  onReroot,
  onQuoteOpen,
  onOpenReader,
  isOwnContent,
  interactions,
  footer,
}: {
  post: Post;
  level: Level;
  ctx: CardContext;
  onPipOpen?: PipOpen;
  onReply?: () => void;
  onQuote?: () => void;
  onReport?: () => void;
  onExpand?: (post: Post) => void;
  onCollapse?: (post: Post) => void;
  onReroot?: (post: Post) => void;
  // Re-root onto this post's quoted post (external quote tile click).
  onQuoteOpen?: (quotedPostId: string) => void;
  onOpenReader?: (post: Post) => void;
  isOwnContent?: boolean;
  // External interact-back (usePostInteractions), supplied by PostCardInteractive
  // when the card is interactive. Absent ⇒ read-only counters + read-only poll.
  interactions?: PostInteractions;
  // Slot rendered inside the shell, below the actions (inline reply box).
  // Owned by the container.
  footer?: React.ReactNode;
}) {
  const spec = resolveSpec(level, post.biddabilityTier, post);
  const bodyPx = Math.max(
    Math.round(ctx.bodyPx * spec.textScale * 10) / 10,
    READABILITY_FLOOR_PX,
  );

  // Headline density: an article is its headline and nothing else (the
  // standfirst/dek is dropped), a note is its whole body. Neither is clamped —
  // a headline that wraps is still one headline, and a truncated note in a feed
  // you chose to compress just hides the thing you compressed it to skim.
  // (Media + actions are already hidden for the condensed family; see
  // PostMedia/PostActions/chassis.)
  const bodyMode = ctx.density === "headline" ? "headline" : spec.body;

  // An inset quote's truncation follows its HOST's body, never its own level:
  // wherever the card renders its own text in full (focal, thread parent/reply),
  // the quote inside it renders in full too. A clipped inset inside an expanded
  // card is what forces the reader to open the quoted note directly — which
  // re-roots the thread onto it and takes them out of the conversation they
  // expanded the card to follow. Reading `bodyMode` rather than `spec.body`
  // keeps a headline-density vessel compressed all the way down.
  const quoteExpanded = bodyMode === "expanded";

  const pollVote = interactions
    ? {
        canVote: interactions.canVote,
        voting: interactions.pollVoting,
        onVote: interactions.onPollVote,
      }
    : undefined;

  const onClick = (() => {
    switch (spec.click) {
      case "expand-focal":
        return onExpand ? () => onExpand(post) : undefined;
      case "collapse":
        return onCollapse ? () => onCollapse(post) : undefined;
      case "reroot-focal":
        return onReroot ? () => onReroot(post) : undefined;
      case "reader-pane":
        return onOpenReader ? () => onOpenReader(post) : undefined;
      case "none":
      default:
        return undefined;
    }
  })();

  // The drag handle (drag-a-source-into-another-feed) is the row that NAMES
  // the source being moved: the byline where there is one, else — a tier-D
  // card, BYLINE-AND-PROVENANCE-ADR Q1 — the provenance line, which is the
  // only row left that names it. Scoped to level="feed" (chassis.tsx).
  const dragHandle = !!ctx.dragData && level === "feed";

  // Quoted is laid out inside its host's container — no shell, no own indent/gap.
  if (spec.insideHost) {
    return (
      <div style={{ cursor: onClick ? "pointer" : undefined }} onClick={onClick}>
        {spec.showByline && (
          <PostByline post={post} palette={ctx.palette} bylineProfile={spec.bylineProfile} showResonance={spec.showResonance} onPipOpen={onPipOpen} feedId={ctx.feedId} />
        )}
        <PostBody post={post} bodyPx={bodyPx} mode={bodyMode} palette={ctx.palette} />
        <PostMedia post={post} mode={spec.media} video={spec.video} palette={ctx.palette} density={ctx.density} />
      </div>
    );
  }

  return (
    <PostCardShell ctx={ctx} indentPx={spec.indentPx} gapBelowPx={spec.gapBelowPx} onClick={onClick} explainParam={explainCardFlavour(post)}>
      {spec.showByline && (
        <PostByline post={post} palette={ctx.palette} bylineProfile={spec.bylineProfile} showResonance={spec.showResonance} onPipOpen={onPipOpen} feedId={ctx.feedId} dragHandle={dragHandle} />
      )}
      <PostBody post={post} bodyPx={bodyPx} mode={bodyMode} palette={ctx.palette} pollVote={pollVote} />
      <PostMedia post={post} mode={spec.media} video={spec.video} palette={ctx.palette} density={ctx.density} />
      <QuotedEmbed post={post} mode={spec.quoteEmbed} expanded={quoteExpanded} palette={ctx.palette} onQuoteOpen={onQuoteOpen} />
      <PostCounters post={post} mode={spec.originCounters} palette={ctx.palette} interactions={interactions} />
      <PostActions
        post={post}
        haus={spec.haus}
        showReport={spec.showReport}
        palette={ctx.palette}
        density={ctx.density}
        isOwnContent={isOwnContent}
        onReply={onReply}
        onQuote={onQuote}
        onReport={onReport}
      />
      {spec.showOriginTag && (
        <PostOriginTag
          post={post}
          palette={ctx.palette}
          sourceOnly={spec.originTagSourceOnly}
          showPlatformMark={spec.showPlatformResonance}
          showTime={spec.originTagTime}
          dragHandle={dragHandle && !spec.showByline}
        />
      )}
      {footer}
    </PostCardShell>
  );
}
