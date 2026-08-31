"use client";

// =============================================================================
// usePostInteractions — the external interact-back state machine for the
// PostCard family (UNIVERSAL-POST-ADR Phase 5).
//
// Consolidates the interaction logic that lived inline in VesselCard
// (~1451–1667): linked-account match by protocol, optimistic like/repost with
// rollback, inline-reply open state, poll voting, and fresh-on-expand origin
// counters (useLiveEngagement). Returning one flat bag keeps the PostCard leaves
// dumb — they render what this hook decides.
//
// Scope: this is ORIGIN interact-back (push a like/reply to Bluesky/Mastodon via
// a linked account), keyed on the external_item id (post.externalItemId). It is
// NOT the all.haus scoresheet (greenfield POST /post/:postId/react, ADR §9 —
// deferred). Native posts (externalItemId === null) get an inert bag; they react
// through VoteControls (native vote) elsewhere.
//
// §7 gating: when `interactBack` is false (tiers C/D), the bag is inert. Protocol
// guards (rss/email suppress like+reply+repost; nostr_external suppresses repost)
// mirror VesselCard verbatim.
// =============================================================================

import React from "react";
import { useLinkedAccounts } from "./useLinkedAccounts";
import { useLiveEngagement } from "./useLiveEngagement";
import { externalItems } from "../lib/api/external-items";
import type { LinkedAccount } from "../lib/api";
import type { Post } from "../lib/post/types";

// Pure capability gate — the protocol guards (VesselCard verbatim) + §7
// interact-back gate, with no React. `active` = the post can interact back at
// all (has an external_item id AND interactBack). Extracted so the guard matrix
// is unit-testable without a DOM harness.
export interface InteractionCaps {
  likeAllowed: boolean; // protocol permits a like at all
  repostAllowed: boolean;
  replyAllowed: boolean;
  likeEnabled: boolean; // permitted AND a linked account is present
  repostEnabled: boolean;
  replyEnabled: boolean;
  likeDisabled: boolean; // permitted but no linked account (shows a disabled affordance)
  repostDisabled: boolean;
  replyDisabled: boolean;
}

export function interactionCaps(
  protocol: string,
  hasAccount: boolean,
  active: boolean,
): InteractionCaps {
  if (!active) {
    return {
      likeAllowed: false,
      repostAllowed: false,
      replyAllowed: false,
      likeEnabled: false,
      repostEnabled: false,
      replyEnabled: false,
      likeDisabled: false,
      repostDisabled: false,
      replyDisabled: false,
    };
  }
  const isRss = protocol === "rss";
  const isEmail = protocol === "email";
  const isNostr = protocol === "nostr_external";
  const likeAllowed = !isRss && !isEmail; // like + reply share the same suppression
  const repostAllowed = !isRss && !isEmail && !isNostr;
  const replyAllowed = !isRss && !isEmail;
  return {
    likeAllowed,
    repostAllowed,
    replyAllowed,
    likeEnabled: likeAllowed && hasAccount,
    repostEnabled: repostAllowed && hasAccount,
    replyEnabled: replyAllowed && hasAccount,
    likeDisabled: likeAllowed && !hasAccount,
    repostDisabled: repostAllowed && !hasAccount,
    replyDisabled: replyAllowed && !hasAccount,
  };
}

export interface PostInteractions {
  // external like/repost (interact-back), optimistic
  liked: boolean;
  reposted: boolean;
  onLike?: () => void; // undefined when no matching account / protocol suppressed
  onRepost?: () => void; // undefined for nostr_external / rss / email / no account
  likeDisabled: boolean;
  repostDisabled: boolean;
  // inline reply box
  replyOpen: boolean;
  onToggleReply?: () => void; // undefined for rss/email
  closeReply: () => void;
  onReplied: () => void; // bumps the optimistic reply count
  replyDisabled: boolean;
  linkedAccount: LinkedAccount | null;
  protocol: string;
  // poll voting
  canVote: boolean;
  pollVoting: boolean;
  onPollVote: (choices: number[]) => void;
  // fresh-on-expand counters, already including optimistic deltas; null when the
  // post has no origin counters to show (native, tiers C/D, or not interactive).
  liveCounts: { like: number; reply: number; repost: number } | null;
  // the external_item id these endpoints key on; null for native.
  externalItemId: string | null;
}

export function usePostInteractions(
  post: Post,
  opts: { expanded: boolean; interactBack: boolean },
): PostInteractions {
  const { expanded, interactBack } = opts;
  const externalItemId = post.externalItemId;
  const protocol = post.origin.protocol;

  // `active` = this post can interact back at all. Native (no external id) and
  // tiers without interact-back (§7) get the inert path, but every hook below
  // is still called unconditionally (rules of hooks).
  const active = !!externalItemId && interactBack;

  const linkedAccounts = useLinkedAccounts();
  const matchingAccount =
    (active &&
      linkedAccounts?.find((a) => a.protocol === protocol && a.isValid)) ||
    null;

  // Optimistic like
  const [liked, setLiked] = React.useState(false);
  const [likeDelta, setLikeDelta] = React.useState(0);
  const onLikeCb = React.useCallback(() => {
    if (!externalItemId || !matchingAccount || liked) return;
    setLiked(true);
    setLikeDelta(1);
    externalItems.like(externalItemId, matchingAccount.id).catch(() => {
      setLiked(false);
      setLikeDelta(0);
    });
  }, [externalItemId, matchingAccount, liked]);

  // Optimistic repost
  const [reposted, setReposted] = React.useState(false);
  const [repostDelta, setRepostDelta] = React.useState(0);
  const onRepostCb = React.useCallback(() => {
    if (!externalItemId || !matchingAccount || reposted) return;
    setReposted(true);
    setRepostDelta(1);
    externalItems.repost(externalItemId, matchingAccount.id).catch(() => {
      setReposted(false);
      setRepostDelta(0);
    });
  }, [externalItemId, matchingAccount, reposted]);

  // Inline reply
  const [replyOpen, setReplyOpen] = React.useState(false);
  const [replyDelta, setReplyDelta] = React.useState(0);
  const toggleReply = React.useCallback(() => setReplyOpen((p) => !p), []);
  const closeReply = React.useCallback(() => setReplyOpen(false), []);
  const onReplied = React.useCallback(() => setReplyDelta((d) => d + 1), []);

  // Poll voting
  const [pollVoting, setPollVoting] = React.useState(false);
  const [pollVoted, setPollVoted] = React.useState(false);
  const onPollVote = React.useCallback(
    (choices: number[]) => {
      if (!externalItemId || !matchingAccount || pollVoting || pollVoted) return;
      setPollVoting(true);
      externalItems
        .pollVote(externalItemId, matchingAccount.id, choices)
        .then(() => setPollVoted(true))
        .catch(() => {})
        .finally(() => setPollVoting(false));
    },
    [externalItemId, matchingAccount, pollVoting, pollVoted],
  );

  // Fresh-on-expand counters. Called unconditionally; only fetches when expanded
  // AND active. Snapshot from the served originCounts.
  const snapshot = {
    likeCount: post.originCounts?.like ?? 0,
    replyCount: post.originCounts?.reply ?? 0,
    repostCount: post.originCounts?.repost ?? 0,
  };
  const engagement = useLiveEngagement(
    externalItemId ?? "",
    expanded && active,
    snapshot,
  );

  if (!active) {
    return {
      liked: false,
      reposted: false,
      likeDisabled: false,
      repostDisabled: false,
      replyOpen: false,
      closeReply,
      onReplied,
      replyDisabled: false,
      linkedAccount: null,
      protocol,
      canVote: false,
      pollVoting: false,
      onPollVote,
      liveCounts: null,
      externalItemId,
    };
  }

  const caps = interactionCaps(protocol, !!matchingAccount, active);

  return {
    liked,
    reposted,
    onLike: caps.likeEnabled ? onLikeCb : undefined,
    likeDisabled: caps.likeDisabled,
    onRepost: caps.repostEnabled ? onRepostCb : undefined,
    repostDisabled: caps.repostDisabled,
    replyOpen,
    onToggleReply: caps.replyAllowed ? toggleReply : undefined,
    closeReply,
    onReplied,
    replyDisabled: caps.replyDisabled,
    linkedAccount: matchingAccount,
    protocol,
    canVote: !!matchingAccount && !post.body.poll?.closed && !pollVoted,
    pollVoting,
    onPollVote,
    liveCounts: post.originCounts
      ? {
          like: engagement.likeCount + likeDelta,
          reply: engagement.replyCount + replyDelta,
          repost: engagement.repostCount + repostDelta,
        }
      : null,
    externalItemId,
  };
}
