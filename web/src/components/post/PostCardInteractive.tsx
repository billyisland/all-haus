"use client";

import React from "react";
import { resolveSpec } from "../../lib/post/level-spec";
import type { Level, Post } from "../../lib/post/types";
import { usePostInteractions } from "../../hooks/usePostInteractions";
import { PostCard } from "./PostCard";
import type { CardContext, PipOpen } from "./chassis";
import { InlineReplyBox } from "../workspace/InlineReplyBox";

// =============================================================================
// PostCardInteractive — the stateful entry point for an interactive card.
//
// UNIVERSAL-POST-ADR Phase 5. Wraps the dumb PostCard with the external
// interact-back state machine (usePostInteractions) and mounts the inline reply
// box (below the actions). Hosts (WorkspaceView feed, PostThread, /author) mount
// this anywhere a card is interactive; bare PostCard stays for
// quoted/condensed/non-interactive renders.
//
// One post per card is an absolute rule: a card never inlines another post's
// body. Reply context (the parent) is shown by expanding the card into the
// PostThread, never as a fused parent tile — so the threading grammar reads the
// same in every context.
//
// IMPORTANT: hosts must key this by `post.id` (stable across level changes) so a
// re-root that re-labels a node feed↔focal does not unmount it and lose the
// optimistic like/reply state.
// =============================================================================

export function PostCardInteractive(props: {
  post: Post;
  level: Level;
  ctx: CardContext;
  expanded?: boolean; // focal nodes are expanded (drives fresh-on-expand counters)
  onPipOpen?: PipOpen;
  onReply?: () => void;
  onQuote?: () => void;
  onReport?: () => void;
  onExpand?: (post: Post) => void;
  onCollapse?: (post: Post) => void;
  onReroot?: (post: Post) => void;
  onQuoteOpen?: (quotedPostId: string) => void;
  onOpenReader?: (post: Post) => void;
  isOwnContent?: boolean;
}) {
  const { post, level, ctx, expanded = false, ...rest } = props;
  const spec = resolveSpec(level, post.biddabilityTier, post);
  const interactions = usePostInteractions(post, {
    expanded,
    interactBack: spec.interactBack,
  });

  // Inline reply box (interact-back), mounted inside the shell below the actions.
  const footer =
    interactions.replyOpen && interactions.externalItemId ? (
      <InlineReplyBox
        itemId={interactions.externalItemId}
        protocol={interactions.protocol}
        linkedAccount={interactions.linkedAccount}
        palette={ctx.palette}
        onClose={interactions.closeReply}
        onReplied={interactions.onReplied}
      />
    ) : undefined;

  return (
    <PostCard
      post={post}
      level={level}
      ctx={ctx}
      interactions={interactions}
      footer={footer}
      {...rest}
    />
  );
}
