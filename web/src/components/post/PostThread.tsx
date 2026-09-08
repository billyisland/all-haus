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
//  - The focal click collapses the whole card (§4 matrix focal click = collapse).
//  - A quote-tile click is a JUMP, not a re-root: the quoted post belongs to a
//    different conversation, so thread.rerootAsRoot moves root + focal together
//    and it opens with full seniority — parity with the feed-level expandQuote.
//
//    NO "FULL CONVERSATION" BACK-LINK (deleted 2026-09-07). It returned to
//    `rootId`, which is the item the reader OPENED — itself very often a reply
//    somewhere in the middle of a conversation — so the words promised the
//    whole thing and delivered "back where you started". `rootId` did not go
//    with it and is not a residue: it still anchors the quote-jump's seniority
//    (`set-root` moves root and focal together) and still chooses where the
//    scroll-in lands, below. What went is the only affordance that ever made a
//    CLAIM about it.
//  - Gutter overflow POINTERS when ancestors/replies extend past the viewport.
//    They span FIRST PARENT → LAST CHILD: each is gated on there being nodes of
//    its own kind to reach, so neither ever lands the reader back on the focal.
//    All three thread arrows are the shared `Pointer` (globals.css 1f), never a
//    typed ↑ / ↓ — at .label-ui's 11px the glyph was a stroke's worth of ink
//    asking to be pressed, and it did not grow for a thumb.
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
import { Pointer } from "../ui/Pointer";
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
  const upBtn = useRef<HTMLButtonElement>(null);
  const downBtn = useRef<HTMLButtonElement>(null);
  // A rail pointer fades out where it would cross the FOCAL card's face (§4.3).
  const [clash, setClash] = React.useState({ up: false, down: false });

  const view =
    thread.focalId !== null
      ? deriveThreadView(thread.pool, thread.focalId)
      : null;
  // The SPINE — ancestors + focal — is the full-width band (level-spec, amended
  // 2026-09-02: `thread-parent` is flush and full size). It is what the gutter
  // pointers must not fly over; before the amendment the focal alone was, since
  // ancestors were inset like the replies.
  const spineRef = useRef<HTMLDivElement>(null);

  // Bring the focal to the reader on expand and on every re-root (§4.3). Keyed
  // on the focal id so a client-side re-root moves without a fetch.
  //
  // WHERE IT LANDS DEPENDS ON WHAT SITS ABOVE THE FOCAL, and the two cases want
  // opposite things. At the thread's OWN ROOT — every feed expand and every
  // quote-jump, both of which mint a fresh conversation with no ancestors —
  // centring spends the top half of the log on whatever the conversation opened
  // under. For a quote that is the quoting card, which WorkspaceView keeps above
  // the thread on purpose, so the reader was left looking at the card they had
  // just clicked away from rather than at the thing that just happened. `start`
  // puts the conversation itself at the top of the log, where the eye already
  // is. After an intra-thread re-root there ARE ancestors above the focal, and
  // they are the context that makes the re-root legible, so that case keeps the
  // centre and lets them show.
  useEffect(() => {
    if (!view) return;
    const atThreadRoot = thread.focalId === thread.rootId;
    focalRef.current?.scrollIntoView({
      block: atThreadRoot ? "start" : "center",
      behavior: "smooth",
    });
  }, [thread.focalId, thread.rootId, view !== null]);

  // Gutter overflow pointers: show ▲ while content above the focal is off-screen,
  // ▼ while content below is off-screen (§4.3). Sentinels sit at the band edges.
  useEffect(() => {
    const top = topSentinel.current;
    const bottom = bottomSentinel.current;
    if (!top && !bottom) return;
    const io = new IntersectionObserver((entries) => {
      for (const e of entries) {
        if (e.target === top)
          setOverflow((o) => ({ ...o, up: !e.isIntersecting }));
        if (e.target === bottom)
          setOverflow((o) => ({ ...o, down: !e.isIntersecting }));
      }
    });
    if (top) io.observe(top);
    if (bottom) io.observe(bottom);
    return () => io.disconnect();
  }, [view !== null]);

  // A pointer lives in the channel between the thread's left edge and the
  // inset REPLY cards (`w-8` button, `ml-8` step-in — the button IS that
  // channel, so its centre is the channel's midpoint by construction). A card
  // with no step-in has no channel beside it, and there the pointer would fly
  // over the card's face. It fades on contact instead.
  //
  // THE TEST IS PER CARD, AND IT CANNOT BE A TEST AGAINST A WRAPPER.
  //
  // The `946af329` version measured the focal alone, which was right while the
  // ancestors were flush and wrong the moment they were not. It was replaced by
  // a rect taken off the `spineRef` wrapper, described as "the more general
  // test". It is not a more general test — it is a test of something else. The
  // step-in is a `marginLeft` on each CARD SHELL (`chassis.tsx`), and a block
  // wrapper's `getBoundingClientRect()` spans its container's full width whatever
  // its children's margins are. So the wrapper rect always starts at the thread's
  // left edge, always overlaps the button, and the up-pointer faded beside every
  // ancestor — including the inset ones whose 32px channel is sitting there
  // empty, which is precisely the case the caret exists for.
  //
  // Measuring the spine's DIRECT CHILDREN is the general test, and it needs no
  // knowledge of which ancestors are flush: an ARTICLE ancestor is `indentPx: 0`
  // (D1's article-head override) so its own rect reaches the edge and clashes;
  // a note or external ancestor carries the 32px margin so its rect starts past
  // the button and does not. The rule — the caret appears exactly where it has
  // somewhere to be — falls out of the geometry rather than being restated from
  // the spec.
  //
  // HIDDEN BY OPACITY, NEVER BY UNMOUNTING. Unmounting drops the button's rect,
  // the overlap test then reads false, it remounts, the test reads true again —
  // a flip-flop every frame. Opacity leaves the geometry standing, so the test
  // stays true while hidden and the state is stable.
  useEffect(() => {
    if (!view) return;
    let frame = 0;
    const measure = () => {
      frame = 0;
      const spine = spineRef.current;
      if (!spine) return;
      // The children, not the container. Each is a card shell carrying its own
      // `marginLeft` (or the focal's flush wrapper), so these rects are the only
      // ones that know where the channel is.
      const cards = Array.from(spine.children, (c) => c.getBoundingClientRect());
      const hits = (btn: HTMLButtonElement | null) => {
        if (!btn) return false;
        const r = btn.getBoundingClientRect();
        return cards.some(
          (fr) =>
            r.bottom > fr.top &&
            r.top < fr.bottom &&
            r.right > fr.left &&
            r.left < fr.right,
        );
      };
      const up = hits(upBtn.current);
      const down = hits(downBtn.current);
      setClash((c) => (c.up === up && c.down === down ? c : { up, down }));
    };
    const onScroll = () => {
      if (!frame) frame = requestAnimationFrame(measure);
    };
    measure();
    // Capture-phase: the workspace scrolls a nested vessel interior, not window.
    document.addEventListener("scroll", onScroll, {
      capture: true,
      passive: true,
    });
    window.addEventListener("resize", onScroll);
    return () => {
      if (frame) cancelAnimationFrame(frame);
      document.removeEventListener("scroll", onScroll, { capture: true });
      window.removeEventListener("resize", onScroll);
    };
  }, [view !== null, thread.focalId]);

  if (thread.loading || !view) {
    return (
      <div
        className="ml-8 py-4 label-ui"
        style={{ color: ctx.palette.cardMeta }}
      >
        {thread.error ? "Couldn’t load this thread." : "Loading thread…"}
      </div>
    );
  }

  const { focal, ancestors, descendants } = view;
  const moreCount = Math.max(thread.totalDescendants - descendants.length, 0);

  const isOwn = (p: Post) =>
    !!currentUserPubkey && p.author.pubkey === currentUserPubkey;
  // Native posts carry a pubkey → reply/report target the all.haus event.
  const nativeReply = (p: Post) =>
    onReply && p.author.pubkey ? () => onReply(p) : undefined;
  // Quote works for external posts too — the host (quoteFromPost) builds a native
  // quote-note that references the external origin (migration 102).
  const quoteFor = (p: Post) => (onQuote ? () => onQuote(p) : undefined);
  const nativeReport = (p: Post) =>
    onReport && p.author.pubkey ? () => onReport(p) : undefined;

  return (
    // The conversation is one group in a log of independent cards, and it says
    // so with SIZE AND INDENT — the ancestors' 0.9 step-in, restored by
    // ARTICLE-HEADED-CONVERSATIONS-ADR D1 — plus the beat itself: 5px between
    // cards inside a conversation against 20px between log items, already 4:1.
    //
    // The 20px block margin that stood here (THREAD_BLOCK_GAP_PX, 2026-09-02)
    // is deleted with the constant. It was added to replace a group cue that
    // had not gone anywhere, on arithmetic that did not hold: the column's 12px
    // gap was counted as if it applied BETWEEN the cards inside this block,
    // making the two beats read "3px apart, which nobody sees". Neither this
    // div nor the spine below is a flex container, so the gap applies to the
    // whole block as one item and never inside it. D2, and ADR §5a for the
    // mechanism and the six places the figure had reached.
    <div className="relative">
      <div ref={topSentinel} aria-hidden />

      {/* Gutter overflow pointers — centred in the 32px thread gutter (§4.3).
          `w-8` IS that gutter, so the mark sits under the thread's own left
          edge rather than nudged near it; the vertical padding is the tap
          target and is the one thing that grows on a phone (py-3 -> 39px tall,
          against the pointer's own 15px rise).

          THE PAIR SPANS FIRST PARENT → LAST CHILD, AND THE FOCAL IS NEITHER
          END OF IT. The down pointer has always been gated on there being
          replies to reach; the up pointer was gated on nothing but the
          sentinel being off-screen, which in the workspace's ordinary case —
          a feed expand, where root IS focal and there are no ancestors — left
          it pointing at the top of the focal card itself. So the two marks
          read as "back to the card you opened" and "to the end", with the
          focal as one terminus, when what a conversation's rail should offer
          is its two real extremes. No ancestors ⇒ no first parent ⇒ no up
          pointer; the focal is where the reader already is (the scroll-in
          effect above puts them there) and is never somewhere to be sent. */}
      {overflow.up && ancestors.length > 0 && (
        <button
          ref={upBtn}
          type="button"
          aria-label="Scroll to the start of the conversation"
          aria-hidden={clash.up}
          tabIndex={clash.up ? -1 : undefined}
          onClick={() =>
            topSentinel.current?.scrollIntoView({
              block: "start",
              behavior: "smooth",
            })
          }
          className={`focus-ring sticky top-2 z-10 flex w-8 items-center justify-center py-3 transition-opacity md:py-2 ${
            clash.up ? "pointer-events-none opacity-0" : "hover:opacity-70"
          }`}
          style={{ color: ctx.palette.cardMeta }}
        >
          <Pointer direction="up" />
        </button>
      )}

      {/* THE SPINE — ancestors root-first, then the focal. The ancestors are
          context and say so by size (0.9, one step in); an ARTICLE ancestor is
          the exception and renders as itself, full size and flush, because it
          is the thing the whole conversation is about — resolveSpec's
          article-head override, ARTICLE-HEADED-CONVERSATIONS-ADR D1.
          `spineRef` is the container the gutter-pointer test walks: it measures
          this div's CHILDREN one by one, never this div itself, because the
          step-in is a margin on each card and a wrapper's rect spans the full
          width regardless. See the effect above. */}
      <div ref={spineRef}>
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
          ref={downBtn}
          type="button"
          aria-label="Scroll to the end of the conversation"
          aria-hidden={clash.down}
          tabIndex={clash.down ? -1 : undefined}
          onClick={() =>
            bottomSentinel.current?.scrollIntoView({
              block: "end",
              behavior: "smooth",
            })
          }
          className={`focus-ring sticky bottom-2 z-10 flex w-8 items-center justify-center py-3 transition-opacity md:py-2 ${
            clash.down ? "pointer-events-none opacity-0" : "hover:opacity-70"
          }`}
          style={{ color: ctx.palette.cardMeta }}
        >
          <Pointer direction="down" />
        </button>
      )}
    </div>
  );
}
