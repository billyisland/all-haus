"use client";

// =============================================================================
// PostThread — UNIVERSAL-POST-ADR §4.3 / §8 (Phase 3)
//
// ONE thread engine over Post[] + edges, replacing ConversationView (native) and
// the external ancestor rail / playscript (external). It mounts when a feed card
// expands: ancestors above (thread-parent), the focal in the middle (focal),
// replies below (thread-reply) — all the same PostCard, so native and external
// threads are visually indistinguishable (§10 Accept).
//
//  - Re-root: clicking any ancestor/reply makes it the focal in place, no
//    residue (§4.3). Pure client-side over the loaded pool; an unloaded subtree
//    fetches and merges (usePostThread).
//  - Scroll-centres the focal on expand and on every re-root (§4.3).
//  - "↑ Full conversation" returns to the conversation's root — the opened
//    item, or the quoted post after a quote-jump; the focal click collapses
//    the whole card (§4 matrix focal click = collapse).
//  - A quote-tile click is a JUMP, not a re-root: the quoted post belongs to a
//    different conversation, so thread.rerootAsRoot moves root + focal together
//    and it opens with full seniority (no "↑ Full conversation" residue
//    pointing at the quoting host) — parity with the feed-level expandQuote.
//  - Gutter overflow arrows when ancestors/replies extend past the viewport.
//  - "Show more replies" paginates the focal's descendants (§8 lazy).
//
// Scope cuts (documented, consistent with Phase 2): external inline reply +
// external all.haus reactions stay deferred; native reply opens the compose
// overlay via onReply. Boost attribution (edges) is threaded but unrendered
// until threads accumulate boosts.
// =============================================================================

import React, { useEffect, useRef } from "react";
import { usePostThread } from "../../hooks/usePostThread";
import { deriveThreadView } from "../../lib/post/thread";
import type { Post } from "../../lib/post/types";
import { PostCardInteractive } from "./PostCardInteractive";
import type { CardContext, PipOpen } from "./chassis";

export function PostThread({
  rootPostId,
  ctx,
  onCollapse,
  onReply,
  onQuote,
  onReport,
  onOpenReader,
  onPipOpen,
  currentUserPubkey,
  refreshKey,
}: {
  rootPostId: string;
  ctx: CardContext;
  onCollapse?: () => void;
  onReply?: (post: Post) => void;
  onQuote?: (post: Post) => void;
  onReport?: (post: Post) => void;
  // Article nodes (e.g. an article root rendered as a thread-parent) click
  // through to the reader pane (§3.1) rather than re-rooting.
  onOpenReader?: (post: Post) => void;
  onPipOpen?: PipOpen;
  currentUserPubkey?: string | null;
  // Bump to force a thread refetch (e.g. after publishing a reply).
  refreshKey?: number;
}) {
  const thread = usePostThread(rootPostId, true, refreshKey);
  const focalRef = useRef<HTMLDivElement>(null);
  const topSentinel = useRef<HTMLDivElement>(null);
  const bottomSentinel = useRef<HTMLDivElement>(null);
  const [overflow, setOverflow] = React.useState({ up: false, down: false });

  const view =
    thread.focalId !== null
      ? deriveThreadView(thread.pool, thread.focalId)
      : null;

  // Scroll-centre the focal on expand and on every re-root (§4.3). Keyed on the
  // focal id so a client-side re-root re-centres without a fetch.
  useEffect(() => {
    if (!view) return;
    focalRef.current?.scrollIntoView({ block: "center", behavior: "smooth" });
  }, [thread.focalId, view !== null]);  

  // Gutter overflow arrows: show ↑ while content above the focal is off-screen,
  // ↓ while content below is off-screen (§4.3). Sentinels sit at the band edges.
  useEffect(() => {
    const top = topSentinel.current;
    const bottom = bottomSentinel.current;
    if (!top && !bottom) return;
    const io = new IntersectionObserver((entries) => {
      for (const e of entries) {
        if (e.target === top) setOverflow((o) => ({ ...o, up: !e.isIntersecting }));
        if (e.target === bottom)
          setOverflow((o) => ({ ...o, down: !e.isIntersecting }));
      }
    });
    if (top) io.observe(top);
    if (bottom) io.observe(bottom);
    return () => io.disconnect();
  }, [view !== null]);

  if (thread.loading || !view) {
    return (
      <div className="ml-8 py-4 label-ui" style={{ color: ctx.palette.cardMeta }}>
        {thread.error ? "Couldn’t load this thread." : "Loading thread…"}
      </div>
    );
  }

  const { focal, ancestors, descendants } = view;
  const atRoot = thread.focalId === thread.rootId;
  const moreCount = Math.max(thread.totalDescendants - descendants.length, 0);

  const isOwn = (p: Post) =>
    !!currentUserPubkey && p.author.pubkey === currentUserPubkey;
  // Native posts carry a pubkey → reply/report target the all.haus event.
  const nativeReply = (p: Post) =>
    onReply && p.author.pubkey ? () => onReply(p) : undefined;
  // Quote works for external posts too — the host (quoteFromPost) builds a native
  // quote-note that references the external origin (migration 102).
  const quoteFor = (p: Post) =>
    onQuote ? () => onQuote(p) : undefined;
  const nativeReport = (p: Post) =>
    onReport && p.author.pubkey ? () => onReport(p) : undefined;

  return (
    <div className="relative">
      <div ref={topSentinel} aria-hidden />

      {/* Gutter overflow arrows — discreet, in the 32px thread gutter (§4.3). */}
      {overflow.up && (
        <button
          type="button"
          aria-label="Scroll to the start of the conversation"
          onClick={() =>
            topSentinel.current?.scrollIntoView({ block: "start", behavior: "smooth" })
          }
          className="sticky top-2 z-10 ml-1 block transition-opacity hover:opacity-70"
          style={{ color: ctx.palette.cardMeta }}
        >
          ↑
        </button>
      )}

      {/* ↑ Full conversation — returns to the conversation's root after an
          intra-thread re-root (§4.3). Never renders straight after a quote-jump
          (rerootAsRoot moves the root too, so atRoot holds). */}
      {!atRoot && (
        <button
          type="button"
          onClick={thread.backToRoot}
          className="mb-3 ml-8 label-ui hover:underline"
          style={{ color: ctx.palette.cardMeta }}
        >
          ↑ Full conversation
        </button>
      )}

      {/* Ancestors — root-first, above the focal (thread-parent level). Keyed by
          p.id (not a level-prefix) so re-rooting among loaded nodes doesn't
          needlessly remount and drop optimistic interact-back state. */}
      {ancestors.map((p) => (
        <PostCardInteractive
          key={p.id}
          post={p}
          level="thread-parent"
          expanded={false}
          ctx={ctx}
          onPipOpen={onPipOpen}
          onReroot={(x) => thread.reroot(x.id)}
          onQuoteOpen={(qid) => thread.rerootAsRoot(qid)}
          onOpenReader={onOpenReader}
          onReply={nativeReply(p)}
          onQuote={quoteFor(p)}
          onReport={nativeReport(p)}
          isOwnContent={isOwn(p)}
        />
      ))}

      {/* Focal — full rich card; click collapses the whole card (§4 matrix).
          expanded → fresh-on-expand origin counters fetch for the focal only. */}
      <div ref={focalRef}>
        <PostCardInteractive
          key={focal.id}
          post={focal}
          level="focal"
          expanded
          ctx={ctx}
          onPipOpen={onPipOpen}
          onCollapse={() => onCollapse?.()}
          onQuoteOpen={(qid) => thread.rerootAsRoot(qid)}
          onOpenReader={onOpenReader}
          onReply={nativeReply(focal)}
          onQuote={quoteFor(focal)}
          onReport={nativeReport(focal)}
          isOwnContent={isOwn(focal)}
        />
      </div>

      {/* Replies — chronological, below the focal (thread-reply level). */}
      {descendants.map((p) => (
        <PostCardInteractive
          key={p.id}
          post={p}
          level="thread-reply"
          expanded={false}
          ctx={ctx}
          onPipOpen={onPipOpen}
          onReroot={(x) => thread.reroot(x.id)}
          onQuoteOpen={(qid) => thread.rerootAsRoot(qid)}
          onOpenReader={onOpenReader}
          onReply={nativeReply(p)}
          onQuote={quoteFor(p)}
          onReport={nativeReport(p)}
          isOwnContent={isOwn(p)}
        />
      ))}

      {thread.hasMoreReplies && (
        <button
          type="button"
          onClick={thread.loadMore}
          disabled={thread.loadingMore}
          className="ml-8 mt-2 label-ui hover:underline disabled:opacity-50"
          style={{ color: ctx.palette.cardMeta }}
        >
          {thread.loadingMore
            ? "Loading…"
            : `Show ${moreCount > 0 ? moreCount : "more"} more repl${moreCount === 1 ? "y" : "ies"}`}
        </button>
      )}

      <div ref={bottomSentinel} aria-hidden />

      {overflow.down && (descendants.length > 0 || thread.hasMoreReplies) && (
        <button
          type="button"
          aria-label="Scroll to the end of the conversation"
          onClick={() =>
            bottomSentinel.current?.scrollIntoView({ block: "end", behavior: "smooth" })
          }
          className="sticky bottom-2 z-10 ml-1 block transition-opacity hover:opacity-70"
          style={{ color: ctx.palette.cardMeta }}
        >
          ↓
        </button>
      )}
    </div>
  );
}
