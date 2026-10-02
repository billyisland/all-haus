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
//  - Gutter RAIL POINTERS to the conversation's two ends: up to the very top,
//    down to the very bottom. Each shows the moment that end is OFF-SCREEN and
//    goes for two reasons only (operator, 2026-09-27): the end has been
//    reached, or the pointer would pass over a flush card's face (`clash`) —
//    the focal always, an article ancestor where there is one. There is no
//    "far enough to be worth a jump" test any more. Both are the shared `Pointer`
//    (globals.css 1f), never a typed ↑ / ↓ — at .label-ui's 11px the glyph was
//    a stroke's worth of ink asking to be pressed, and it did not grow for a
//    thumb.
//  - "Show more replies" paginates the focal's descendants (§8 lazy).
//
// Scope cuts (documented, consistent with Phase 2): external all.haus
// reactions stay deferred. A native reply is written IN SITU in the card's own
// footer (PostCardInteractive → NativeReplyBox), never in a pane over this. Boost attribution (edges) is threaded but unrendered
// until threads accumulate boosts.
// =============================================================================

import React, { useEffect, useRef } from "react";
import { usePostThread } from "../../hooks/usePostThread";
import { useThreadRefresh } from "../../stores/threadRefresh";
import { isSeenEnough } from "../../lib/post/seen";
import { scrollParent } from "../../lib/workspace/preserveCardPosition";
import { deriveThreadView } from "../../lib/post/thread";
import { INDENT_STEP_PX } from "../../lib/post/level-spec";
import type { Post } from "../../lib/post/types";
import { Pointer } from "../ui/Pointer";
import { PostCardInteractive } from "./PostCardInteractive";
import type { CardContext } from "./chassis";

// How far an end must have travelled past the visible edge before it counts as
// off-screen. A pixel or two only: sticky positioning and fractional scroll
// offsets leave a pin up to a pixel off its sentinel at rest (measured: 1px
// after a press), and the pointer must not flicker on that.
const OFFSCREEN_EPSILON_PX = 2;


// A PRESS LANDS WHERE "REACHED" IS MEASURED: it scrolls by exactly the gap
// between the pin and its sentinel, so the gap closes and the pointer goes.
// `scrollIntoView` aimed at the sentinel does not do that inside a workspace
// vessel: the vessel pads its interior by 16px top and bottom, a sticky pin
// stops at that PADDING edge, and `scrollIntoView` aligns to the scrollport's
// OUTER edge — so the press left the conversation's first card 16px under the
// padding, the gap read 16, and the pointer that had just been pressed stayed
// up claiming the end was still off-screen (measured, 2026-09-27). On the
// document-scrolling surfaces the two edges coincide and either would do.
function scrollPinToSentinel(
  pin: HTMLElement | null,
  sentinel: HTMLElement | null,
) {
  if (!pin || !sentinel) return;
  const top =
    sentinel.getBoundingClientRect().top - pin.getBoundingClientRect().top;
  (scrollParent(pin) ?? window).scrollBy({ top, behavior: "smooth" });
}

// WHERE THE VISIBLE TOP OF THE SCROLLPORT IS. A vessel's interior scrolls, and
// nothing covers its top. But on a surface where the DOCUMENT scrolls
// (`/source`, `/author`) the sitewide nav bar is fixed over the top of it, and
// a rail stuck at `top: 0` put the up pointer underneath the bar: mounted,
// opaque, and invisible (measured, 2026-09-27, both widths). The bar's band is
// published as `--ah-bar-band` (LayoutShell, 0 where there is no bar), and it
// is the rail's `top` only where the document is the scroller. A Glasshouse
// pane or a vessel scrolls itself, and the bar is not over it.
function coveredTop(root: HTMLElement): number {
  if (scrollParent(root)) return 0;
  const band = parseFloat(
    getComputedStyle(root).getPropertyValue("--ah-bar-band"),
  );
  return Number.isFinite(band) ? band : 0;
}

// HOW WIDE THE CHANNEL IS LEFT OF THE THREAD. The channel the pointers fly
// down runs from the CONTAINER'S WALL to the inset cards' left edge, not from
// the thread's own left edge: a vessel pads its interior by 16px, so the
// thread starts 16px in from the wall, and a pointer centred in the thread's
// 32px step-in sat 8px right of the channel's middle (operator, 2026-09-27).
// The wall is the first ancestor whose left edge is further left than the
// thread's own, and whatever lies between is the part of the channel the rail
// must reach out over. Measured, never stated: the padding differs by surface
// (a vessel, the mobile page, the `/source` column) and by breakpoint.
function wallGutter(root: HTMLElement): number {
  const left = root.getBoundingClientRect().left;
  for (let el = root.parentElement; el; el = el.parentElement) {
    const wall = el.getBoundingClientRect().left + el.clientLeft;
    if (wall < left - 0.5) return Math.round(left - wall);
  }
  return 0;
}

// A FOCAL WITH PARENTS NEVER LANDS FLUSH AGAINST THE TOP OF THE SCROLLPORT.
//
// `block: "start"` puts the focal's top edge at exactly 0 — which is inside the
// up pointer's own station, so a flush focal filled it at the instant of every
// expand and `clash` faded the pointer. That is the whole of why the arrow read
// as patchy and "only appears once I scroll below the focal". The focal now
// lands a station's height further down, which leaves the pointer standing in
// the gutter beside the parent above it from the first frame; and that parent's
// last line showing is the other half of what the reader needs to know — that
// there IS something above them.
//
// THE INSET IS MEASURED OFF THE POINTER, NOT STATED IN PIXELS. The station is
// two CSS literals (`top-2` and the button's own `py-3 md:py-2` around a glyph
// that is itself bigger on a phone), so a constant here would be a second copy
// of a figure that differs by breakpoint and moves whenever either is touched —
// and the failure it would reintroduce is silent. The button is mounted at
// every scroll position (that is what the sticky rail bought), so its extent
// below its own pin can simply be read; only the BEAT below it is a choice.
// The fallback is for the first frame alone, and clears a desktop station.
const INSET_BEAT_PX = 8;
const FOCAL_TOP_INSET_FALLBACK_PX = 72;

export function PostThread({
  rootPostId,
  ctx,
  onCollapse,
  onQuote,
  onOpenReader,
  currentUserPubkey,
  onSeen,
  autoScroll = true,
  omitAncestorId,
  replyPage,
  markReplyParents = false,
}: {
  rootPostId: string;
  ctx: CardContext;
  onCollapse?: () => void;
  onQuote?: (post: Post) => void;
  // Article nodes (e.g. an article root rendered as a thread-parent) click
  // through to the reader pane (§3.1) rather than re-rooting.
  onOpenReader?: (post: Post) => void;
  currentUserPubkey?: string | null;
  // Called once per post the reader ACTUALLY SAW inside this conversation —
  // see the seen-marking effect below. The workspace uses it to weed those
  // cards out of the feed when the conversation collapses; other hosts pass
  // nothing and the observer never mounts.
  onSeen?: (postId: string) => void;
  // A CONVERSATION THAT IS ALREADY WHERE IT SHOULD BE MUST NOT GO LOOKING FOR
  // ITSELF. The scroll-in below exists for a thread that OPENS INSIDE a log —
  // a feed expand, a quote-jump — where the reader's eye is on the card they
  // clicked and the conversation has to come to it. A thread rendered as the
  // FIRST thing in its log (the profile's pinned conversation, opened from a
  // notification) is already there, and scrolling to it only pushes the log's
  // own head out of the pane: measured at 266px of scrollTop, which put the
  // profile's bio and its view row off-screen and the pinned card's top edge
  // above the fold — the pane arriving looking like a pane somebody had
  // already scrolled.
  autoScroll?: boolean;
  // THE ARTICLE FOOT (ReplySection) opens a reply's conversation UNDER the
  // article it belongs to, so the article is not drawn again at the head of
  // the chain: the page above is the article. Every other host passes nothing.
  omitAncestorId?: string;
  // Descendants per page; the article foot pages by ten.
  replyPage?: number;
  // Mark each reply whose parent is not the card directly above it with
  // "→ NAME" — the flat chronological list otherwise cannot say whom a reply
  // answers. The article foot sets it; the workspace does not (operator,
  // 2026-09-27: the article-foot rework is scoped to the article).
  markReplyParents?: boolean;
}) {
  // The refetch signal is GLOBAL, not a prop: a reply published from any
  // compose surface changes this conversation wherever it is rendered, and a
  // prop threaded from one host covered one host (see `stores/threadRefresh`).
  const refreshKey = useThreadRefresh((s) => s.tick);
  const refreshTarget = useThreadRefresh((s) => s.targetEventId);
  const thread = usePostThread(rootPostId, true, refreshKey, refreshTarget, replyPage);
  // Every effect that MEASURES the thread re-runs when the pool grows: a
  // "show more" page changes both what is observed and how tall the block is.
  const poolSize = thread.pool.size;
  const rootRef = useRef<HTMLDivElement>(null);
  // Ids already reported, so `onSeen` fires once per post across re-roots and
  // across the observer teardowns the effect below performs.
  const seenRef = useRef<Set<string>>(new Set());
  const focalRef = useRef<HTMLDivElement>(null);
  // The conversation's two EDGES, static and zero-height: what the pointers
  // scroll to, and what "is that end off-screen?" is measured from.
  const topSentinel = useRef<HTMLDivElement>(null);
  const bottomSentinel = useRef<HTMLDivElement>(null);
  // The two PINS — zero-height sticky rails carrying the pointers. Each one
  // reports where the visible edge of the scroller is, whatever the scroller
  // turns out to be (window on /author and /source, a vessel interior in the
  // workspace), which is the one thing a rect comparison cannot work out for
  // itself. See `offscreen` below.
  const topPin = useRef<HTMLDivElement>(null);
  const bottomPin = useRef<HTMLDivElement>(null);
  // Is each END of the conversation off-screen? That is the whole of the
  // pointers' reason to exist (operator, 2026-09-27): the moment a parent or a
  // reply has gone past the visible edge, there is somewhere to jump to. The
  // distance gates that stood here (two cards up, about two cards' scrolling
  // down) are gone — they hid the pointer exactly when a reader, having just
  // expanded a conversation, could see it ran off the screen.
  const [offscreen, setOffscreen] = React.useState({
    up: false,
    down: false,
  });
  const upBtn = useRef<HTMLButtonElement>(null);
  const downBtn = useRef<HTMLButtonElement>(null);
  // Would a pointer be standing on a flush card's face (§4.3)? Both are tested
  // against the whole spine, so neither ever crosses the focal. See below.
  const [clash, setClash] = React.useState({ up: false, down: false });
  // Where the rail stands: how far the button reaches left of the thread to
  // the wall (`gutter`), and how far down the top pin sticks (`top`, the fixed
  // bar's band where the document scrolls). See `wallGutter` / `coveredTop`.
  const [rail, setRail] = React.useState({ gutter: 0, top: 0 });

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
  // quote-jump — centring spends the top half of the log on whatever the
  // conversation opened under. For a quote that is the quoting card, which
  // WorkspaceView keeps above the thread on purpose, so the reader was left
  // looking at the card they had just clicked away from rather than at the thing
  // that just happened. `start` puts the conversation itself at the top of the
  // log, where the eye already is. After an intra-thread re-root there ARE
  // ancestors above the focal, and they are the context that makes the re-root
  // legible, so that case keeps the centre and lets them show.
  //
  // `rootId` IS THE ITEM THE READER OPENED, NOT THE CONVERSATION'S ROOT, so
  // `atThreadRoot` says nothing about whether there are ancestors. This comment
  // claimed until 2026-09-20 that a feed expand "mints a fresh conversation with
  // no ancestors"; measured against the dev corpus, ordinary feed expands took
  // this branch with 2, 4, 5, 9 and 10 ancestors, every one of which `start`
  // threw clean off the top of the screen — taking the up pointer's station with
  // them. What the landing owes a focal WITH parents is the inset, not a
  // different alignment: see FOCAL_TOP_INSET_PX on the focal's wrapper below.
  useEffect(() => {
    if (!view || !autoScroll) return;
    const focal = focalRef.current;
    if (!focal) return;
    const atThreadRoot = thread.focalId === thread.rootId;
    // The inset, read off the pointer's own geometry: how far the button
    // reaches below its pin, which IS the station the landing must clear. Both
    // rects are local to the rail, so this is the same figure wherever the pin
    // happens to be sitting when the scroll is asked for. Set imperatively and
    // not as a style prop, because the value is only knowable here and React
    // must not diff it away between scrolls.
    const pin = topPin.current?.getBoundingClientRect();
    const btn = upBtn.current?.getBoundingClientRect();
    const station =
      pin && btn && btn.height > 0
        ? Math.round(btn.bottom - pin.top)
        : FOCAL_TOP_INSET_FALLBACK_PX;
    // Where the document scrolls, the fixed bar covers the top of it too, and
    // the landing clears the bar as well as the station.
    const covered = rootRef.current ? coveredTop(rootRef.current) : 0;
    // The ancestors the reader will SEE above it — an omitted article is not one.
    const shownAncestors = view.ancestors.filter((p) => p.id !== omitAncestorId);
    focal.style.scrollMarginTop = shownAncestors.length
      ? `${covered + station + INSET_BEAT_PX}px`
      : covered
        ? `${covered}px`
        : "";
    focal.scrollIntoView({
      block: atThreadRoot ? "start" : "center",
      behavior: "smooth",
    });
  }, [thread.focalId, thread.rootId, view !== null, autoScroll]);

  // A pointer lives in the channel between the container's wall and the inset
  // REPLY cards (`railBox`: the measured gutter plus the step-in — the button
  // IS that channel, so its centre is the channel's midpoint by construction). A card
  // with no step-in has no channel beside it, and there the pointer would fly
  // over the card's face. It fades on contact — but WHICH cards it is tested
  // against differs by direction, and that is the substance; see `hits` below.
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
      const root = rootRef.current;
      if (!spine || !root) return;

      const gutter = wallGutter(root);
      const top = coveredTop(root);
      setRail((r) =>
        r.gutter === gutter && r.top === top ? r : { gutter, top },
      );

      // ── IS THAT END OFF-SCREEN? ────────────────────────────────────────────
      // Each pin is zero-height and sticky, sitting in flow ON its sentinel, so
      // the gap between the two IS how far that edge has travelled past the
      // visible edge — zero while the end is on screen, growing as the reader
      // scrolls away from it. Reading it off the pin rather than off
      // `window.innerHeight` is what makes this work unchanged inside a
      // workspace vessel, whose interior scrolls and whose visible bottom is
      // nowhere near the window's.
      const gap = (pin: HTMLDivElement | null, mark: HTMLDivElement | null) =>
        pin && mark
          ? Math.abs(
              pin.getBoundingClientRect().top -
                mark.getBoundingClientRect().top,
            )
          : 0;
      const upOff = gap(topPin.current, topSentinel.current) > OFFSCREEN_EPSILON_PX;
      const downOff =
        gap(bottomPin.current, bottomSentinel.current) > OFFSCREEN_EPSILON_PX;
      setOffscreen((o) =>
        o.up === upOff && o.down === downOff ? o : { up: upOff, down: downOff },
      );
      // The children, not the container. Each is a card shell carrying its own
      // `marginLeft` (or the focal's flush wrapper), so these rects are the only
      // ones that know where the channel is.
      const cards = Array.from(spine.children, (c) => c.getBoundingClientRect());
      const hits = (btn: HTMLButtonElement | null, against: DOMRect[]) => {
        if (!btn) return false;
        const r = btn.getBoundingClientRect();
        return against.some(
          (fr) =>
            r.bottom > fr.top &&
            r.top < fr.bottom &&
            r.right > fr.left &&
            r.left < fr.right,
        );
      };
      // BOTH POINTERS ARE MEASURED AGAINST THE WHOLE SPINE, SO NEITHER EVER
      // CROSSES THE FOCAL'S FACE (operator rule, 2026-09-20). A pointer is a
      // thing that lives in the gutter; where a flush card leaves no gutter, it
      // goes, rather than sitting on the card's top-left padding.
      //
      // The up pointer was narrowed to `cards[0]` on 2026-09-12 to fix the
      // opposite complaint: measured against the focal it went out the moment
      // the focal passed under it, which with ancestors above is the whole of
      // the moment the reader has just opened the thing. That fix was aimed at
      // a gate that no longer exists, and the narrowing was reversed on
      // 2026-09-20.
      //
      // THE COMPLAINT IT WAS AIMED AT WAS REAL, AND THE FADE WAS NEVER ITS
      // CAUSE — THE LANDING WAS. `block: "start"` put the focal's top edge at
      // exactly 0, i.e. inside the pointer's own station, so the fade fired at
      // the instant of every expand and the arrow read as "patchy, and only
      // once you scroll past the focal". Measured across 22 threads on the dev
      // corpus: of the 14 with two or more parents, the distance gate passed in
      // all 14 and this test suppressed 7. The focal now lands
      // FOCAL_TOP_INSET_PX below the top instead, which gives the pointer a
      // parent's gutter to stand in from the first frame and leaves this test
      // doing only the job it is for.
      //
      // An ARTICLE ancestor is flush too (`indentPx: 0`, D1's article-head
      // override), and the same test covers it for the same reason — it is one
      // more card with no channel beside it.
      const up = hits(upBtn.current, cards);
      const down = hits(downBtn.current, cards);
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
    // Whether an end is off-screen changes whenever the conversation changes
    // shape without anybody scrolling: an image or an embed landing, a "show
    // more replies" page merging in, an inline reply box opening.
    const ro = new ResizeObserver(onScroll);
    if (rootRef.current) ro.observe(rootRef.current);
    return () => {
      if (frame) cancelAnimationFrame(frame);
      document.removeEventListener("scroll", onScroll, { capture: true });
      window.removeEventListener("resize", onScroll);
      ro.disconnect();
    };
  }, [view !== null, thread.focalId, poolSize]);

  // ── SEEN-MARKING ───────────────────────────────────────────────────────────
  // Report each post the reader actually saw inside this conversation. The
  // workspace weeds those cards out of the feed on collapse, so the criterion
  // has to be SEEN and not merely RENDERED: a thread mounts its whole ancestor
  // chain and a page of five replies at once, and a reader who reads three and
  // collapses has not read the rest. Weeding what was only mounted would delete
  // unread posts out of their feed and call it tidying — the same shape as
  // every other bug in this repo where an absence gets the reassuring reading.
  //
  // The predicate itself is `lib/post/seen.ts::isSeenEnough`, pure and pinned
  // there (its two arms each pass green against a suite that tests only the
  // other). What belongs here is the THRESHOLD LIST: with `threshold: 0` the
  // observer fires once, as the card's first pixel crosses, and never again as
  // it scrolls the rest of the way in — so the predicate would only ever be
  // asked at the one moment it is certain to answer no.
  //
  // Root is the viewport, NOT the vessel: IntersectionObserver clips against
  // every ancestor's overflow on the way up, so a card scrolled out of a
  // vessel's interior is correctly not intersecting, and the same code works
  // on the document-scrolling hosts (/author, /source, the profile log).
  //
  // Re-queried on both axes that change what is rendered: `focalId` (a re-root
  // swaps the whole band structure over an unchanged pool) and `pool.size` (a
  // "show more" page merges new nodes in). Declared above, beside the other
  // measurement state, because the gutter-pointer effect keys on it too.
  // The thread's DOM does not exist until BOTH of these hold — the early return
  // below is `thread.loading || !view`. Keyed on `focalId` alone the effect ran
  // once while the loading branch was still mounted, found no `rootRef`, and
  // was never asked again once the cards arrived: the observer silently never
  // attached, and the whole feature reported nothing with everything else about
  // it correct. (Measured, not hypothetical — this is what the first drive
  // found.) Same reason the clash effect above carries `view !== null`.
  const threadMounted = !thread.loading && view !== null;
  useEffect(() => {
    const root = rootRef.current;
    if (!onSeen || !threadMounted || !root) return;
    const observer = new IntersectionObserver(
      (entries) => {
        for (const e of entries) {
          const id = (e.target as HTMLElement).dataset.postId;
          if (!id || seenRef.current.has(id)) continue;
          if (
            isSeenEnough({
              ratio: e.intersectionRatio,
              visibleHeight: e.intersectionRect.height,
              cardHeight: e.boundingClientRect.height,
            })
          ) {
            seenRef.current.add(id);
            onSeen(id);
          }
        }
      },
      { threshold: [0, 0.25, 0.5, 0.75, 1] },
    );
    for (const el of root.querySelectorAll("[data-post-id]")) {
      observer.observe(el);
    }
    return () => observer.disconnect();
  }, [onSeen, threadMounted, thread.focalId, poolSize]);

  if (thread.loading || !view) {
    return (
      <div
        className="ml-8 py-4 label-ui"
        style={{ color: ctx.palette.cardMeta }}
      >
        {thread.error ? "Couldn’t load this conversation. Please try again." : "Loading…"}
      </div>
    );
  }

  const { focal, descendants } = view;
  const ancestors = omitAncestorId
    ? view.ancestors.filter((p) => p.id !== omitAncestorId)
    : view.ancestors;
  // Whom each reply answers, where it is not the card directly above it.
  const replyingToOf = (p: Post, i: number) => {
    if (!markReplyParents || !p.inReplyTo) return null;
    const above = i === 0 ? focal : descendants[i - 1];
    if (p.inReplyTo === above.id) return null;
    const parent = thread.pool.get(p.inReplyTo);
    const name = parent?.author.displayName || parent?.author.handle;
    return name ? { name } : null;
  };
  const moreCount = Math.max(thread.totalDescendants - descendants.length, 0);

  const isOwn = (p: Post) =>
    !!currentUserPubkey && p.author.pubkey === currentUserPubkey;
  // REPLY IS NOT ONE OF THESE EITHER (2026-09-18). It is written in situ, in
  // the card's own footer, so `PostCardInteractive` builds its target and
  // mounts the box — the same move Report made, and for the same reason: a
  // callback threaded through three call sites here and six hosts outside is
  // a prop chain that can only be wrong in one of them. See PostActions.
  // Quote works for external posts too — the host (quoteFromPost) builds a native
  // quote-note that references the external origin (migration 102).
  const quoteFor = (p: Post) => (onQuote ? () => onQuote(p) : undefined);

  // A rail pointer shows while its end is OFF-SCREEN and it has somewhere to
  // stand (`clash`) — those two, and nothing else. Both are measured in one
  // pass; see the effect above.
  const showUp = offscreen.up && !clash.up;
  const showDown = offscreen.down && !clash.down;
  // The button spans the whole channel, wall to inset card: reaching `gutter`
  // left of the thread and the 32px step-in (`INDENT_STEP_PX`) into it,
  // so the pointer's centre is the channel's midpoint by construction.
  const railBox = {
    left: -rail.gutter,
    width: rail.gutter + INDENT_STEP_PX,
  };

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
    <div className="relative" ref={rootRef}>
      <div ref={topSentinel} aria-hidden />

      {/* THE RAIL POINTERS — centred in the channel from the container's wall
          to the inset cards (§4.3). The button IS that channel (`railBox`), so
          the mark flies down its middle rather than being nudged near it; the
          vertical padding is the tap target and is the
          one thing that grows on a phone (py-3 -> 39px tall, against the
          pointer's own 15px rise).

          EACH ONE RIDES A ZERO-HEIGHT STICKY RAIL, AND THE RAIL IS ALSO THE
          MEASUREMENT. `h-0` + an absolutely-positioned button means the pair
          costs no layout at all, so they can stay MOUNTED at every scroll
          position and through every thread length — which is what makes both
          tests below stable. Mounting them on their own visibility was the
          old arrangement and it fed back: the button appearing added 39px to
          the top of the block, and the rect it was measured by only existed
          while it was already shown.

          THE PAIR SPANS THE CONVERSATION'S TWO EXTREMES, AND EACH SHOWS WHILE
          ITS END IS OFF-SCREEN (operator, 2026-09-27). It goes for two reasons
          only: that end has been reached, or it would pass over a flush card's
          face (below). Never gate either on a count of NODES — a count cannot
          say where the reader is standing, which is the whole of what these
          two are about.

          AND NEITHER CROSSES A CARD'S FACE. `clash` holds a pointer at opacity
          0 while it would overlap a flush card — the focal always, an article
          ancestor where the conversation has one — because a rail pointer is a
          thing that lives in the gutter and a flush card leaves no gutter to
          live in. Opacity, never unmounting: unmounting drops the rect the
          overlap is measured from, which reads false, which remounts it. */}
      <div
        ref={topPin}
        className="sticky z-10 h-0"
        style={{ top: rail.top }}
      >
        <button
          ref={upBtn}
          type="button"
          aria-label="Scroll to the start of the conversation"
          aria-hidden={!showUp}
          tabIndex={showUp ? undefined : -1}
          onClick={() =>
            scrollPinToSentinel(topPin.current, topSentinel.current)
          }
          className={`focus-ring absolute top-2 flex items-center justify-center py-3 transition-opacity md:py-2 ${
            showUp ? "hover:opacity-70" : "pointer-events-none opacity-0"
          }`}
          style={{ ...railBox, color: ctx.palette.cardMeta }}
        >
          <Pointer direction="up" />
        </button>
      </div>

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
            onReroot={(x) => thread.reroot(x.id)}
            onQuoteOpen={(qid) => thread.rerootAsRoot(qid)}
            onOpenReader={onOpenReader}
            onQuote={quoteFor(p)}
            isOwnContent={isOwn(p)}
          />
        ))}

        {/* Focal — full rich card; click collapses the whole card (§4 matrix).
          expanded → fresh-on-expand origin counters fetch for the focal only. */}
        {/* A FOCAL WITH PARENTS NEVER LANDS FLUSH AGAINST THE TOP OF THE
            SCROLLPORT. The scroll-in above aims at this element and sets its
            `scroll-margin-top` imperatively, measured off the up pointer's own
            station — see INSET_BEAT_PX. A conversation with nothing above its
            focal keeps the flush landing it wants. */}
        <div ref={focalRef}>
          <PostCardInteractive
            key={focal.id}
            post={focal}
            level="focal"
            expanded
            ctx={ctx}
            onCollapse={() => onCollapse?.()}
            onQuoteOpen={(qid) => thread.rerootAsRoot(qid)}
            onOpenReader={onOpenReader}
            onQuote={quoteFor(focal)}
            isOwnContent={isOwn(focal)}
          />
        </div>
      </div>

      {/* Replies — chronological, below the focal (thread-reply level). */}
      {descendants.map((p, i) => (
        <PostCardInteractive
          key={p.id}
          post={p}
          level="thread-reply"
          replyingTo={replyingToOf(p, i)}
          expanded={false}
          ctx={ctx}
          onReroot={(x) => thread.reroot(x.id)}
          onQuoteOpen={(qid) => thread.rerootAsRoot(qid)}
          onOpenReader={onOpenReader}
          onQuote={quoteFor(p)}
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

      {/* The down pointer's rail. Both zero-height markers sit at the
          conversation's bottom edge — the pin is what travels (see `offscreen`),
          the sentinel is what the press scrolls to. */}
      <div ref={bottomPin} className="sticky bottom-0 z-10 h-0">
        <button
          ref={downBtn}
          type="button"
          // WHAT IS DOWN THERE IS NOT ALWAYS THE END. With replies still
          // unloaded the last thing in the block is the "show more" button, so
          // the label says where the press actually lands rather than making a
          // claim about the conversation.
          aria-label={
            thread.hasMoreReplies
              ? "Scroll to the last loaded reply"
              : "Scroll to the end of the conversation"
          }
          aria-hidden={!showDown}
          tabIndex={showDown ? undefined : -1}
          onClick={() =>
            scrollPinToSentinel(bottomPin.current, bottomSentinel.current)
          }
          className={`focus-ring absolute bottom-2 flex items-center justify-center py-3 transition-opacity md:py-2 ${
            showDown ? "hover:opacity-70" : "pointer-events-none opacity-0"
          }`}
          style={{ ...railBox, color: ctx.palette.cardMeta }}
        >
          <Pointer direction="down" />
        </button>
      </div>

      <div ref={bottomSentinel} aria-hidden />

    </div>
  );
}
