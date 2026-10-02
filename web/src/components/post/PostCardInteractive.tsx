"use client";

import React from "react";
import { resolveSpec } from "../../lib/post/level-spec";
import type { Level, Post } from "../../lib/post/types";
import { usePostInteractions } from "../../hooks/usePostInteractions";
import { PostCard } from "./PostCard";
import type { CardContext } from "./chassis";
import { InlineReplyBox } from "../workspace/InlineReplyBox";
import { NativeReplyBox } from "./NativeReplyBox";
import { replyTargetFromPost } from "../../lib/post/reply-target";
import {
  DELETE_REPLY_TITLE,
  DELETE_REPLY_BODY,
  DELETE_LABEL,
  DELETE_REPLY_FAILED,
} from "../../content/conversation";
import { useConfirm } from "../ui/ConfirmDialog";
import { replies as repliesApi } from "../../lib/api";
import { useThreadRefresh } from "../../stores/threadRefresh";

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
// REPLY IS THE BOX ITSELF, NOT A CALLBACK — the same move `ReportButton` made
// one component over. A reply is written IN SITU, in the card's footer, so the
// card owns the whole act: it builds its own target (`replyTargetFromPost`,
// the one home, whose `null` for a post with no author pubkey is also the
// affordance's gate) and mounts the box. Six hosts each wired a `replyFromPost`
// that opened a Glasshouse over the floor; there is no longer an `onReply` prop
// for a host to pass, correctly or otherwise. The two Glasshouse composers keep
// NOTE and QUOTE — new top-level posts, which do deserve the screen.
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
  onQuote?: () => void;
  onExpand?: (post: Post) => void;
  onCollapse?: (post: Post) => void;
  onReroot?: (post: Post) => void;
  onQuoteOpen?: (quotedPostId: string) => void;
  onOpenReader?: (post: Post) => void;
  isOwnContent?: boolean;
  replyingTo?: { name: string } | null;
}) {
  const { post, level, ctx, expanded = false, ...rest } = props;
  const spec = resolveSpec(level, post.biddabilityTier, post);
  const interactions = usePostInteractions(post, {
    expanded,
    interactBack: spec.interactBack,
  });

  // The native reply target, and the gate on the affordance: `null` for any
  // post without an author pubkey (every external one), which is exactly the
  // set that replies through the interact-back box instead.
  const replyTarget = React.useMemo(() => replyTargetFromPost(post), [post]);
  const [nativeReplyOpen, setNativeReplyOpen] = React.useState(false);

  // DELETE IS YOURS, AND ONLY ON A REMARK. A native comment (`conversation`
  // present) that the viewer wrote, not already deleted. The conversation
  // refetches in place through the same addressed tick a new reply uses, so
  // the card comes back as the projector's `[deleted]` wherever it is shown.
  const { ask, dialog: confirmDialog } = useConfirm();
  const [deleteError, setDeleteError] = React.useState<string | null>(null);
  const conversation = post.conversation;
  const onDelete =
    conversation && props.isOwnContent && !post.isDeleted
      ? async (anchor: HTMLElement) => {
          const ok = await ask(anchor, {
            title: DELETE_REPLY_TITLE,
            body: DELETE_REPLY_BODY,
            confirmLabel: DELETE_LABEL,
          });
          if (!ok) return;
          setDeleteError(null);
          try {
            await repliesApi.deleteReply(conversation.commentId);
            useThreadRefresh.getState().bump(conversation.rootEventId);
          } catch {
            setDeleteError(DELETE_REPLY_FAILED);
          }
        }
      : undefined;

  // Both inline reply boxes live in the footer slot — one card, one place a
  // reply is written. They are mutually exclusive by construction: a post with
  // an external item id has no author pubkey and so no native target.
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
    ) : nativeReplyOpen && replyTarget ? (
      <NativeReplyBox
        target={replyTarget}
        palette={ctx.palette}
        onClose={() => setNativeReplyOpen(false)}
        // A REPLY MUST LAND SOMEWHERE THE WRITER CAN SEE IT. `publishReply`
        // already refetches every mounted conversation containing the target
        // (`stores/threadRefresh`) — which is the whole feedback on an
        // expanded card. On a COLLAPSED one there is nothing to refetch, so
        // the card opens its conversation, where the reply now is. Only when
        // it is closed and only where the host offers an expand: a thread node
        // is already inside the conversation it just joined.
        onPublished={() => {
          if (!expanded) props.onExpand?.(post);
        }}
      />
    ) : deleteError ? (
      <p className="mt-2 text-ui-xs" style={{ color: "var(--ah-crimson)" }}>
        {deleteError}
      </p>
    ) : undefined;

  return (
    <>
    <PostCard
      post={post}
      level={level}
      ctx={ctx}
      interactions={interactions}
      footer={footer}
      {...rest}
      // After the spread deliberately: the card's own reply, and no host's.
      onReply={
        replyTarget ? () => setNativeReplyOpen((open) => !open) : undefined
      }
      onDelete={onDelete ? (a) => void onDelete(a) : undefined}
    />
    {confirmDialog}
    </>
  );
}
