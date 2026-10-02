"use client";

import React from "react";
import { Byline } from "../workspace/Byline";
import { TrustPip } from "../ui/TrustPip";
import { AuthorModal, useAuthorHover } from "../feed/AuthorModal";
import { PostResonance } from "./PostResonance";
import type { VesselPalette } from "../workspace/tokens";
import type { Post } from "../../lib/post/types";

// =============================================================================
// PostByline — the one byline for every Post, at every level.
//
// Native vs external is a stable property of a given Post, so we render one of
// two sub-components (each may call its own hooks without violating the rules of
// hooks). Both read the name straight off the Post: the mapper fills a native
// author's `displayName`/`handle` from its `accounts` join, so the byline makes
// no lookup of its own (CA-G7).
//
// Byline ROUTING (§4.4, flipped for tier A/B in Phase 4):
//  - native → /{username} when known (clickable profile)
//  - external A/B → /author/:authorId (the constructed external-author profile)
//  - external C → /author/:authorId too (the source-scoped record,
//    BYLINE-AND-PROVENANCE-ADR D3; routing keys on post.author.id)
//  - external D → NO BYLINE ROW (ADR D9 + Q1): a post with no author has
//    nothing true to put here, so PostCard omits the row (level-spec
//    `showByline`) and the timestamp joins the provenance line. The byline
//    NEVER prints the source's name — that is D1's slot collapse, the arm D9
//    removed; the source is the provenance line's fact.
//
// HOVER (§4.4): every linked byline (native + tier A/B) anchors a debounced,
// session-cached profile preview (AuthorModal, type "author"). The 300 ms rest
// debounce + per-author cache live in useAuthorHover/useAuthorCard. Tier C/D and
// the quoted level (bylineProfile=false) have no linked byline, so no hover.
// =============================================================================

// Last-resort byline label when a post carries an author RECORD but no name or
// handle (a data gap in ingest — e.g. the historical atproto "EXTERNAL" bug,
// self-healed by the handle-enrichment backfill). Derive a friendly label from
// the origin protocol rather than showing a bare "External", which reads as if
// the account were literally named EXTERNAL. Never the source's name (D9).
function protocolFallbackName(protocol: string): string {
  switch (protocol) {
    case "atproto":
      return "Bluesky user";
    case "activitypub":
      return "Fediverse user";
    case "nostr":
    case "nostr_external":
      return "Nostr user";
    case "rss":
      return "Web feed";
    case "email":
      return "Email";
    default:
      return "Unknown author";
  }
}

export function PostByline({
  post,
  palette,
  bylineProfile,
  showResonance,
  trailing,
  replyingTo,
  feedId,
  dragHandle,
  showTime,
}: {
  post: Post;
  palette: VesselPalette;
  bylineProfile: boolean;
  // D7: resolveSpec has already checked both that this level shows the glyph
  // and that the post carries a band >= 1.
  showResonance?: boolean;
  trailing?: React.ReactNode;
  replyingTo?: { name: string } | null;
  feedId?: string;
  // The card this byline heads can be dragged into another feed, so the byline
  // is its grab handle (Byline.tsx::dragHandle).
  dragHandle?: boolean;
  showTime?: boolean;
}) {
  // The glyph belongs to the metadata cluster, so it rides the trailing slot
  // immediately after the timestamp and ahead of any caller-supplied trailing
  // (price / protocol badge), which stays the rightmost element.
  const merged = showResonance ? (
    <>
      <PostResonance post={post} palette={palette} />
      {trailing}
    </>
  ) : (
    trailing
  );

  if (post.author.pubkey) {
    return (
      <NativeByline
        post={post}
        palette={palette}
        bylineProfile={bylineProfile}
        trailing={merged}
        replyingTo={replyingTo}
        feedId={feedId}
        dragHandle={dragHandle}
        showTime={showTime}
      />
    );
  }
  return (
    <ExternalByline
      post={post}
      palette={palette}
      bylineProfile={bylineProfile}
      trailing={merged}
      replyingTo={replyingTo}
      feedId={feedId}
      dragHandle={dragHandle}
      showTime={showTime}
    />
  );
}

// Pip panel parked: the pip is a non-interactive legibility dot. The author
// actions it used to host (Follow, per-feed VOLUME) now live in the byline
// hover panel (AuthorModal → SourceVolume). PipTrigger/PipPanel stay in the
// tree, unmounted (CA-I2); restore by reinstating the PipTrigger branch, an
// `onPipOpen` prop threaded from the workspace, and the panel's mount there.
function pipNode(post: Post): React.ReactNode {
  return <TrustPip status={post.author.pipStatus} />;
}

function NativeByline({
  post,
  palette,
  bylineProfile,
  trailing,
  replyingTo,
  feedId,
  dragHandle,
  showTime,
}: {
  post: Post;
  palette: VesselPalette;
  bylineProfile: boolean;
  trailing?: React.ReactNode;
  replyingTo?: { name: string } | null;
  feedId?: string;
  dragHandle?: boolean;
  showTime?: boolean;
}) {
  const name =
    post.author.displayName ??
    post.author.handle ??
    post.author.pubkey!.slice(0, 12) + "…";
  const nameHref =
    bylineProfile && post.author.handle ? `/${post.author.handle}` : undefined;
  // Hover keys on the persistent author.id (accounts.id) — null disables it on
  // the quoted level / when there is no profile to link.
  const hover = useAuthorHover(
    "author",
    bylineProfile ? post.author.id : null,
  );
  return (
    <>
      <Byline
        pipNode={pipNode(post)}
        name={name}
        nameHref={nameHref}
        publishedAt={post.publishedAt}
        replyingTo={replyingTo}
        trailing={trailing}
        palette={palette}
        nameRef={hover.bylineRef}
        onNameMouseEnter={hover.onMouseEnter}
        onNameMouseLeave={hover.onMouseLeave}
        dataExplain="card.byline"
        dragHandle={dragHandle}
        showTime={showTime}
      />
      {hover.open && hover.id && (
        <AuthorModal
          type="author"
          id={hover.id}
          anchorRef={hover.bylineRef}
          onClose={hover.onModalClose}
          onMouseEnter={hover.onModalMouseEnter}
          onMouseLeave={hover.onModalMouseLeave}
          feedId={feedId}
          pubkey={post.author.pubkey ?? undefined}
          frameScheme={palette.scheme}
        />
      )}
    </>
  );
}

function ExternalByline({
  post,
  palette,
  bylineProfile,
  trailing,
  replyingTo,
  feedId,
  dragHandle,
  showTime,
}: {
  post: Post;
  palette: VesselPalette;
  bylineProfile: boolean;
  trailing?: React.ReactNode;
  replyingTo?: { name: string } | null;
  feedId?: string;
  dragHandle?: boolean;
  showTime?: boolean;
}) {
  const name =
    post.author.displayName ??
    post.author.handle ??
    protocolFallbackName(post.origin.protocol);
  // Tier A/B/C carry an author.id (external_authors record — tier C is the
  // source-scoped rss/email byline, BYLINE-AND-PROVENANCE-ADR D3) → link +
  // hover to the constructed profile. Tier D has author.id = null → plain
  // text, no hover.
  //
  // A member's own account elsewhere (CROSS-NETWORK-ROUNDTRIP-ADR D1): the
  // NAME links to who wrote it, their all.haus profile, where they consented
  // to showing the link (the gateway omits memberUsername otherwise). The
  // HOVER stays this network's author card — it hosts the per-feed volume of
  // the source the reader follows, which is a fact about that account.
  const linkable = bylineProfile && !!post.author.id;
  const nameHref = !linkable
    ? undefined
    : post.author.memberUsername
      ? `/${post.author.memberUsername}`
      : `/author/${post.author.id}`;
  const hover = useAuthorHover("author", linkable ? post.author.id : null);
  return (
    <>
      <Byline
        pipNode={<TrustPip status={post.author.pipStatus} />}
        name={name}
        nameHref={nameHref}
        publishedAt={post.publishedAt}
        replyingTo={replyingTo}
        trailing={trailing}
        palette={palette}
        nameRef={hover.bylineRef}
        onNameMouseEnter={hover.onMouseEnter}
        onNameMouseLeave={hover.onMouseLeave}
        dataExplain="card.byline"
        dragHandle={dragHandle}
        showTime={showTime}
      />
      {hover.open && hover.id && (
        <AuthorModal
          type="author"
          id={hover.id}
          anchorRef={hover.bylineRef}
          onClose={hover.onModalClose}
          onMouseEnter={hover.onModalMouseEnter}
          onMouseLeave={hover.onModalMouseLeave}
          feedId={feedId}
          frameScheme={palette.scheme}
        />
      )}
    </>
  );
}
