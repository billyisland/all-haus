"use client";

import {
  Fragment,
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { useRouter } from "next/navigation";
import { useAuth } from "../../stores/auth";
import { useWorkspaceSurface } from "../../stores/workspaceSurface";
import { useWorkspace } from "../../stores/workspace";
import { GRID } from "../../lib/workspace/grid";
import {
  deriveGeometry,
  regimentedLayout,
  resolveDrop,
  clampSlotSize,
  withSlotSize,
  slotFor,
  dropIsNoop,
  locateSlot,
  type Drop,
  type Geometry,
  type WorkspaceLayout,
} from "../../lib/workspace/layout";
import { prefersReducedMotion } from "../../lib/workspace/motion";
import {
  captureCardAnchor,
  preserveCardPosition,
  restoreCardAnchor,
  type CardAnchor,
} from "../../lib/workspace/preserveCardPosition";
import {
  createFeedLoads,
  loadPageOne,
  type PageOneResult,
} from "../../lib/workspace/feedLoads";
import {
  FEED_PAGE_SIZE,
  mergeFirstPage,
  type MergeOutcome,
} from "../../lib/workspace/feedMerge";
import { planReveal } from "../../lib/workspace/queueReveal";
import { flushSync } from "react-dom";
import {
  workspaceFeeds as workspaceFeedsApi,
  auth,
  type WorkspaceFeed,
  type WorkspaceFeedSource,
} from "../../lib/api";
import { Vessel } from "./Vessel";
import {
  ExplainProvider,
  useExplainable,
  FirstRunController,
  FirstRunPreview,
} from "./ExplainProvider";
import { useExplain } from "../../stores/explain";
import { ExplainOverlay } from "./ExplainOverlay";
import { AboutOverlay } from "./AboutOverlay";
import { PostCardInteractive } from "../post/PostCardInteractive";
import { PostCard } from "../post/PostCard";
import { PostThread } from "../post/PostThread";
import type { CardContext } from "../post/chassis";
import type { Post } from "../../lib/post/types";
import { quoteTargetFromPost } from "../../lib/post/quote-target";
import {
  paletteFor,
  normalizeBrightness,
  normalizeDensity,
  TEXT_SIZE_PX,
  DEFAULT_DENSITY,
  DEFAULT_TEXT_SIZE,
} from "./tokens";
import { useColorScheme } from "../../stores/colorScheme";
import { ForallMenu, type ForallAction } from "./ForallMenu";
import { NavBar, NAV_BAR_H } from "./NavBar";
import { Muster, type MusterFeed } from "./Muster";
import { useMobileActiveFeed } from "../../stores/mobileActiveFeed";
import { useQueueFocal } from "../../stores/queueFocal";
import { useFeedArrivals } from "../../stores/feedArrivals";
import { Composer } from "./Composer";
import type { QuoteTarget } from "../../lib/publishNote";
import { NewFeedPrompt } from "./NewFeedPrompt";
import { FeedComposer } from "./FeedComposer";
import { ForallCeremony } from "./ForallCeremony";
// Overlays are code-split + open-gated in LazyOverlays (performance audit #4):
// their chunks (incl. TipTap/Stripe via the editor/ledger) leave the /reader
// bundle and load on first open.
import {
  LazyReaderOverlay as ReaderOverlay,
  LazyMessagesOverlay as MessagesOverlay,
  LazyDashboardOverlay as DashboardOverlay,
  LazyLedgerOverlay as LedgerOverlay,
  LazySettingsOverlay as SettingsOverlay,
  LazyLibraryOverlay as LibraryOverlay,
} from "./LazyOverlays";
import { useReader, type ReaderNavEntry } from "../../stores/reader";
import { useCompose } from "../../stores/compose";
import { useEditorOverlay } from "../../stores/editorOverlay";
import {
  openOverlayFromParams,
  OVERLAY_PARAM_KEYS,
} from "../../lib/workspace/overlays";
import { EmptyFeedTile } from "./EmptyFeedTile";
import { MergeFeedConfirm } from "./MergeFeedConfirm";
import { MobileWorkspace } from "./MobileWorkspace";
import { useIsMobile } from "../../hooks/useIsMobile";
import { useGlasshousePresence } from "../../stores/glasshouse";
import { useFeedSeen, useFeedSeenMark, type SeenMark } from "../../stores/feedSeen";
import { useSeenPolling } from "../../hooks/useSeenPolling";

/** The queue's background read of every feed (the operator, 2026-09-26: "every
 *  seven minutes, plus an extra pull each time the user does a refresh"). */
const QUEUE_PREFETCH_MS = 7 * 60_000;
import {
  QueueView,
  type QueueFeed,
  type QueueViewHandle,
} from "./queue/QueueView";
import { useUnreadCounts } from "../../stores/unread";
import { useLightbox } from "../../stores/lightbox";
import { originWebUrl } from "../../lib/post/origin-url";
import { sourcePageId } from "../../lib/post/source-page";

const FLOOR = "var(--ah-bone)"; // grey-100 per Step 1 / Colour tokens committed
const DEFAULT_FEED_NAME = "Founder's channel";
// A queue preview layer shows at most this many rows (WORKSPACE-QUEUE-ADR
// §VII.5): a glance at a feed ahead, never a second place to read it.
const PREVIEW_ROW_CAP = 60;

/** Px of pan before the virtualization band is re-read (hysteresis dead band).
 *  Well under the one-viewport mount margin, so a vessel is never parked while
 *  any part of it is on screen. */
const VIRT_QUANT = 200;

function matchItemToSource(
  item: Post,
  sources: WorkspaceFeedSource[],
): string | undefined {
  // External card → its all.haus external_sources row; native → the author
  // account. (tag/publication sources have no per-card drag handle, as before.)
  if (item.externalSourceId) {
    return sources.find(
      (s) =>
        s.sourceType === "external_source" &&
        s.externalSourceId === item.externalSourceId,
    )?.id;
  }
  const authorId = item.author.accountId;
  if (!authorId) return undefined;
  return sources.find(
    (s) => s.sourceType === "account" && s.accountId === authorId,
  )?.id;
}

// Map a feed Post to a reader-skip entry — articles only (the reader-pane click
// targets), mirroring openReaderFromPost's native/external split. Non-articles
// (notes, external short posts) expand inline and return null, so they drop out
// of the up/down skip sequence.
function articleToReaderEntry(p: Post): ReaderNavEntry | null {
  if (p.type !== "article") return null;
  if (p.author.pubkey) {
    if (!p.dTag) return null;
    return {
      kind: "native",
      postId: p.id,
      dTag: p.dTag,
      preview: { title: p.body.title, summary: p.body.summary },
    };
  }
  // The resolved WEB url, never `origin.uri` verbatim: for RSS that column is
  // `guid ?? link`, and a guid is very often not a URL (`urn:uuid:…`, `tag:…`,
  // a bare integer) — handed one the extractor answers "Could not extract", and
  // a hostile one would have been rendered as an href. The card's own `→` has
  // always gone through this helper, so until now the card and the reader
  // disagreed about whether the same post had a permalink. No permalink ⇒ no
  // entry, so the piece also drops out of the skip sequence rather than
  // stranding the ears on a page that cannot load.
  const url = originWebUrl(p);
  if (!url) return null;
  return {
    kind: "external",
    postId: p.id,
    url,
    title: p.body.title,
    siteName: p.origin.sourceName,
    // The reader bar's inward link (`/source/:id`) — the same target the card's
    // provenance line offers, carried over so the pane names the thing the
    // reader subscribed to and not just the site (BYLINE-AND-PROVENANCE D7).
    sourceId: sourcePageId(p),
    // The item's own enclosures — the pane plays a video the origin page may
    // have no player for (the card already did; the pane did not).
    media: p.body.media ?? null,
  };
}

// Slice 9: first-login ceremony plays once per user. Storage flag survives
// across logouts on the same browser; the responsive (new-feed) ceremony has
// no equivalent gate since it's a per-action animation, not an onboarding.
const CEREMONY_SEEN_PREFIX = "workspace:ceremony_seen:";

// THE FIRST-SESSION WELCOME SHEET IS DELETED (owner decision, 2026-09-04).
// Its five steps — profile, follow-import, Library, publish, and the tour offer
// — were all chores or offers standing between a new member and the workspace,
// and none of them explained the thing they were standing in front of. What
// replaces them is the Explain tour itself, which annotates the real surface
// rather than describing it in a modal beforehand.
//
// SO THE AUTO-ENTRY IS REVIVED, AND THAT REVERSES A REVERSAL. `FirstRunController`
// has been dormant since EXPLAIN-ADR amendment 1 ("landing in Explain mode on
// load without asking for it read as a malfunction, not a welcome") — Explain
// was made strictly ∀-menu-invoked and the tour reached only by accepting the
// welcome's last step. With the sheet gone that route goes with it, and an
// unoffered tour is an unfindable one; the owner's call is that the tour runs
// itself. Recorded rather than quietly re-enabled, because the objection it was
// switched off for is a real one and may come back — if it does, the fix is an
// offer, not a return of the five-step sheet.
//
// AND IT IS GATED ON THE MEMBER, NOT ON THE DEVICE. `FirstRunController`'s own
// guard is `workspace:firstrun_seen:<id>` in localStorage, which is right for a
// per-device animation and wrong for this: auto-running an onboarding tour at
// somebody who did it last week on their laptop is exactly what the
// once-per-member invariant exists to stop. So `accounts.onboarded_at`
// (migration 176) — the fact the deleted sheet was gated on — keeps its job and
// arms this instead, and opening the tour stamps it the way answering the sheet
// used to. The per-device key stays underneath as the second gate.
// Ceremony box dimensions (mirrors ForallCeremony's BOX_W / BOX_H — kept
// duplicated locally so the positioning math doesn't need to import the
// component's internals). Referenced only by the commented-out Task 7 entrance
// animation today; retained for the pending re-enable, so silence the
// unused-var lint until then (L3).
/* eslint-disable-next-line @typescript-eslint/no-unused-vars */
const CEREMONY_BOX_W = 300;
/* eslint-disable-next-line @typescript-eslint/no-unused-vars */
const CEREMONY_BOX_H = 300;

interface PendingCeremony {
  feedId: string;
  pace: "ceremonial" | "responsive";
  target: { x: number; y: number };
}

// The floor is COLUMNAR (WORKSPACE-COLUMN-LAYOUT-ADR): what persists is an
// order — columns left to right, slots top to bottom — and every pixel is
// derived from it by `deriveGeometry`. There is no default grid slot to
// compute and no position to write back: a new feed appends a column
// (`insertFeed`) and geometry does the rest.

/** Value equality for a resolved drop — the resolver mints a fresh object per
 *  frame, so without this every pointermove would setState and re-render the
 *  whole floor. */
function sameDrop(a: Drop, b: Drop): boolean {
  if (a.kind !== b.kind) return false;
  if (a.kind === "merge" && b.kind === "merge")
    return a.targetFeedId === b.targetFeedId;
  if (a.kind === "new-column" && b.kind === "new-column")
    return a.boundaryIndex === b.boundaryIndex;
  if (a.kind === "into-column" && b.kind === "into-column")
    return (
      a.columnIndex === b.columnIndex &&
      a.slotIndex === b.slotIndex &&
      a.h === b.h
    );
  return false;
}

// The workspace items endpoint now emits the unified Post[] directly (gateway
// feedItemToPost) — no client-side legacy-item adapter (FEED-RETIREMENT-PLAN
// Slice 6 item 4). Dedup/resume key off the deterministic post_id.
function itemKey(item: Post): string {
  return item.id;
}

interface VesselState {
  feed: WorkspaceFeed;
  items: Post[];
  sources: WorkspaceFeedSource[];
  status: "loading" | "ready" | "error";
  caughtUp?: boolean;
  // Infinite scroll: cursor for the next (older) page — null once exhausted,
  // undefined before the first load. `loadingMore` gates concurrent fetches.
  nextCursor?: string | null;
  loadingMore?: boolean;
}

// The feed's own scroller, where it has one: a floor vessel, or the queue's
// focal entry (the only one whose list can hold an open conversation). The
// queue mounts its neighbours' lists too, and a post can be a card in two of
// them, so a search of the whole document could hold the wrong one still.
// Mobile has none — its page scrolls the document — and walks up instead.
function feedScroller(feedId: string): HTMLElement | null {
  const id = CSS.escape(feedId);
  return document.querySelector<HTMLElement>(
    `[data-vessel-id="${id}"] [data-vessel-scroll], ` +
      `[data-queue-entry="focal"][data-queue-feed="${id}"] [data-vessel-scroll]`,
  );
}

export function WorkspaceView() {
  const { user, loading, outage, fetchMe } = useAuth();
  const router = useRouter();
  // MOBILE-LAYOUT-ADR: mobile is not a reflow of the canvas — it is a
  // different interaction model over the same feeds. This switch swaps the
  // body (vessels ↔ pager) while everything else (data, overlays, composer,
  // pip panel) is shared.
  const isMobile = useIsMobile();
  // On mobile every feed follows the GLOBAL light/dark toggle (uniform), not
  // its per-feed scheme; on desktop feeds keep their scheme (light-islanded).
  const globalDark = useColorScheme((s) => s.dark);

  // THE DOCUMENT NEVER OVERSCROLLS SIDEWAYS WHILE THE WORKSPACE IS MOUNTED.
  // The floor's own `overscroll-behavior-x: contain` only bites while the floor
  // is ACTUALLY scrollable — a taut floor narrower than the viewport (two or
  // three feeds on a wide screen: the common case) is not, so the browser
  // ignores it and hands a sideways swipe to its back/forward gesture. On a
  // surface where sideways is how both the feeds and the floor move, that reads
  // as the workspace randomly navigating away — and in the queue, whose primary
  // gesture IS a horizontal drag, Safari's back-swipe would be live on every
  // step. Nothing here scrolls the DOCUMENT sideways, so the document's
  // horizontal overscroll can only ever be that gesture; refuse it for as long
  // as the workspace is mounted, and hand it back on the way out so the rest of
  // the site keeps it. Lifted out of `Floor` (WORKSPACE-QUEUE-ADR §VI.4) so it
  // covers both modes from one home.
  useEffect(() => {
    const html = document.documentElement;
    const prev = html.style.overscrollBehaviorX;
    html.style.overscrollBehaviorX = "none";
    return () => {
      html.style.overscrollBehaviorX = prev;
    };
  }, []);

  // The desktop workspace IS the queue (WORKSPACE-QUEUE-ADR §XI, C2); mobile
  // is the pager. The floor's branches below are unreachable and go at C3 —
  // kept until then so a failed real-trackpad pass reverts in one commit.
  const queueMode = !isMobile;
  const queueRef = useRef<QueueViewHandle>(null);
  const setQueueFocal = useQueueFocal((s) => s.set);
  const [vessels, setVessels] = useState<VesselState[]>([]);
  const [bootstrap, setBootstrap] = useState<"loading" | "ready" | "error">(
    "loading",
  );
  const [composerOpen, setComposerOpen] = useState<false | "note">(false);
  // Live mirror for the attach-once ⌘K handler below.
  const composerOpenRef = useRef<false | "note">(false);
  composerOpenRef.current = composerOpen;
  // Monotonic sequence for overlapping reorder PUTs (see handleReorderFeeds).
  const reorderSeqRef = useRef(0);
  // Bridge the global compose store into the workspace's local Composer. The
  // global ComposeOverlay is not mounted in the chromeless workspace, so any
  // in-workspace surface that lives outside this component requests a note
  // compose by calling useCompose.open('note'); we mirror that into local state
  // here. (Article writing is the global EditorOverlay, opened directly.)
  // Register the workspace surface's presence for as long as this component is
  // mounted (`stores/workspaceSurface.ts` has the full why: it is what stops
  // LayoutShell mounting the public nav bar over the workspace during the
  // popstate transition a URL-synced overlay's close rides).
  const setWorkspaceMounted = useWorkspaceSurface((s) => s._setMounted);
  useEffect(() => {
    setWorkspaceMounted(true);
    return () => setWorkspaceMounted(false);
  }, [setWorkspaceMounted]);
  const composeReqOpen = useCompose((s) => s.isOpen);
  const composeReqMode = useCompose((s) => s.mode);
  useEffect(() => {
    if (!composeReqOpen) return;
    // BOTH MODES, because the surfaces that request one are the same surfaces
    // in either register. A profile, a source or a tag is a body that renders
    // both as its own page and inside a globally-mounted overlay over this
    // floor — so its Quote asks the store, and whichever composer is up
    // answers. Bridging only `note` left every one of those requests setting
    // state nothing was listening to (the `routeToOverlay` fault, one surface
    // over): the button did nothing at all, silently, in both registers.
    // (REPLY is no longer a mode: it is written in the card's own footer.)
    // A note request after a supersede resumes the kept draft, target and all
    // (see `composerSuspendedRef`); a quote request names its own target.
    const { quoteTarget: qt } = useCompose.getState();
    if (composeReqMode === "quote") setQuoteTarget(qt);
    else if (!composerSuspendedRef.current) setQuoteTarget(null);
    composerSuspendedRef.current = false;
    setComposerOpen("note");
  }, [composeReqOpen, composeReqMode]);
  // Quote target — set when Quote is clicked on a card; the composer publishes
  // a NIP-18 quote note embedding it.
  const [quoteTarget, setQuoteTarget] = useState<QuoteTarget | null>(null);
  // True between a SUPERSEDE of the composer and its next opening. The
  // composer kept the draft; a plain reopen (New note, ⌘K) must keep the
  // quote target that draft was written about, or it publishes as a note —
  // the store's `suspended`, for the composer this view owns. A card's Quote
  // names its own target and does not read it.
  const composerSuspendedRef = useRef(false);
  const openNoteComposer = useCallback(() => {
    if (!composerSuspendedRef.current) setQuoteTarget(null);
    composerSuspendedRef.current = false;
    setComposerOpen("note");
  }, []);
  // ⌘K / Ctrl+K opens the note composer — parity with Nav's global hotkey,
  // which can't fire here because Nav is unmounted in the chromeless
  // workspace. No-ops while the article editor overlay is up (the Glasshouse
  // supersede rule would otherwise close it under the writer mid-article) and
  // while the composer is already open — clearing reply/quote targets there
  // would silently turn a typed reply into a top-level note.
  useEffect(() => {
    function handleKeyDown(e: KeyboardEvent) {
      if ((e.metaKey || e.ctrlKey) && e.key === "k") {
        // Frozen floor (EXPLAIN-ADR D1): while an Explain program is active
        // nothing may open over the scrim, the composer included.
        if (useExplain.getState().isActive) return;
        if (useEditorOverlay.getState().isOpen) return;
        e.preventDefault();
        if (composerOpenRef.current) return;
        openNoteComposer();
      }
    }
    document.addEventListener("keydown", handleKeyDown);
    return () => document.removeEventListener("keydown", handleKeyDown);
  }, [openNoteComposer]);
  // At most one conversation is expanded per feed. This maps a feed id to its
  // single open card: `key` (`feedItemId ?? id`) is the card slot, `root` is the
  // post the conversation is rooted on — normally the card's own post, but the
  // quoted post when the card was opened by clicking its embedded quote (so the
  // quote expands with full seniority, no trace of its host). Opening another
  // card in the same feed replaces the entry, collapsing the previous one.
  const [expandedByFeed, setExpandedByFeed] = useState<
    Record<string, { key: string; root: string; host: string }>
  >({});
  // Mirror, so the weeding below can read the entry a handler is about to
  // replace without threading it through every call site.
  const expandedRef = useRef(expandedByFeed);
  expandedRef.current = expandedByFeed;

  // ── WEEDING A CONVERSATION'S BYSTANDERS OUT OF THE FEED ────────────────────
  // A conversation pulls in its ancestors and replies, and those same posts are
  // very often cards elsewhere in the same feed — so a reader who follows a
  // thread and closes it finds the rest of their log scattered with things they
  // have just read in context. On collapse, the posts they SAW inside the
  // conversation stop being cards in that feed.
  //
  // SEEN, never merely rendered. `PostThread` reports visibility, not mount
  // (see its seen-marking effect): a thread mounts its whole ancestor chain and
  // a page of replies at once, and weeding the ones the reader scrolled past
  // would silently delete unread posts from their feed.
  //
  // The HOST card stays. It is the reader's place in the log at the exact
  // moment the log changes shape, and it is not what was bothering anyone.
  //
  // SESSION-SCOPED, on purpose. It is held here and nowhere else, so it
  // survives a pull-to-refresh (which is what the complaint is actually about —
  // a refresh that put them all back would be no fix) and is gone on reload.
  // Reading state that followed the member across devices belongs in the same
  // class as `accounts.onboarded_at` and would be a server-side record; this is
  // deliberately the smaller thing first, because whether the behaviour is
  // wanted at all is a question only the screen can answer.
  const [weededByFeed, setWeededByFeed] = useState<Record<string, Set<string>>>(
    {},
  );
  // What the open conversation has reported so far, per feed — uncommitted
  // until it closes, because a conversation still open has not finished being
  // read. A ref, not state: it is written on every scroll and must not render.
  const seenInThreadRef = useRef<Map<string, Set<string>>>(new Map());
  const noteSeenInThread = useCallback((feedId: string, postId: string) => {
    const byFeed = seenInThreadRef.current;
    const set = byFeed.get(feedId);
    if (set) set.add(postId);
    else byFeed.set(feedId, new Set([postId]));
  }, []);
  // One STABLE reporter per feed. `PostThread` keys its visibility observer on
  // this identity, and the thread re-renders on every scroll (the gutter
  // pointers' clash state), so a fresh closure per render would tear the
  // observer down and rebuild it several times a second.
  const seenHandlers = useRef<Map<string, (postId: string) => void>>(new Map());
  const seenHandlerFor = useCallback(
    (feedId: string) => {
      const existing = seenHandlers.current.get(feedId);
      if (existing) return existing;
      const handler = (postId: string) => noteSeenInThread(feedId, postId);
      seenHandlers.current.set(feedId, handler);
      return handler;
    },
    [noteSeenInThread],
  );
  // Close out a feed's conversation: bank what was seen (minus the host) and
  // hold the host card still while the cards around it go. Every path that
  // drops or REPLACES an expansion entry calls this first — a swap to another
  // card in the same feed is a collapse of the first one.
  const settleExpansion = useCallback((feedId: string) => {
    const seen = seenInThreadRef.current.get(feedId);
    seenInThreadRef.current.delete(feedId);
    if (!seen || seen.size === 0) return;
    const host = expandedRef.current[feedId]?.host ?? null;
    const openedOn = expandedRef.current[feedId]?.root ?? null;
    const restore = host ? preserveCardPosition(host, feedScroller(feedId)) : null;
    setWeededByFeed((prev) => {
      const next = new Set(prev[feedId]);
      const before = next.size;
      for (const id of seen) if (id !== host) next.add(id);
      return next.size === before ? prev : { ...prev, [feedId]: next };
    });
    // THE RESTORE IS FOR A COLLAPSE, NOT FOR A SWAP. Every caller settles the
    // outgoing conversation and swaps the new one in within the same commit,
    // so by the time this rAF runs another conversation may already be
    // opening — and if its thread is in cache `PostThread` has already fired
    // its smooth `scrollIntoView` in the synchronous passive flush. Adding a
    // delta to `scrollTop` aborts an in-flight smooth scroll, so the newcomer
    // would never arrive. Chrome and Firefox hide it (scroll anchoring makes
    // the delta ~0, and the `< 1` guard then skips it); Safari, which has no
    // anchoring and is the browser this file exists for, puts the view back on
    // the card that just closed.
    if (restore)
      requestAnimationFrame(() => {
        const nowOn = expandedRef.current[feedId]?.root ?? null;
        if (nowOn !== null && nowOn !== openedOn) return;
        restore();
      });
  }, []);

  // A feed that no longer exists drops its weeding too. `clearExpandedFor` is
  // not the place for this — it also runs on every refresh, and surviving a
  // refresh is the whole point of holding the set here — so the two teardowns
  // are separate and only delete/merge calls this one.
  const forgetFeedReadState = useCallback((feedId: string) => {
    seenInThreadRef.current.delete(feedId);
    seenHandlers.current.delete(feedId);
    setWeededByFeed((prev) => {
      if (!(feedId in prev)) return prev;
      const next = { ...prev };
      delete next[feedId];
      return next;
    });
  }, []);

  // Drop a feed's expansion entry. Called on refresh (a reload collapses the
  // open conversation) and on delete/merge — a vessel that no longer exists
  // must not leave its key behind, or a feed later minted with the same id
  // would open pre-expanded onto a stale card.
  const clearExpandedFor = useCallback((feedId: string) => {
    settleExpansion(feedId);
    setExpandedByFeed((prev) => {
      if (!(feedId in prev)) return prev;
      const next = { ...prev };
      delete next[feedId];
      return next;
    });
  }, [settleExpansion]);

  // A PREVIEW ROW OPENS ITS CONVERSATION AS THE QUEUE ARRIVES (operator,
  // 2026-09-27). The click walks to the row's feed and asks for that card's
  // conversation, which is opened only once the walk has come to rest on the
  // feed — its list live, its anchor already put back — so the thread's own
  // scroll-in is the last thing to move it. Every settle consumes the request:
  // one that lands anywhere else (a walk the reader overrode, or one refused
  // mid-drag) drops it rather than opening it on some later visit.
  const pendingQueueOpenRef = useRef<{
    feedId: string;
    key: string;
    root: string;
  } | null>(null);
  const onQueueFocalChange = useCallback(
    (feedId: string | null) => {
      setQueueFocal(feedId);
      const pending = pendingQueueOpenRef.current;
      pendingQueueOpenRef.current = null;
      if (!pending || pending.feedId !== feedId) return;
      settleExpansion(feedId);
      setExpandedByFeed((prev) => ({
        ...prev,
        [feedId]: { key: pending.key, root: pending.root, host: pending.root },
      }));
    },
    [setQueueFocal, settleExpansion],
  );
  const [newFeedOpen, setNewFeedOpen] = useState(false);
  const [feedComposerFor, setFeedComposerFor] = useState<WorkspaceFeed | null>(
    null,
  );
  const [ceremony, setCeremony] = useState<PendingCeremony | null>(null);
  // Armed once the bootstrap has settled and this account has never been
  // onboarded. Read as a fact about the MEMBER (see the FirstRunController note
  // above); the controller adds the per-device key, the ≥1-vessel wait, the
  // beat-3 readiness window and the never-over-a-deep-linked-pane courtesy.
  const [tourArmed, setTourArmed] = useState(false);

  // STABLE, AND THE STABILITY IS THE POINT. This is `FirstRunController`'s
  // `onOpened`, and it sits in that component's effect deps. As an inline arrow
  // it was a new identity on every WorkspaceView render, so the effect tore down
  // and re-ran each time — cancelling its poll timer and resetting `started`,
  // which is the clock the 4s "run anyway" fallback is measured against. On a
  // surface that re-renders on drag, scroll and every bootstrap tick, a member
  // whose first vessels carry no linked byline could wait for that fallback for
  // ever and never be shown the tour. `useCallback` with no deps because both
  // things it closes over are stable: a `useState` setter, and the auth store's
  // action.
  //
  // The sheet used to stamp `onboarded_at` on complete, dismiss and walk-away
  // alike, because all three are answers. Opening the tour is the same kind of
  // answer: the member has been shown the thing, and must not meet it again on
  // another browser. Idempotent server-side (first-write-wins), so
  // fire-and-forget — a lost call costs one repeat, never an error anybody sees.
  const handleTourOpened = useCallback(() => {
    setTourArmed(false);
    void auth.markOnboarded().catch(() => {});
  }, []);
  const [pendingMerge, setPendingMerge] = useState<{
    source: WorkspaceFeed;
    target: WorkspaceFeed;
  } | null>(null);
  const floorRef = useRef<HTMLDivElement>(null);
  const layout = useWorkspace((s) => s.layout);
  const appearance = useWorkspace((s) => s.appearance);
  const hydrated = useWorkspace((s) => s.hydrated);
  const hydrate = useWorkspace((s) => s.hydrate);
  const applyDropToLayout = useWorkspace((s) => s.applyDrop);
  const insertFeedLayout = useWorkspace((s) => s.insertFeed);
  const removeFeedLayout = useWorkspace((s) => s.removeFeed);
  const restoreSlotLayout = useWorkspace((s) => s.restoreSlot);
  const resizeSlotLayout = useWorkspace((s) => s.resizeSlot);
  const setVesselBrightness = useWorkspace((s) => s.setVesselBrightness);
  const setVesselDensity = useWorkspace((s) => s.setVesselDensity);
  const setVesselTextSize = useWorkspace((s) => s.setVesselTextSize);
  const regimented = useWorkspace((s) => s.regimented);
  const materializeRegimented = useWorkspace((s) => s.materializeRegimented);

  // The reader, the article editor and the note composer are the THREE
  // immersive panes: immersion belongs to the surfaces where one piece fills
  // the whole of your attention — reading it, and writing it at either length.
  // While one is open it may cover the nav bar entirely (Glasshouse
  // `coverNavChrome`), so the bar + muster un-mount and only the z-60 ∀ lockup
  // floats above. Every OTHER pane — messages, dashboard, settings, the FEED
  // composer — is a panel you dip into while the workspace is still what you
  // are doing, and keeps the bar live (navigation over an open pane —
  // WORKSPACE-COLUMN-LAYOUT §VI).
  //
  // This gate is not decoration: `coverNavChrome` is a contract, and a pane
  // that covers the bar while the bar still paints puts the bar on top of the
  // pane. One Glasshouse opens at a time (the module-level `activeGlasshouse`
  // registry supersedes whatever was open), so no two can both be true; if
  // that ever changes the gate is still correct.
  //
  // The editor store is global and `EditorOverlay` mounts in `LayoutShell`, a
  // different tree — same store, so this subscription is correct from either.
  // It is read REACTIVELY here; the two `getState()` reads elsewhere in this
  // file are hotkey guards and deliberately non-reactive.
  const readerOpen = useReader((s) => s.isOpen);
  const editorOpen = useEditorOverlay((s) => s.isOpen);
  const immersivePaneOpen = readerOpen || editorOpen || !!composerOpen;

  // The numeral is persisted rank, not creation order (MOBILE-LAYOUT-ADR
  // §VII). NAV-ROW-MUSTER-ADR §III: the numeral is IDENTITY, assigned over the
  // LIVE feed set — every undeleted feed, hidden included — so a feed keeps its
  // number when a neighbour is minimised. `liveSorted` is that set in numeral
  // order; `visibleSorted` (hidden filtered out) is a subsequence of it and
  // stays the layout/parade ordering, so the floor and parade still fall in
  // numeral order — they just read with gaps (1, 2, 4, 5) where a feed is away.
  // Declared here rather than beside its consumers because the regimented view
  // (§V) is ordered by `visibleSorted`.
  const feedRankComparator = (a: VesselState, b: VesselState) =>
    a.feed.sortRank - b.feed.sortRank ||
    a.feed.createdAt.localeCompare(b.feed.createdAt) ||
    a.feed.id.localeCompare(b.feed.id);
  const liveSorted = [...vessels].sort(feedRankComparator);
  const visibleSorted = liveSorted.filter((v) => !v.feed.hidden);
  const feedNumerals = new Map<string, number>();
  liveSorted.forEach((v, i) => feedNumerals.set(v.feed.id, i + 1));

  // ── The columnar floor ───────────────────────────────────────────────────
  // Geometry is DERIVED, never stored: one pure function turns the persisted
  // order (columns × slots) into final canvas rects and a taut floor width.
  // A state that violates the spacing rules is unrepresentable, so there is no
  // extent to reconcile, no origin to compensate, and nothing to heal — the
  // free-coordinate floor's canvas.ts and collision.ts are gone.
  const [viewport, setViewport] = useState({ w: 1280, h: 800 });
  useEffect(() => {
    function measure() {
      setViewport({ w: window.innerWidth, h: window.innerHeight });
    }
    measure();
    window.addEventListener("resize", measure);
    return () => window.removeEventListener("resize", measure);
  }, []);

  // THE BAR IS A HEIGHT AGAIN, BUT IT IS STILL AN INSET, NOT A RESERVATION
  // (NavBar.tsx). The original bottom nav row ate the bottom of the floor inside
  // derivation — a `navRowH` on the viewport that ended the available height one
  // GRID above it — and that parameter is gone for good. The top bar does what
  // the left rail did instead: it insets the scroll VIEWPORT (the Floor's
  // `insetTop` below) and derivation simply works in the shorter height, so
  // there is ONE number doing the reserving rather than two that can disagree.
  // Everything downstream that asks "how tall is the floor" must read `vp.h`,
  // not `viewport.h` — the two differ by the bar. Mobile has no desktop bar (its
  // own bar is top-anchored and the pager, not the canvas, owns the layout
  // there).
  const barH = isMobile ? 0 : NAV_BAR_H;
  const vp = useMemo(
    () => ({ w: viewport.w, h: viewport.h - barH }),
    [viewport.w, viewport.h, barH],
  );

  // A live resize proposal, merged into the derivation input so the columns to
  // the RIGHT of the handle slide with it instead of jumping on release. The
  // store is untouched until the commit.
  const [resizePreview, setResizePreview] = useState<{
    feedId: string;
    w: number;
    h: number;
  } | null>(null);
  // Ref mirror for the `\` handler (whose listener closes over stale state):
  // a live resize must block the mode toggle the same way a live drag does —
  // reflowing the floor under a captured handle, then committing, would stamp
  // the parade over the stored layout.
  const resizeActiveRef = useRef(false);
  useEffect(() => {
    resizeActiveRef.current = resizePreview !== null;
  }, [resizePreview]);

  // §V. Regimented mode is a VIEW over the feed list, not an edit: the stored
  // layout stays exactly as it was, so leaving the mode is free and there is no
  // snapshot to lose. The parade order is the numeral order — `sortRank: i + 1`
  // over `visibleSorted`, so the derived columns read 1..N left to right even
  // where two feeds share a server rank. The id key keeps the array stable
  // across renders; without it every render would re-derive the geometry and
  // re-render every vessel.
  const visibleIdsKey = visibleSorted.map((v) => v.feed.id).join("\0");
  const regimentedFeeds = useMemo(
    () =>
      visibleIdsKey
        ? visibleIdsKey
            .split("\0")
            .map((id, i) => ({ id, sortRank: i + 1 }))
        : [],
    [visibleIdsKey],
  );
  // The layout the floor is arranged by, before any live resize proposal:
  // the stored one, or the transient parade-ground derivation.
  const baseLayout = useMemo(
    () => (regimented ? regimentedLayout(regimentedFeeds, vp) : layout),
    [regimented, regimentedFeeds, vp, layout],
  );
  const baseLayoutRef = useRef(baseLayout);
  baseLayoutRef.current = baseLayout;

  const geomLayout = useMemo(
    () =>
      resizePreview
        ? withSlotSize(baseLayout, resizePreview.feedId, resizePreview)
        : baseLayout,
    [baseLayout, resizePreview],
  );
  const geom = useMemo(
    () => deriveGeometry(geomLayout, vp),
    [geomLayout, vp],
  );
  const geomRef = useRef<Geometry>(geom);
  geomRef.current = geom;
  const geomLayoutRef = useRef(geomLayout);
  geomLayoutRef.current = geomLayout;

  // Ctrl+←/→ panned the floor to its far ends. The queue has nothing to pan
  // (its walk is ←/→, WORKSPACE-QUEUE-ADR §VI), so it went with the mode (C2).

  // The local, non-Glasshouse transient surfaces. With `lensSuppress` gone
  // (Slice 4) there is no generic "a modal is open" registry, and these are all
  // plain component state anyway — so the `\` handler reads them off a ref
  // instead of re-attaching its listener every time one opens.
  const localSurfaceOpenRef = useRef(false);
  localSurfaceOpenRef.current =
    newFeedOpen ||
    !!pendingMerge ||
    !!feedComposerFor ||
    !!composerOpen ||
    !!ceremony;

  // `\` was the parade ground (§V). Dropped with the floor
  // (WORKSPACE-QUEUE-ADR §XI.2 R3): the muster and the compact entries are the
  // overview, and the key is free.

  const dragActiveRef = useRef<string | null>(null);
  // What the last drag frame resolved to (§IV.2). One resolver answers both
  // questions the old floor asked separately: a `merge` arms the target under
  // the pointer's CENTRAL region, an insertion paints the stripe at the
  // boundary it would take. Kept in a ref as well so the release commit reads
  // the frame's answer, not a stale render's.
  const [drop, setDrop] = useState<Drop | null>(null);
  const dropRef = useRef<Drop | null>(null);
  const armedMergeTarget = drop?.kind === "merge" ? drop.targetFeedId : null;

  // ── Virtualization (WORKSPACE-COLUMN-LAYOUT-ADR §VII) ────────────────────
  // What is off-screen costs nothing: a vessel more than a viewport away keeps
  // its chassis and loses its contents. The heavy per-feed state (items,
  // nextCursor, caught-up watermark) is VesselState, here in the host, so an
  // unmount discards only the React tree, its DOM and its decoded media —
  // there is nothing to tear down and nothing to refetch (the client holds no
  // relay connections; content arrives over the gateway REST API).
  //
  // The band is measured against the derived rects, which ARE canvas
  // coordinates — with the signed origin gone there is only one space, so the
  // pan offset is plain `scrollLeft`. A dead band of VIRT_QUANT px of pan
  // before the set is re-read supplies the hysteresis: a vessel straddling the
  // boundary needs a real scroll, not a jitter, to flip.
  const [panOffset, setPanOffset] = useState(0);
  const panOffsetRef = useRef(0);
  const virtRafRef = useRef<number | null>(null);
  const syncPan = useCallback(() => {
    const floor = floorRef.current;
    if (!floor) return;
    const next = floor.scrollLeft;
    if (Math.abs(next - panOffsetRef.current) < VIRT_QUANT) return;
    panOffsetRef.current = next;
    setPanOffset(next);
  }, []);
  useEffect(() => {
    const floor = floorRef.current;
    if (!floor || isMobile) return;
    function onScroll() {
      if (virtRafRef.current !== null) return;
      virtRafRef.current = requestAnimationFrame(() => {
        virtRafRef.current = null;
        syncPan();
      });
    }
    floor.addEventListener("scroll", onScroll, { passive: true });
    return () => {
      floor.removeEventListener("scroll", onScroll);
      if (virtRafRef.current !== null)
        cancelAnimationFrame(virtRafRef.current);
      virtRafRef.current = null;
    };
    // Re-attach on auth-resolve: the pre-auth frame renders a Floor without
    // the ref, so the listener must bind once the real floor exists.
  }, [user?.id, loading, isMobile, syncPan]);
  // Cold start and layout changes. The dead band only fires on real scroll
  // events, so a floor that mounts already scrolled (a browser restoring a
  // position, an auto-pan) would otherwise start with a stale band.
  useLayoutEffect(() => {
    if (isMobile) return;
    syncPan();
  }, [isMobile, syncPan, geom, bootstrap]);

  const visibleIds = useMemo(() => {
    const lo = panOffset - vp.w;
    const hi = panOffset + vp.w * 2;
    const ids = new Set<string>();
    for (const [id, r] of geom.rects) {
      if (r.x + r.w >= lo && r.x <= hi) ids.add(id);
    }
    return ids;
  }, [geom, panOffset, vp.w]);

  // The muster's in-view test (NAV-ROW-MUSTER-ADR §IV, "Driving the state
  // flip"). Deliberately NOT `visibleIds`: that is the three-viewport MOUNT band
  // `[panOffset − w, panOffset + 2w]`, so reusing it would paint three screens
  // of roundels as "in view" at once — the exact over-report §I defines "in
  // view" against. This is the tighter real-viewport band `[panOffset,
  // panOffset + w]`. It inherits the VIRT_QUANT hysteresis for free by reading
  // the same quantised `panOffset`, so a roundel straddling the edge needs a
  // genuine scroll to flip, not a jitter.
  const musterInView = useMemo(() => {
    const lo = panOffset;
    const hi = panOffset + vp.w;
    const ids = new Set<string>();
    for (const [id, r] of geom.rects) {
      if (r.x + r.w > lo && r.x < hi) ids.add(id);
    }
    return ids;
  }, [geom, panOffset, vp.w]);

  // ── The reading counts (WORKSPACE-QUEUE-ADR §IV) ─────────────────────────
  // Desktop floor only; mobile is out of scope (§IX), so its cards carry no
  // mark and nothing there polls, tracks or dwells.
  //
  // A floor pan in progress is not attention to any vessel (§IV.4): the flag
  // rises on the floor's scroll and falls a beat after the last one.
  const [floorPanning, setFloorPanning] = useState(false);
  useEffect(() => {
    const floor = floorRef.current;
    if (!floor || isMobile) return;
    let settle: ReturnType<typeof setTimeout> | null = null;
    function onScroll() {
      setFloorPanning(true);
      if (settle) clearTimeout(settle);
      settle = setTimeout(() => setFloorPanning(false), 200);
    }
    floor.addEventListener("scroll", onScroll, { passive: true });
    return () => {
      floor.removeEventListener("scroll", onScroll);
      if (settle) clearTimeout(settle);
    };
  }, [user?.id, loading, isMobile]);
  // A pane over the floor holds the member's attention, whatever the pointer
  // happened to be resting on when it opened.
  const paneOpen = useGlasshousePresence((s) => s.isOpen);

  // The floor polls the counts; the queue reads counts AND page one into its
  // buffer, on its own slower clock (`prefetchQueueFeed`, below).
  useSeenPolling(
    visibleSorted.map((v) => v.feed.id),
    bootstrap === "ready" && !isMobile && !queueMode,
  );

  // Forget the passed sets of feeds that are gone (deleted, merged away);
  // hidden feeds are still live and keep theirs.
  const liveIdsKey = vessels.map((v) => v.feed.id).join("\0");
  useEffect(() => {
    if (bootstrap !== "ready") return;
    useFeedSeen
      .getState()
      .reconcileFeeds(liveIdsKey ? liveIdsKey.split("\0") : []);
  }, [bootstrap, liveIdsKey]);

  /** After a membership change the member made themselves — a source added,
   *  removed, re-tuned, moved or merged — the window is refetched at once
   *  rather than at the next poll (§IV.2). A source's back-catalogue is never
   *  NEW: the server flags only what was published after the source joined. */
  function refetchSeen(feedId: string) {
    if (isMobile) return;
    useFeedSeen
      .getState()
      .fetchWindow(feedId)
      .catch((err) => console.warn("feedSeen: refetch failed", feedId, err));
  }

  /** Viewport pointer → floor coordinates, the space `geom.rects` live in. */
  const toFloorSpace = useCallback((pointer: { x: number; y: number }) => {
    const floor = floorRef.current;
    if (!floor) return null;
    const r = floor.getBoundingClientRect();
    return {
      x: pointer.x - r.left + floor.scrollLeft,
      y: pointer.y - r.top,
    };
  }, []);

  /**
   * §IV.3's clamp, per resize frame: width is free (growing a slot widens its
   * column and the columns to the right slide), height stops at what the stack
   * can still hold. Nothing is displaced either way, so there is no
   * `clampSizeClear` successor.
   *
   * It clamps against the layout the floor is CURRENTLY arranged by, which
   * under regimented mode is the parade derivation rather than the stored
   * layout — the handle must stop where the visible stack ends, and the commit
   * (which materialises that same derivation first) then agrees with it.
   */
  const clampVesselResize = useCallback(
    (feedId: string, proposed: { w: number; h: number }) =>
      clampSlotSize(baseLayoutRef.current, feedId, proposed, vp),
    [vp],
  );

  /**
   * §V. A layout MUTATION leaves regimented mode: the parade arrangement is
   * stamped as the new custom layout, and the caller's one edit then applies on
   * top of it. Both mutations (a committed drop, a resize commit) were resolved
   * against exactly this derivation, so their indices and stack address the
   * layout they land on. Feed-list changes — merge, hide, delete, adopt — are
   * NOT layout edits: they apply to the stored layout and the parade view
   * simply re-derives over the new list. Appearance changes likewise apply in
   * place without exiting.
   */
  function materializeIfRegimented() {
    if (regimented) materializeRegimented(regimentedFeeds, vp);
  }

  function handleVesselDragStart(feedId: string) {
    dragActiveRef.current = feedId;
    // D11 drag-suspension seam (inert under the frozen floor; see explain.ts).
    if (useExplain.getState().isActive) useExplain.getState().setDragging(feedId);
  }

  /**
   * One resolver per frame (§IV.2). The lifted vessel's slot is HELD OPEN for
   * the whole gesture — nothing is spliced until release — so `geom` is stable
   * and the resolver runs against a fixed frame; that is also what makes a
   * cancelled drop a pure spring-back with no placement work at all.
   */
  const handleVesselDragFrame = useCallback(
    (feedId: string, pointer: { x: number; y: number }) => {
      const p = toFloorSpace(pointer);
      if (!p) return;
      const slot = slotFor(geomLayoutRef.current, feedId);
      if (!slot) return;
      const next = resolveDrop(geomLayoutRef.current, geomRef.current, p, {
        feedId,
        w: slot.w,
        h: slot.h,
      });
      // Reference equality is meaningless on a freshly built Drop, so compare
      // by value — a per-frame setState with an identical payload would
      // re-render the whole floor on every pointermove.
      const prev = dropRef.current;
      if (prev && sameDrop(prev, next)) return;
      dropRef.current = next;
      setDrop(next);
    },
    [toFloorSpace],
  );

  function handleVesselDragEnd(feedId: string) {
    dragActiveRef.current = null;
    if (useExplain.getState().draggingFeedId) useExplain.getState().setDragging(null);

    const resolved = dropRef.current;
    dropRef.current = null;
    setDrop(null);
    if (!resolved) return;

    if (resolved.kind === "merge") {
      const source = vessels.find((v) => v.feed.id === feedId);
      const target = vessels.find((v) => v.feed.id === resolved.targetFeedId);
      // The source never left the layout, so there is nothing to place while
      // the question is open and nothing to repair if it is declined — the
      // vessel simply springs back to its held-open slot.
      if (source && target)
        setPendingMerge({ source: source.feed, target: target.feed });
      return;
    }

    // A "never mind" release — back into the held-open slot, or a band drop
    // that lands identically — commits NOTHING. This matters under regimented
    // mode: materialising on a no-op would silently overwrite the user's
    // custom layout with the parade, the exact loss §V's no-snapshot design
    // exists to rule out. (Checked against the same derivation the drop's
    // indices address — the parade while regimented, the stored layout
    // otherwise.)
    if (dropIsNoop(geomLayoutRef.current, feedId, resolved)) return;

    materializeIfRegimented();
    applyDropToLayout(feedId, resolved);
  }

  async function handleMergeConfirm() {
    if (!pendingMerge) return;
    const { source, target } = pendingMerge;
    // A failed merge REJECTS to the dialog, which owns failure: it stays open,
    // paints the error line, and offers retry. Clearing pendingMerge here on
    // error unmounted the dialog before its error state could ever paint — a
    // failed merge read as a silent close. Neither outcome needs placement
    // work: the source never left the layout (§IV.4).
    await workspaceFeedsApi.merge(target.id, source.id);
    setVessels((prev) => prev.filter((v) => v.feed.id !== source.id));
    // Refetch the enlarged target OUTSIDE the updater — an updater must stay
    // pure (see adoptFeed's note on deferred re-evaluation).
    const targetVessel = vesselsRef.current.find(
      (v) => v.feed.id === target.id,
    );
    if (targetVessel) void loadVesselItems(targetVessel.feed);
    refetchSeen(target.id);
    removeFeedLayout(source.id);
    clearExpandedFor(source.id);
    forgetFeedReadState(source.id);
    setPendingMerge(null);
  }

  // PER-FEED LOAD SEQUENCING. A vessel's items + cursor are written by two
  // things — a page-one load (`loadVesselItems`) and load-more (page N+1) —
  // and the `loadingMoreRef` latch below only serialises load-more against
  // itself. So a refresh landing while a load-more was in flight appended the
  // OLD sequence's page 2 to the NEW page 1 and stamped the old cursor over the
  // new one: the slice between them is skipped and never revisited, and the
  // vessel then pages down a sequence that no longer matches what it is
  // showing. A monotonic token per feed, claimed before the fetch and checked
  // after it, makes the loser discard its answer instead of merging it.
  //
  // The tokens live in `feedLoads` (`lib/workspace/feedLoads.ts`,
  // WORKSPACE-QUEUE-ADR §VI.5). Not React state: the check has to see the
  // claim made moments ago in the same tick — the reason `loadingMoreRef` is a
  // ref too.
  const [feedLoads] = useState(createFeedLoads);

  // Page one, REPLACING the list: the floor's refresh and every change to what
  // a feed IS (its sources, its volume, a merge into it), in both modes — the
  // tail is thrown away, because a merge would keep the posts those changes
  // removed. The queue's own refreshes never come here: they reveal what the
  // buffer holds (`revealQueueFeeds`, below).
  const loadVesselItems = useCallback(
    async (feed: WorkspaceFeed): Promise<PageOneResult<null>> => {
      // A refresh collapses this vessel's open conversation.
      clearExpandedFor(feed.id);

      let prevIds: Set<string> | null = null;
      setVessels((prev) =>
        prev.map((v) => {
          if (v.feed.id !== feed.id) return v;
          if (v.status === "ready" && v.items.length > 0) {
            prevIds = new Set(v.items.map(itemKey));
          }
          return { ...v, status: "loading", caughtUp: false };
        }),
      );
      const result = await loadPageOne(
        feedLoads,
        feed.id,
        async () => {
          const data = await workspaceFeedsApi.items(feed.id, { limit: FEED_PAGE_SIZE });
          // The page's asOf is a fact about the server's clock whether or not
          // this answer survives the sequence check: the newest one held is
          // what a look sends (WORKSPACE-QUEUE-ADR §IV.4).
          useFeedSeen.getState().noteAsOf(feed.id, data.asOf);
          return data;
        },
        (data): null => {
          const mapped = data.items ?? [];
          const caughtUp =
            prevIds !== null &&
            mapped.length > 0 &&
            mapped.every((i) => (prevIds as Set<string>).has(itemKey(i)));
          setVessels((prev) =>
            prev.map((v) =>
              v.feed.id === feed.id
                ? {
                    ...v,
                    feed: data.feed,
                    items: mapped,
                    status: "ready",
                    caughtUp,
                    nextCursor: data.nextCursor ?? null,
                    loadingMore: false,
                  }
                : v,
            ),
          );
          return null;
        },
      );
      if (result.status === "failed") {
        console.error("Vessel items load error:", result.error);
        setVessels((prev) =>
          prev.map((v) =>
            v.feed.id === feed.id ? { ...v, status: "error" } : v,
          ),
        );
      }
      return result;
    },
    [clearExpandedFor, feedLoads],
  );

  // ── The queue's buffer (the operator, 2026-09-26) ───────────────────────
  // FETCHED ON A TIMER, SHOWN ON A GESTURE. Each visible feed's page one and
  // window are read every QUEUE_PREFETCH_MS (`useSeenPolling`, below) into a
  // buffer nothing displays; the window is adopted as it lands, so the badges
  // are live, but nothing moves. A pull REVEALS the buffer — merged in at
  // once, with no wait on the network, so the result lands with the gesture
  // that asked for it — and pokes a fresh read of that feed into the buffer
  // for next time, which also restarts its clock.
  //
  // A buffered page is stamped with the feed's load token when its read
  // STARTED, and is shown only if no page-one read has been claimed since:
  // a replace (a source removed, a volume change) would otherwise have the
  // posts it took away merged back in from an older page.
  type ItemsPage = Awaited<ReturnType<typeof workspaceFeedsApi.items>>;
  const bufferRef = useRef(new Map<string, { gen: number; page: ItemsPage }>());
  // The clock runs one read per feed at a time, but a feed that leaves the
  // list and rejoins gets a fresh slot: only the newest-started read fills
  // the buffer.
  const bufferSeqRef = useRef(new Map<string, number>());
  const prefetchQueueFeed = useCallback(
    async (feedId: string) => {
      const gen = feedLoads.current(feedId);
      const seq = (bufferSeqRef.current.get(feedId) ?? 0) + 1;
      bufferSeqRef.current.set(feedId, seq);
      const [page] = await Promise.all([
        workspaceFeedsApi.items(feedId, { limit: FEED_PAGE_SIZE }),
        useFeedSeen.getState().fetchWindow(feedId),
      ]);
      useFeedSeen.getState().noteAsOf(feedId, page.asOf);
      if (bufferSeqRef.current.get(feedId) === seq)
        bufferRef.current.set(feedId, { gen, page });
    },
    [feedLoads],
  );

  /** Merge pages onto what is loaded, in ONE render, where the two provably
   *  touch (`mergeFirstPage`). No LOADING… (the list the reader is in stays),
   *  no caught-up tile (§VII.9: the mouth says it). */
  const applyMergedPages = useCallback(
    (pages: Map<string, ItemsPage>): Map<string, MergeOutcome> => {
      const outcomes = new Map<string, MergeOutcome>();
      if (pages.size === 0) return outcomes;
      // A mounted list the reader is part-way down keeps its card: posts
      // merged in above it must not move it (B4's note). At the very top the
      // reader is looking at the newest posts, and what arrives there is what
      // the mouth is about to announce.
      //
      // AND A LIST AT THE TOP IS PUT BACK AT THE TOP (operator, 2026-09-27).
      // A pull only starts there, and it must leave the reader above what it
      // brought, never below it — but two things carry the view down onto the
      // old first card: the browser's own scroll anchoring, and the collapse
      // of an open conversation (`settleExpansion`), which holds its host card
      // still one frame after the new posts land above it. So the top is
      // pinned now, and again on the next frame, after that hold has run.
      const holds: { scroller: HTMLElement; anchor: CardAnchor }[] = [];
      const tops: HTMLElement[] = [];
      for (const id of pages.keys()) {
        const scroller = document.querySelector<HTMLElement>(
          `[data-queue-feed="${CSS.escape(id)}"] [data-vessel-scroll]`,
        );
        if (!scroller) continue;
        if (scroller.scrollTop > 0)
          holds.push({ scroller, anchor: captureCardAnchor(scroller) });
        else tops.push(scroller);
      }
      const windows = useFeedSeen.getState().windows;
      flushSync(() =>
        setVessels((prev) =>
          prev.map((v) => {
            const data = pages.get(v.feed.id);
            if (!data) return v;
            const r = mergeFirstPage(
              v.status === "ready" ? v.items : [],
              data.items ?? [],
              { pageSize: FEED_PAGE_SIZE, window: windows[v.feed.id]?.items },
            );
            outcomes.set(v.feed.id, r.outcome);
            return {
              ...v,
              feed: data.feed,
              items: r.items,
              status: "ready",
              caughtUp: false,
              nextCursor: r.keepCursor ? v.nextCursor : (data.nextCursor ?? null),
              loadingMore: false,
            };
          }),
        ),
      );
      for (const h of holds) if (h.scroller.isConnected) restoreCardAnchor(h.scroller, h.anchor);
      if (tops.length > 0) {
        for (const el of tops) el.scrollTop = 0;
        requestAnimationFrame(() => {
          for (const el of tops) if (el.isConnected) el.scrollTop = 0;
        });
      }
      return outcomes;
    },
    [],
  );

  // Every QUEUE_PREFETCH_MS, staggered, paused while the tab is hidden, and
  // on return only the feeds that fell due meanwhile; a pull pokes its feed
  // at once and restarts its clock.
  const pokeQueueFeed = useSeenPolling(
    visibleSorted.map((v) => v.feed.id),
    bootstrap === "ready" && !isMobile && queueMode,
    {
      intervalMs: QUEUE_PREFETCH_MS,
      fire: prefetchQueueFeed,
      firstPass: "interval",
      onReturn: "due",
    },
  );
  /** Show what the buffer holds for these feeds, now, and read each afresh
   *  for next time (`planReveal` decides which). A feed with nothing shown
   *  reveals nothing — `null` in the result; a failed one with nothing
   *  buffered is reloaded instead. */
  const revealQueueFeeds = useCallback(
    (feedIds: string[]): Map<string, MergeOutcome | null> => {
      const plan = planReveal(
        feedIds,
        bufferRef.current,
        (id) => vesselsRef.current.find((x) => x.feed.id === id)?.status,
        feedLoads.current,
      );
      for (const id of plan.drop) bufferRef.current.delete(id);
      // Something is shown, so the feed's open conversation collapses.
      for (const id of plan.show.keys()) clearExpandedFor(id);
      for (const id of plan.reload) {
        const v = vesselsRef.current.find((x) => x.feed.id === id);
        if (v) void loadVesselItems(v.feed);
      }
      // One feed is read now; the edge pull's many are spread (the read only
      // fills the buffer for NEXT time, so nothing waits on it).
      pokeQueueFeed(plan.poke);
      const outcomes = applyMergedPages(plan.show);
      for (const id of plan.reload)
        outcomes.set(id, { kind: "reloaded", reason: "failed", newCount: 0 });
      return new Map(feedIds.map((id) => [id, outcomes.get(id) ?? null]));
    },
    [applyMergedPages, clearExpandedFor, feedLoads, loadVesselItems, pokeQueueFeed],
  );

  // Feed ids with a load-more request in flight. This is the CONCURRENCY guard;
  // the vessel's own `loadingMore` field is presentation only (it drives the
  // queue's tail line). React state can't guard here: `vesselsRef` only catches up on
  // re-render, so two scroll events firing in the same tick would both read
  // `loadingMore: false` and fetch the same cursor twice, appending a duplicate
  // page. A ref latch flips synchronously, so the second call returns early.
  const loadingMoreRef = useRef<Set<string>>(new Set());

  // Infinite scroll: pull the next page of older content for a vessel and append
  // it. Guarded against exhausted loads via the live vessel state (read from the
  // ref so the callback stays stable) and against concurrent loads via the latch
  // above. New keys are de-duped against what's already shown so a cursor
  // overlap can't double a card.
  const loadMoreVesselItems = useCallback(async (feedId: string) => {
    const current = vesselsRef.current.find((v) => v.feed.id === feedId);
    if (
      !current ||
      current.status !== "ready" ||
      loadingMoreRef.current.has(feedId) ||
      !current.nextCursor
    ) {
      return;
    }
    loadingMoreRef.current.add(feedId);
    // Read, don't claim: a page appended to the sequence it was read from is
    // still that sequence. A refresh CLAIMS a new one and this then discards.
    const gen = feedLoads.current(feedId);
    const cursor = current.nextCursor;
    setVessels((prev) =>
      prev.map((v) =>
        v.feed.id === feedId ? { ...v, loadingMore: true } : v,
      ),
    );
    try {
      const data = await workspaceFeedsApi.items(feedId, { cursor });
      useFeedSeen.getState().noteAsOf(feedId, data.asOf);
      if (!feedLoads.isCurrent(feedId, gen)) return;
      const mapped = data.items ?? [];
      setVessels((prev) =>
        prev.map((v) => {
          if (v.feed.id !== feedId) return v;
          const seen = new Set(v.items.map(itemKey));
          const additions = mapped.filter((m) => !seen.has(itemKey(m)));
          return {
            ...v,
            items: [...v.items, ...additions],
            nextCursor: data.nextCursor ?? null,
            loadingMore: false,
          };
        }),
      );
    } catch (err) {
      console.error("Vessel load-more error:", err);
      if (!feedLoads.isCurrent(feedId, gen)) return;
      setVessels((prev) =>
        prev.map((v) =>
          v.feed.id === feedId ? { ...v, loadingMore: false } : v,
        ),
      );
    } finally {
      loadingMoreRef.current.delete(feedId);
    }
  }, [feedLoads]);

  const vesselsRef = useRef(vessels);
  vesselsRef.current = vessels;

  // REFRESH THE WHOLE WORKSPACE — every vessel's first page again, plus the
  // unread badge the lockup itself carries. Two callers: a publish (so the
  // piece you just sent appears where it will live) and the nav bar's WORDMARK
  // (2026-09-14 — ForallMenu's `onRefreshAll`, the desktop twin of mobile's
  // per-feed pull-to-refresh, which was the canvas's only refresh gesture) —
  // on the FLOOR only since 2026-09-26: in the queue the wordmark opens the
  // menu, and the edge pull is the reveal.
  //
  // It is deliberately NOT a re-bootstrap: the bootstrap effect also restores
  // layout, appearance and the first-run gates, and re-running it to fetch
  // posts would move the furniture under someone who asked for new posts. What
  // refreshes is what changes on its own — items, and what is unread.
  function refreshAll() {
    // Refreshing every vessel collapses every expanded conversation.
    setExpandedByFeed({});
    vesselsRef.current.forEach((v) => void loadVesselItems(v.feed));
    void useUnreadCounts.getState().fetch();
  }

  /** A publish. On the floor, every feed's page one again, so the piece
   *  appears where it will live. In the queue nothing is shown that the
   *  reader did not pull: every feed is read into its buffer now, so the
   *  badge says there is something new and the next pull shows it. */
  function refreshAfterPublish() {
    if (queueMode) {
      pokeQueueFeed(visibleSorted.map((v) => v.feed.id));
      void useUnreadCounts.getState().fetch();
    } else refreshAll();
  }

  /** Every visible feed's buffer, shown. Resolves nothing: the answer is in
   *  memory already. */
  function revealAllQueueFeeds(): Map<string, MergeOutcome | null> {
    void useUnreadCounts.getState().fetch();
    return revealQueueFeeds(
      vesselsRef.current.filter((v) => !v.feed.hidden).map((v) => v.feed.id),
    );
  }

  function handleForallAction(key: ForallAction) {
    if (key === "new-note") {
      openNoteComposer();
      return;
    }
    if (key === "new-feed") {
      setNewFeedOpen(true);
      return;
    }
  }

  // Hide is feed character (MOBILE-LAYOUT-ADR §V): persisted on the feed row
  // via the PATCH, not in per-device layout state. Optimistic flip so the
  // vessel hides/returns instantly; reconcile with the server row (or revert)
  // when the PATCH settles.
  //
  // The LAYOUT half is §IV.5: hiding splices the slot and recomputation
  // compacts the floor — there are no holes to leave behind — and unhiding
  // re-enters as a new right-most column at factory size. Both move with the
  // optimistic flip, and both revert with it.
  async function handleSetFeedHidden(feedId: string, hidden: boolean) {
    setVessels((prev) =>
      prev.map((v) =>
        v.feed.id === feedId ? { ...v, feed: { ...v.feed, hidden } } : v,
      ),
    );
    // Capture the slot's home before the optimistic removal so a failed PATCH
    // can put it BACK THERE — the plain insertFeed revert re-entered at a
    // fresh right-most factory column, so a transient network failure
    // rearranged the floor (2026-07-22 audit fix).
    const removedFrom = hidden
      ? locateSlot(useWorkspace.getState().layout, feedId)
      : null;
    // For an unhide, remember whether the feed ALREADY had a slot (a
    // double-fired restore whose first PATCH succeeded): insertFeed is an
    // idempotent no-op then, and the failure revert below must not remove a
    // slot this call never added.
    const hadSlotAlready =
      !hidden && locateSlot(useWorkspace.getState().layout, feedId) !== null;
    if (hidden) removeFeedLayout(feedId);
    else insertFeedLayout(feedId);
    try {
      const { feed } = await workspaceFeedsApi.setHidden(feedId, hidden);
      setVessels((prev) =>
        prev.map((v) => (v.feed.id === feed.id ? { ...v, feed } : v)),
      );
    } catch (err) {
      console.error("Set feed hidden failed:", err);
      setVessels((prev) =>
        prev.map((v) =>
          v.feed.id === feedId
            ? { ...v, feed: { ...v.feed, hidden: !hidden } }
            : v,
        ),
      );
      if (hidden) {
        if (removedFrom) restoreSlotLayout(removedFrom);
        else insertFeedLayout(feedId);
      } else if (!hadSlotAlready) {
        removeFeedLayout(feedId);
      }
    }
  }

  function handleRestoreHiddenFeed(feedId: string) {
    void handleSetFeedHidden(feedId, false);
  }

  // ── Muster navigation (NAV-ROW-MUSTER-ADR §V) ─────────────────────────────
  // One verb for all three roundel states: GO TO THIS FEED. In view → pan so it
  // sits at the leading edge; panned off → smooth-scroll it in (same scroll,
  // different starting distance); minimised → restore, then scroll once its rect
  // exists. Every path first dismisses any open Glasshouse pane: the muster is
  // clickable over a pane (z-58 > 56), and leaving a modal floating over the
  // newly-scrolled floor is incoherent — this is the one place the muster
  // "edits" (it edits nothing; it gets out of the way of the navigation).
  //
  // A restored feed re-enters as a new right-most column (§IV.5), so its rect
  // does not exist until the next derivation. Rather than guess with a timer,
  // stash the target and let a geom-keyed effect scroll the moment the rect
  // appears — correct regardless of how many frames the restore takes.
  const pendingScrollRef = useRef<string | null>(null);

  const scrollFeedToLead = useCallback((feedId: string) => {
    const r = geomRef.current.rects.get(feedId);
    const floor = floorRef.current;
    if (!r || !floor) return;
    // Leading edge one GRID in from the viewport's left. rects are final canvas
    // coords in the floor's own scroll space, so scrollLeft maps 1:1.
    floor.scrollTo({
      left: Math.max(0, r.x - GRID),
      behavior: prefersReducedMotion() ? "auto" : "smooth",
    });
  }, []);

  const goToFeed = useCallback(
    (feedId: string) => {
      useGlasshousePresence.getState().close();
      const feed = vessels.find((v) => v.feed.id === feedId)?.feed;
      if (feed?.hidden) {
        pendingScrollRef.current = feedId;
        void handleSetFeedHidden(feedId, false);
      } else {
        scrollFeedToLead(feedId);
      }
    },
    // handleSetFeedHidden is a stable module-scope closure over refs/setters;
    // vessels is the only reactive read.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [vessels, scrollFeedToLead],
  );

  useEffect(() => {
    const id = pendingScrollRef.current;
    if (!id) return;
    if (!geom.rects.has(id)) return; // restored feed not laid out yet
    pendingScrollRef.current = null;
    scrollFeedToLead(id);
  }, [geom, scrollFeedToLead]);

  // The live feed list the muster renders (§IV): one roundel per feed in numeral
  // order, hidden included, each tagged in-view / panned-off / minimised.
  const musterFeeds = liveSorted.map((v) => ({
    id: v.feed.id,
    numeral: feedNumerals.get(v.feed.id) ?? 0,
    name: v.feed.name.trim(),
    state: v.feed.hidden
      ? ("minimised" as const)
      : musterInView.has(v.feed.id)
        ? ("in" as const)
        : ("off" as const),
  }));

  // Bulk re-rank (MOBILE-LAYOUT-ADR §VII.3). Optimistic: stamp the new ranks
  // locally so the badges renumber instantly, then reconcile with the
  // authoritative rows. On failure (409 = stale list) refetch the canonical
  // order rather than guessing. Rapid re-ranks (held arrow key) overlap, so
  // each call takes a sequence number and only the latest is allowed to
  // reconcile — a stale response arriving last must not revert a newer order.
  async function handleReorderFeeds(feedIds: string[]) {
    const seq = ++reorderSeqRef.current;
    const rankOf = new Map(feedIds.map((id, i) => [id, i + 1]));
    setVessels((prev) =>
      prev.map((v) => {
        const rank = rankOf.get(v.feed.id);
        return rank !== undefined
          ? { ...v, feed: { ...v.feed, sortRank: rank } }
          : v;
      }),
    );
    const applyFeeds = (feeds: WorkspaceFeed[]) => {
      if (seq !== reorderSeqRef.current) return;
      setVessels((prev) =>
        prev.map((v) => {
          const f = feeds.find((x) => x.id === v.feed.id);
          return f ? { ...v, feed: f } : v;
        }),
      );
    };
    try {
      const { feeds } = await workspaceFeedsApi.reorder(feedIds);
      applyFeeds(feeds);
    } catch (err) {
      console.error("Reorder feeds failed:", err);
      try {
        const { feeds } = await workspaceFeedsApi.list();
        applyFeeds(feeds);
      } catch {
        // Network down — leave the optimistic order; next bootstrap reconciles.
      }
    }
  }

  // The feed the ∀ relativises to: the mobile pager's active feed, resolved to
  // a live + still-visible row. A stale id (feed since hidden/deleted) yields
  // null, so the feed-scoped row simply drops out. Desktop never sets the store
  // (no single active feed), so this stays null there.
  const mobileActiveFeedId = useMobileActiveFeed((s) => s.feedId);
  const currentFeed =
    isMobile && mobileActiveFeedId
      ? (visibleSorted.find((v) => v.feed.id === mobileActiveFeedId)?.feed ??
        null)
      : null;

  function feedDisplayName(feedId: string, feedName: string): string {
    const num = feedNumerals.get(feedId) ?? 1;
    const descriptive = feedName.trim();
    return descriptive ? `Channel ${num}: ${descriptive}` : `Channel ${num}`;
  }

  // ── The queue (WORKSPACE-QUEUE-ADR Phase B) ─────────────────────────────
  // What QueueView reads of each feed. Per-feed data stays here (§VI.2).
  const queueFeeds: QueueFeed[] = liveSorted.map((v) => ({
    id: v.feed.id,
    numeral: feedNumerals.get(v.feed.id) ?? 1,
    name: v.feed.name.trim(),
    hidden: v.feed.hidden,
    createdAt: v.feed.createdAt,
    palette: paletteFor(appearance[v.feed.id]?.brightness, globalDark),
    caughtUp: v.caughtUp,
    hasItems: v.status === "ready" && v.items.length > 0,
    tailNote: v.loadingMore
      ? "loading"
      : v.status === "ready" && v.items.length > 0 && !v.nextCursor
        ? "end"
        : undefined,
    fromStarter: v.feed.fromStarter,
  }));

  // The muster in queue mode shows VISIBLE feeds only (§VII.0 D1): the bars
  // after the last entry are where hidden feeds live in this mode, so the
  // close-X roundels would be a second home. Focal is `in` (`QueueMuster`
  // marks it), everything else `off` — a passed feed is not hidden, so it is
  // never `minimised`. It does not reorder with the queue.
  const queueMusterFeeds = visibleSorted.map((v) => ({
    id: v.feed.id,
    numeral: feedNumerals.get(v.feed.id) ?? 0,
    name: v.feed.name.trim(),
    state: "off" as const,
  }));

  const walkQueueTo = useCallback((feedId: string) => {
    useGlasshousePresence.getState().close();
    queueRef.current?.walkTo(feedId);
  }, []);

  function handleSourceAdded(feedId: string) {
    const v = vesselsRef.current.find((x) => x.feed.id === feedId);
    if (!v) return;
    void loadVesselItems(v.feed);
    refetchSeen(feedId);
    workspaceFeedsApi
      .listSources(feedId)
      .then(({ sources }) =>
        setVessels((prev) =>
          prev.map((vs) => (vs.feed.id === feedId ? { ...vs, sources } : vs)),
        ),
      )
      .catch(() => {});
  }

  const hiddenFeeds = vessels
    .filter((v) => v.feed.hidden)
    .map((v) => ({
      id: v.feed.id,
      name: v.feed.name.trim() || "Unnamed channel",
    }));

  async function handleCardDrop(targetFeedId: string, raw: string) {
    let payload: { feedId: string; feedSourceId: string };
    try {
      payload = JSON.parse(raw);
    } catch {
      return;
    }
    if (payload.feedId === targetFeedId) return;
    try {
      await workspaceFeedsApi.moveSource(
        payload.feedId,
        payload.feedSourceId,
        targetFeedId,
      );
      afterSourceMoved(payload.feedId, targetFeedId);
    } catch (err) {
      console.error("Move source failed:", err);
    }
  }

  /** A source left one feed for another — the floor's card drop, or the ⚙
   *  panel's Move (WORKSPACE-QUEUE-ADR §XI.2 R2). Both feeds change what they
   *  ARE, so both reload page one, re-ask their counts and re-read their
   *  source lists. */
  function afterSourceMoved(fromFeedId: string, toFeedId: string) {
    for (const fid of [fromFeedId, toFeedId]) {
      const v = vesselsRef.current.find((x) => x.feed.id === fid);
      if (v) void loadVesselItems(v.feed);
      refetchSeen(fid);
      workspaceFeedsApi
        .listSources(fid)
        .then(({ sources }) => {
          setVessels((prev) =>
            prev.map((x) => (x.feed.id === fid ? { ...x, sources } : x)),
          );
        })
        .catch(() => {});
    }
  }

  // Adopt a feed minted server-side (the NewFeedPrompt create, or a feed
  // announced from outside this component — a follow-graph import started in
  // the Settings overlay / FeedComposer) into a live vessel. Idempotent: a
  // feed already showing is left alone. The membership check and the store
  // writes stay OUTSIDE the setVessels updater — an impure updater only
  // behaves while React evaluates it eagerly, and the multi-feed drain loop
  // below queues updates, deferring later updaters to the render phase. The
  // ref append keeps same-tick loop calls deduped (the updater still re-checks
  // membership itself, so it stays pure and double-invocation-safe).
  function adoptFeed(feed: WorkspaceFeed) {
    if (vesselsRef.current.some((v) => v.feed.id === feed.id)) return;
    vesselsRef.current = [
      ...vesselsRef.current,
      { feed, items: [], sources: [], status: "loading" as const },
    ];
    setVessels((prev) =>
      prev.some((v) => v.feed.id === feed.id)
        ? prev
        : [...prev, { feed, items: [], sources: [], status: "loading" as const }],
    );
    // §III.5: a new feed appends a new right-most column at factory size and
    // geometry does the rest — the strip stops centring once it exceeds the
    // viewport and the scroll extent grows rightwards. `insertFeed` is
    // idempotent, so a double-invoked adopt places nothing twice.
    insertFeedLayout(feed.id);
    void loadVesselItems(feed);
  }

  // Drain feeds announced by out-of-component creators (follow-graph imports,
  // FOLLOW-GRAPH-IMPORT-ADR §7) so the new vessel appears immediately.
  const pendingArrivals = useFeedArrivals((s) => s.pending);
  useEffect(() => {
    if (pendingArrivals.length === 0) return;
    pendingArrivals.forEach(adoptFeed);
    // Consume only the drained snapshot — an announce landing between render
    // and this effect stays queued for the next run instead of being wiped.
    useFeedArrivals.getState().consume(pendingArrivals);
    // adoptFeed is a stable-enough plain function (dedup via vesselsRef); the
    // queue itself is the trigger.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [pendingArrivals]);

  async function handleCreateFeed(name: string) {
    const { feed } = await workspaceFeedsApi.create(name);
    adoptFeed(feed);
    setNewFeedOpen(false);
    // TODO: re-enable / refine entrance animation
    // setCeremony({ feedId: feed.id, pace: "responsive", target: slot });
  }

  // An OUTAGE is not an absence (CA-A11): `/auth/me` not answering leaves the
  // member's standing unknown, and unknown is not "log in again".
  useEffect(() => {
    if (!loading && !user && !outage) router.push("/auth?mode=login");
  }, [user, loading, outage, router]);

  // Deep-link → overlay. Retired routes (dashboard, messages, notifications)
  // redirect here as /reader?overlay=<name>[&…seed params]; so do the standalone
  // pane pages via a shared link (?overlay=reader|profile|surface).
  // We strip the seed params and clean the URL to /reader *first*, then open the
  // overlay — the order matters for the pane overlays (reader/profile/surface),
  // which push their own canonical URL on open: opening after the strip lands that
  // URL on a clean /reader base entry, so Back/close returns to the workspace
  // rather than the seed URL. The ?overlay= panels push no URL, so the order is
  // harmless for them. Read once on mount via window.location (no useSearchParams
  // → no Suspense boundary needed).
  useEffect(() => {
    const seed = new URLSearchParams(window.location.search);
    if (!seed.get("overlay")) return;
    const cleaned = new URLSearchParams(window.location.search);
    OVERLAY_PARAM_KEYS.forEach((k) => cleaned.delete(k));
    const qs = cleaned.toString();
    // CARRY NEXT'S OWN STATE FORWARD. A bare `{}` here wipes `__NA` and the
    // internals tree off the entry a reader will later come BACK to, and the
    // app router, finding an entry it cannot reconcile, falls back to a full
    // document navigation — so after any `?overlay=` arrival (every
    // notification link, the /messages and /settings shims) the first Back out
    // of a pane RELOADED THE WHOLE WORKSPACE, losing every in-memory surface
    // with it. Measured, because none of it is visible from the code: after
    // this line the entry's state keys were `[]`, against
    // `["__NA","__PRIVATE_NEXTJS_INTERNALS_TREE"]` on a bare /reader.
    //
    // Next merges its keys into a `pushState` (measured too — a raw push of
    // `{mine:true}` comes back carrying all three) and does NOT merge them
    // into a `replaceState`, which is the asymmetry this line fell into.
    // The tree stays correct across the write: the document has not navigated,
    // only the query string has changed.
    window.history.replaceState(
      window.history.state,
      "",
      `/reader${qs ? `?${qs}` : ""}`,
    );
    openOverlayFromParams(seed);
  }, []);

  // EVERY EFFECT BELOW IS KEYED ON THE MEMBER'S ID, NEVER THE `user` OBJECT
  // (CA-A12, 2026-09-29). `fetchMe` always sets a NEW object, and it is called
  // after an unlock, a card connect, a profile edit, a username change and the
  // age gate — so keyed on the object, each of those re-ran the bootstrap
  // below: `setBootstrap("loading")`, every vessel unmounted, every feed back
  // to page one, the scroll lost behind the pane that caused it. A member's
  // identity is the only thing these effects are about.

  // Hydrate the workspace store from localStorage as soon as the user is
  // known. Bootstrap below depends on hydration so default-slot writes don't
  // overwrite a stored layout.
  useEffect(() => {
    if (user) hydrate(user.id);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [user?.id, hydrate]);
  // The reading counts' device set, beside it (WORKSPACE-QUEUE-ADR §IV.5).
  useEffect(() => {
    if (user) useFeedSeen.getState().hydrate(user.id);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [user?.id]);

  // Bootstrap: one aggregate call returns the feed list plus, per feed, its
  // sources + first page of items (performance audit #3) — collapsing the old
  // list()+per-feed listSources()+items() fan-out into a single round trip.
  // Feeds absent from `vessels` (a freshly minted default, or a server-side
  // hydration hiccup) fall back to the per-vessel lazy loaders below.
  // Re-runs only when the authenticated MEMBER changes (their id) — never on
  // a re-fetched `user` object.
  useEffect(() => {
    if (!user || !hydrated) return;
    let cancelled = false;
    setBootstrap("loading");
    void (async () => {
      try {
        const boot = await workspaceFeedsApi.bootstrap();
        let list = boot.feeds;
        const vesselData = boot.vessels;
        let mintedFounderFeed = false;
        if (list.length === 0) {
          const { feed } = await workspaceFeedsApi.create(DEFAULT_FEED_NAME);
          list = [feed];
          mintedFounderFeed = true;
        }
        if (cancelled) return;

        // (The pre-migration-113 local-hide push-up retired with the v1
        // storage key — WORKSPACE-COLUMN-LAYOUT-ADR §VIII. `feeds.hidden` has
        // been server-side for long enough that no live client still carries
        // one, and the v1 blob it read is now discarded at hydrate.)

        // Seed each vessel from the aggregate payload where present (ready, with
        // sources + first items + cursor); leave the rest "loading" for the
        // lazy fallback below.
        const initial: VesselState[] = list.map((feed) => {
          const v = vesselData[feed.id];
          // The bootstrap is the items page by another door, so it carries
          // each vessel's asOf too.
          if (v) useFeedSeen.getState().noteAsOf(feed.id, v.asOf);
          if (v) {
            return {
              feed,
              items: v.items,
              sources: v.sources,
              status: "ready",
              nextCursor: v.nextCursor ?? null,
            };
          }
          return { feed, items: [], sources: [], status: "loading" };
        });
        setVessels(initial);
        setBootstrap("ready");

        // Fallback only for feeds the aggregate didn't cover (minted default /
        // hydration hiccup); covered feeds already carry their sources.
        for (const feed of list) {
          if (vesselData[feed.id]) continue;
          workspaceFeedsApi
            .listSources(feed.id)
            .then(({ sources }) => {
              if (cancelled) return;
              setVessels((prev) =>
                prev.map((v) =>
                  v.feed.id === feed.id ? { ...v, sources } : v,
                ),
              );
            })
            .catch(() => {});
        }

        // The authoritative feed list is now known — reconcile the stored
        // layout against it: prune slots the server no longer returns (deleted
        // on another device) or has hidden, and place every visible feed that
        // has no slot. That second job subsumes the old default-grid-slot
        // sweep, and this is also the FIRST-RUN path (§III.4): from an empty
        // layout it lands one column per seeded starter feed, in list order.
        // There is no heal, because there is no illegal state to heal.
        useWorkspace.getState().reconcileFeeds(
          list.map((f) => f.id),
          list.filter((f) => !f.hidden).map((f) => f.id),
        );

        // Per-feed appearance (feature-debt §3 + MOBILE-LAYOUT-ADR §VI): the
        // server-side feeds.appearance is authoritative — feed character
        // travels with the feed across devices. Reconcile scheme and density
        // into the appearance record, which doubles as the local cache (and,
        // for feeds that have never picked, the per-device fallback). One sync
        // model for both axes, not two.
        const storedAppearance = useWorkspace.getState().appearance;
        list.forEach((feed) => {
          const scheme = feed.appearance?.scheme;
          if (scheme && storedAppearance[feed.id]?.brightness !== scheme) {
            setVesselBrightness(feed.id, normalizeBrightness(scheme));
          }
          if (feed.appearance?.density !== undefined) {
            const density = normalizeDensity(feed.appearance.density);
            if (storedAppearance[feed.id]?.density !== density) {
              setVesselDensity(feed.id, density);
            }
          }
        });

        // First-login ceremony: only if we just minted the default feed AND
        // this user hasn't seen the ceremony before. Plays viewport-centred
        // (per spec: "expands from the centre of an empty screen"). The
        // founder's feed mounts at its grid slot when the ceremony completes;
        // the position discontinuity from centre to slot is a deferred polish.
        const ceremonySeenKey = `${CEREMONY_SEEN_PREFIX}${user.id}`;
        const seen =
          typeof window !== "undefined"
            ? window.localStorage.getItem(ceremonySeenKey) === "true"
            : true;
        if (mintedFounderFeed && !seen && typeof window !== "undefined") {
          // TODO: re-enable / refine entrance animation
          // const cx = window.innerWidth / 2 - CEREMONY_BOX_W / 2;
          // const cy = window.innerHeight / 2 - CEREMONY_BOX_H / 2;
          // setCeremony({
          //   feedId: list[0].id,
          //   pace: "ceremonial",
          //   target: { x: cx, y: cy },
          // });
        }

        // The first-session welcome (§3.3). Gated on `onboardedAt` being NULL —
        // the account has never been offered it — and NOT on `mintedFounderFeed`
        // the way its predecessor was: that signal means "the bootstrap returned
        // no feeds", which since starter-seeding moved into `listFeedsForOwner`
        // is the seeding-FAILURE path rather than the new-account path (see the
        // `Welcome` import comment).
        //
        // Skipped when a deep-linked overlay already claimed the Glasshouse —
        // superseding what the user explicitly navigated to would be rude. The
        // gate is server-side and survives, so it simply offers on a later
        // mount; nothing is consumed by not showing it here.
        // Read fresh off the store: the closure's `user` is the render this
        // effect last ran in, and the effect is keyed on the id alone.
        const onboardedAt = useAuth.getState().user?.onboardedAt ?? null;
        if (onboardedAt === null && !useGlasshousePresence.getState().isOpen) {
          setTourArmed(true);
        }

        for (const feed of list) {
          if (cancelled) return;
          // Covered feeds already have their first page from the aggregate;
          // only fetch the ones the bootstrap didn't return (minted default /
          // hydration hiccup). Fire-and-forget — no need to serialise.
          if (vesselData[feed.id]) continue;
          void loadVesselItems(feed);
        }
      } catch (err) {
        if (cancelled) return;
        console.error("Workspace bootstrap error:", err);
        setBootstrap("error");
      }
    })();
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [user?.id, hydrated, loadVesselItems]);

  // The feed's card list — shared verbatim by the desktop vessel and the
  // mobile full-bleed page (MOBILE-LAYOUT-ADR §III), so the two surfaces
  // cannot drift. Orientation never reaches the cards (it is a chassis
  // property); scheme/density/text size ride the layout store as on desktop.
  //
  // At `level` "preview" it builds the queue's preview rows instead
  // (WORKSPACE-QUEUE-ADR §VII.5): the same loaded items in the same order,
  // capped, as bare cards at the `preview` level — the one path again, so no
  // row is a `Post` rendered outside `resolveSpec`. A row walks the queue to
  // its feed; an article's opens the reader (D6).
  const renderFeedContents = useCallback(
  (v: VesselState, level: "feed" | "preview" = "feed") => {
    const preview = level === "preview";
    const look = appearance[v.feed.id] ?? {};
    // Both surfaces render the feed's colourway in the global mode's light or
    // dark variant. Desktop vessels and the mobile pages are both islanded
    // (LIGHT_ISLAND_STYLE), so the derived text slugs the palette references
    // resolve canonical regardless of mode and the variant supplies light/dark.
    const feedPalette = paletteFor(look.brightness, globalDark);
    // Posts already read inside a conversation in THIS feed stop being cards in
    // it (see `weededByFeed`). Applied here, at the one place the card list is
    // built, so the desktop vessel and the mobile page cannot disagree — and so
    // it also survives a refresh, which replaces `v.items` and leaves the
    // weeded set standing. A page that weeds away to nothing simply lets the
    // infinite-scroll sentinel fetch the next one.
    const weeded = weededByFeed[v.feed.id];
    const unweeded = weeded?.size
      ? v.items.filter((i) => !weeded.has(i.id))
      : v.items;
    const items = preview ? unweeded.slice(0, PREVIEW_ROW_CAP) : unweeded;
    const seenHere = seenHandlerFor(v.feed.id);
    return (
      <>
            {v.status === "loading" && <Hint>LOADING…</Hint>}
            {v.status === "error" && <Hint>COULDN&rsquo;T LOAD CHANNEL</Hint>}
            {!preview &&
              v.status === "ready" &&
              items.length === 0 &&
              (v.sources.length === 0 ? (
                <EmptyFeedTile
                  variant="no-sources"
                  palette={feedPalette}
                  onAddSources={() => setFeedComposerFor(v.feed)}
                />
              ) : (
                <EmptyFeedTile
                  variant="no-items"
                  palette={feedPalette}
                  onAddSources={() => setFeedComposerFor(v.feed)}
                />
              ))}
            {/* The queue raises none: its mouth says it (§VII.9). */}
            {!preview && !queueMode && v.status === "ready" && v.caughtUp && items.length > 0 && (
              <EmptyFeedTile
                variant="caught-up"
                palette={feedPalette}
                onAddSources={() => setFeedComposerFor(v.feed)}
                onDismiss={() =>
                  setVessels((prev) =>
                    prev.map((vs) =>
                      vs.feed.id === v.feed.id
                        ? { ...vs, caughtUp: false }
                        : vs,
                    ),
                  )
                }
              />
            )}
            {v.status === "ready" &&
              items.map((item) =>
                (() => {
                    // UNIVERSAL-POST-ADR Phase 5 — the unified card is the only
                    // feed path. Collapsed cards are PostCardInteractive
                    // level="feed"; expanding a note/external mounts the unified
                    // PostThread (ancestors/focal/replies on the same PostCard).
                    // Articles open the reader pane (Phase R), so they have no
                    // inline thread and stay feed cards.
                    const post = item;
                    const expandKey = item.feedItemId ?? item.id;
                    const expandedHere = expandedByFeed[v.feed.id];
                    const isExpanded = expandedHere?.key === expandKey;
                    const ctx = {
                      density: look.density ?? DEFAULT_DENSITY,
                      // Mobile: uniform global light/dark; desktop: the feed's
                      // colourway in the global mode's light/dark variant.
                      palette: feedPalette,
                      bodyPx:
                        TEXT_SIZE_PX[look.textSize ?? DEFAULT_TEXT_SIZE],
                      feedId: v.feed.id,
                      // No card drag in the queue: its targets are columnar
                      // (§VI.6), and without `dragData` the byline's grab
                      // handle is not rendered at all, not merely inert.
                      dragData: queueMode ? undefined : (() => {
                        const fsId = matchItemToSource(item, v.sources);
                        return fsId
                          ? JSON.stringify({
                              feedId: v.feed.id,
                              feedSourceId: fsId,
                            })
                          : undefined;
                      })(),
                    } as CardContext;
                    // One conversation open per feed: opening this card
                    // replaces whatever was open in this feed; clicking the
                    // open card again collapses it.
                    const toggleExpand = () => {
                      // Whether this closes the open conversation or replaces
                      // it with another, the one that was open is finished:
                      // bank what its reader saw. A no-op on a cold open.
                      settleExpansion(v.feed.id);
                      setExpandedByFeed((prev) => {
                        const open = prev[v.feed.id];
                        // Open on this slot but rooted on a post this card
                        // QUOTES: the quoting card is still in the feed above
                        // that conversation, so a body click there opens ITS
                        // conversation rather than closing everything. That is
                        // the whole point of leaving it up there.
                        if (open?.key === expandKey && open.root === post.id) {
                          const next = { ...prev };
                          delete next[v.feed.id];
                          return next;
                        }
                        // Body click expands the host post (the quoter).
                        return {
                          ...prev,
                          [v.feed.id]: {
                            key: expandKey,
                            root: post.id,
                            host: post.id,
                          },
                        };
                      });
                    };
                    // The focal click is a CLOSE, never the toggle above: while
                    // a quote expansion is open the toggle swings to the host,
                    // and the focal must still collapse the conversation (§4).
                    const collapseHere = () => {
                      if (expandedHere?.key === expandKey)
                        settleExpansion(v.feed.id);
                      setExpandedByFeed((prev) => {
                        if (prev[v.feed.id]?.key !== expandKey) return prev;
                        const next = { ...prev };
                        delete next[v.feed.id];
                        return next;
                      });
                    };
                    // Clicking the embedded quote tile opens the QUOTED post as
                    // the focal of an expanded conversation — full seniority, no
                    // residue of the host that embedded it. Distinct from a body
                    // click (which expands the host): the tile stops propagation,
                    // so the two clicks never collide. The gateway minted a
                    // feed_items twin when the tile hydrated, so /thread resolves
                    // the quoted post's id (post.quotes).
                    const expandQuote = (quotedPostId: string) => {
                      settleExpansion(v.feed.id);
                      setExpandedByFeed((prev) => ({
                        ...prev,
                        [v.feed.id]: {
                          key: expandKey,
                          root: quotedPostId,
                          host: post.id,
                        },
                      }));
                    };
                    // Native quote → a NIP-18 quote note that embeds this post.
                    // version = the nostr event id of the thing being quoted.
                    // An external post quotes by post_id + public URL
                    // (`quoteTargetFromPost`, shared with the plain register).
                    const quoteFromPost = (p: Post) => {
                      setQuoteTarget(quoteTargetFromPost(p));
                      setComposerOpen("note");
                    };
                    // Article click → reader pane (§3.1 / Phase R). Native by
                    // d-tag (/article/<dTag>), external by URL (/read/<postId>).
                    // Actions are stable refs, so getState() avoids subscribing.
                    const openReaderFromPost = (p: Post) => {
                      // An article OPENED has been seen, wherever it was opened
                      // from — a card, a preview row, a thread (operator,
                      // 2026-09-27; amends WORKSPACE-QUEUE-ADR §IV.7, where only
                      // a pass marked). A post outside the window is a no-op.
                      if (!isMobile)
                        useFeedSeen.getState().markPassed(v.feed.id, p.id);
                      const reader = useReader.getState();
                      // Frame the reader in the launching feed's COLOURWAY (not a
                      // colour — the pane re-derives bar, ⊓ and ear arrows off one
                      // palette, and hands the scheme on again when the bar's
                      // source link opens a surface), and hand it the feed's
                      // article list so the skip ears step through them in place.
                      const frame = { frameScheme: ctx.palette.scheme };
                      const entries = unweeded
                        .map(articleToReaderEntry)
                        .filter((e): e is ReaderNavEntry => e !== null);
                      const index = entries.findIndex((e) => e.postId === p.id);
                      if (index >= 0) {
                        reader.openFeedItem(entries, index, frame);
                        return;
                      }
                      // Not in the feed list (e.g. an article quoted inside a
                      // thread) — open it without the skip ears.
                      const entry = articleToReaderEntry(p);
                      if (entry?.kind === "native")
                        reader.openNative(entry.dTag, {
                          postId: entry.postId,
                          frameScheme: frame.frameScheme,
                          preview: entry.preview,
                        });
                      else if (entry?.kind === "external")
                        reader.openExternal(entry.url, {
                          postId: entry.postId,
                          title: entry.title,
                          siteName: entry.siteName,
                          sourceId: entry.sourceId,
                          media: entry.media,
                          frameScheme: frame.frameScheme,
                        });
                    };
                    if (preview) {
                      // Bare `PostCard`, as for any non-interactive render.
                      // `compact` density whatever the feed's, so every row is
                      // the level's one line in the tight shell — a headline
                      // feed would otherwise print a note's whole body. The
                      // mark rides the ctx for the FADE alone: a preview row
                      // carries no `data-seen-at`, so nothing can pass it.
                      // A click walks to the feed AND opens this card's
                      // conversation once it lands (`onQueueFocalChange`).
                      const walk = () => {
                        pendingQueueOpenRef.current = {
                          feedId: v.feed.id,
                          key: expandKey,
                          root: post.id,
                        };
                        queueRef.current?.walkTo(v.feed.id);
                      };
                      return (
                        <FeedSeenMarked
                          key={item.id}
                          feedId={v.feed.id}
                          postId={post.id}
                          render={(seen) => (
                            <PostCard
                              post={post}
                              level="preview"
                              ctx={{ ...ctx, density: "compact", seen }}
                              onFocus={walk}
                              onOpenReader={openReaderFromPost}
                            />
                          )}
                        />
                      );
                    }
                    // The reading counts' mark (§IV.8), subscribed per card so a
                    // pass re-renders the one card whose mark moved. Desktop
                    // only; the conversation below takes the bare ctx, because
                    // expanding one never marks anything passed.
                    const renderCollapsed = (
                      seen?: SeenMark,
                    ) => (
                      <PostCardInteractive
                        post={post}
                        level="feed"
                        expanded={false}
                        ctx={seen === undefined ? ctx : { ...ctx, seen }}
                        onExpand={toggleExpand}
                        onQuoteOpen={expandQuote}
                        onOpenReader={openReaderFromPost}
                        onQuote={() => quoteFromPost(post)}
                      />
                    );
                    const collapsedCard = isMobile ? (
                      renderCollapsed()
                    ) : (
                      <FeedSeenMarked
                        feedId={v.feed.id}
                        postId={post.id}
                        render={renderCollapsed}
                      />
                    );
                    if (isExpanded && post.type !== "article") {
                      const root = expandedHere?.root ?? post.id;
                      // A QUOTE expansion keeps the quoting card in the feed,
                      // directly above the conversation it opened — in effect
                      // the next card up — so the reader can find it again and
                      // open its own conversation next. Thread SENIORITY is
                      // untouched: the thread is still rooted on the quoted post
                      // with no back-link. What survives is feed context, not
                      // thread residue. A Fragment (not a wrapper) keeps both as
                      // direct children of the log, so the gap between them is
                      // the feed's ordinary rhythm.
                      return (
                        <Fragment key={item.id}>
                          {root !== post.id ? collapsedCard : null}
                          <PostThread
                            rootPostId={root}
                            ctx={ctx}
                            onSeen={seenHere}
                            onCollapse={collapseHere}
                            onQuote={quoteFromPost}
                            onOpenReader={openReaderFromPost}
                          />
                        </Fragment>
                      );
                    }
                    return <Fragment key={item.id}>{collapsedCard}</Fragment>;
                  })(),
              )}
      </>
    );
  },
  [
    appearance,
    globalDark,
    weededByFeed,
    expandedByFeed,
    queueMode,
    isMobile,
    settleExpansion,
    seenHandlerFor,
  ],
  );

  // Each desktop vessel's card list, built once per change to what it shows.
  // A resize or drag frame re-renders this component (`resizePreview`, the
  // drop stripe) but touches none of these inputs, so every Vessel is handed
  // the SAME children element and React bails out at the card list — rather
  // than re-rendering every card on the floor every frame (CA-G9). Mobile and
  // the queue build theirs on demand through `renderFeedContents` as before.
  const desktopContents = useMemo(
    () =>
      isMobile || queueMode
        ? null
        : new Map(vessels.map((v) => [v.feed.id, renderFeedContents(v)])),
    [isMobile, queueMode, vessels, renderFeedContents],
  );

  if (loading || !user) {
    // A first load in an outage says so and offers a retry; it never bounces
    // to the login page (the effect above) and never spins for a server that
    // is down (`loading` ended). A retry that answers takes the ordinary path.
    return (
      <Floor>
        {outage && (
          <CenteredHint>
            COULDN&rsquo;T REACH ALL.HAUS{" "}
            <button
              type="button"
              className="btn-text"
              onClick={() => void fetchMe()}
            >
              Retry
            </button>
          </CenteredHint>
        )}
      </Floor>
    );
  }

  return (
    // ExplainProvider holds the registration Map (EXPLAIN-ADR §8). It wraps the
    // whole floor; registration is inert on the mobile branch (MobileWorkspace
    // renders no Vessel roots), and the Explain overlay + first-run entry effect
    // that later slices add mount on the desktop path only.
    <ExplainProvider>
      {/* `insetTop` tracks the bar, NOT the bar's mounted-ness: the reader
          un-mounts the bar (below) but must not reflow the whole floor behind
          its own opaque pane, exactly as the old row's `navRowH` stayed
          reserved through a reader open. 0 on mobile, which has no desktop
          bar. */}
      <Floor floorRef={floorRef} insetTop={barH} clipX={queueMode}>
      {bootstrap === "loading" && (
        <CenteredHint>LOADING…</CenteredHint>
      )}
      {bootstrap === "error" && (
        <CenteredHint>COULDN&rsquo;T LOAD WORKSPACE</CenteredHint>
      )}
      {bootstrap === "ready" && isMobile && (
        <MobileWorkspace
          // Rank order, same as the desktop numerals: leftmost pip = Feed 1,
          // counting up left-to-right, so the pip's positional aria-label and
          // the FeedComposer title it opens always agree. (A 2026-07-04
          // `.reverse()` here did the OPPOSITE of its stated "Feed 1 leftmost"
          // intent — visibleSorted already runs Feed 1 first; removed
          // 2026-07-06, MOBILE-LAYOUT-ADR §X.)
          feeds={visibleSorted.map((v) => v.feed)}
          // The muster numeral is IDENTITY (NAV-ROW-MUSTER-ADR §III): stable
          // across minimising, so it is gap-numbered on the gapless mobile
          // strip. The strip stays positional (pip order = swipe order); the
          // aria-label announces BOTH the stable number and the position.
          numeralFor={(feedId) => feedNumerals.get(feedId) ?? 1}
          userId={user.id}
          interiorFor={(feedId) =>
            paletteFor(appearance[feedId]?.brightness, globalDark).interior
          }
          renderFeedContents={(feedId) => {
            const v = vessels.find((x) => x.feed.id === feedId);
            return v ? renderFeedContents(v) : null;
          }}
          onRefresh={async (feedId) => {
            const v = vesselsRef.current.find((x) => x.feed.id === feedId);
            if (v) await loadVesselItems(v.feed);
          }}
          onLoadMore={loadMoreVesselItems}
          onOpenFeedSettings={(feedId) => {
            const v = vessels.find((x) => x.feed.id === feedId);
            if (v) setFeedComposerFor(v.feed);
          }}
        />
      )}
      {/* The canvas: an explicitly-sized plane inside the scrolling floor.
          Width is the derived floor width — taut, one GRID past the right-most
          column — and height is always the viewport. Vessels position from
          `geom.rects`, which are FINAL canvas coordinates with the first-run
          centring already applied: derivation is the one conversion seam, and
          nothing else converts anywhere. */}
      {bootstrap === "ready" && queueMode && (
        <QueueView
          ref={queueRef}
          feeds={queueFeeds}
          vp={vp}
          hiddenPalette={paletteFor("basic", globalDark)}
          attentionElsewhere={paneOpen}
          renderContents={(feedId) => {
            const v = vessels.find((x) => x.feed.id === feedId);
            return v ? renderFeedContents(v) : null;
          }}
          renderPreview={(feedId) => {
            const v = vessels.find((x) => x.feed.id === feedId);
            return v ? renderFeedContents(v, "preview") : null;
          }}
          onReveal={(feedId) => revealQueueFeeds([feedId]).get(feedId) ?? null}
          onRevealAll={revealAllQueueFeeds}
          onLoadMore={loadMoreVesselItems}
          onCaughtUpDismiss={(feedId) =>
            setVessels((prev) =>
              prev.map((vs) =>
                vs.feed.id === feedId ? { ...vs, caughtUp: false } : vs,
              ),
            )
          }
          onNameClick={(feedId) => {
            const v = vessels.find((x) => x.feed.id === feedId);
            if (v) setFeedComposerFor(v.feed);
          }}
          onSourceAdded={handleSourceAdded}
          onHide={(feedId) => void handleSetFeedHidden(feedId, true)}
          onRestore={handleRestoreHiddenFeed}
          onFocalChange={onQueueFocalChange}
        />
      )}
      {bootstrap === "ready" && !isMobile && !queueMode && (
        <div
          data-workspace-canvas
          style={{
            position: "relative",
            width: geom.floorWidth,
            height: "100%",
            // No `isolation: isolate` here any more: it existed to give the
            // difference lens a single flattened backdrop and to stop a raised
            // vessel painting over a disc that had to run at z-index:auto
            // (WORKSPACE-COLUMN-LAYOUT-ADR §VI killed both). The Vessel's
            // drag/armed raise tops out at z-6, far under the nav row (58) and
            // the ∀ (60), so plain document order is enough.
          }}
        >
          <DropStripe drop={drop} layout={geomLayout} geom={geom} />
          {vessels
            .filter((v) => geom.rects.has(v.feed.id))
            .map((v) => {
              const rect = geom.rects.get(v.feed.id)!;
              const look = appearance[v.feed.id] ?? {};
              return (
              <Vessel
                key={v.feed.id}
                feedId={v.feed.id}
                numeral={feedNumerals.get(v.feed.id) ?? 1}
                descriptiveName={v.feed.name || undefined}
                sortRank={v.feed.sortRank}
                fromStarter={v.feed.fromStarter}
                onNameClick={() => setFeedComposerFor(v.feed)}
                onSourceAdded={() => handleSourceAdded(v.feed.id)}
                // The derived rect, verbatim — no conversion at this seam.
                position={{ x: rect.x, y: rect.y }}
                size={{ w: rect.w, h: rect.h }}
                // While a live resize proposal is in flight, neighbours track
                // the handle exactly instead of chasing it with a spring
                // restarted every frame.
                snapSettle={!!resizePreview}
                brightness={look.brightness}
                orientation={look.orientation}
                onHide={() => void handleSetFeedHidden(v.feed.id, true)}
                onSizeCommit={(next) => {
                  materializeIfRegimented();
                  resizeSlotLayout(v.feed.id, next, vp);
                }}
                clampResize={(proposed) =>
                  clampVesselResize(v.feed.id, proposed)
                }
                onResizeFrame={(next) =>
                  setResizePreview(
                    next ? { feedId: v.feed.id, ...next } : null,
                  )
                }
                onDragStart={() => handleVesselDragStart(v.feed.id)}
                onDragFrame={(pointer) =>
                  handleVesselDragFrame(v.feed.id, pointer)
                }
                onDragEnd={() => handleVesselDragEnd(v.feed.id)}
                armed={armedMergeTarget === v.feed.id}
                contentsMounted={visibleIds.has(v.feed.id)}
                countsSeen
                inView={musterInView.has(v.feed.id)}
                attentionElsewhere={floorPanning || paneOpen}
                tailSpacer={v.status === "ready" && v.items.length > 0}
                hidden={ceremony?.feedId === v.feed.id}
                floorRef={floorRef}
                onCardDrop={(raw) => handleCardDrop(v.feed.id, raw)}
                onRefresh={async () => {
                  await loadVesselItems(v.feed);
                }}
                onLoadMore={loadMoreVesselItems}
                caughtUp={v.caughtUp}
                onCaughtUpDismiss={() =>
                  setVessels((prev) =>
                    prev.map((vs) =>
                      vs.feed.id === v.feed.id
                        ? { ...vs, caughtUp: false }
                        : vs,
                    ),
                  )
                }
              >
                {desktopContents?.get(v.feed.id)}
              </Vessel>
              );
            })}
        </div>
      )}
      {/* The nav bar (§VI) — chrome only; the lockup docks into its left end
          via ForallMenu anchor="row" below. Desktop only: the mobile bar
          carries its own wordmark. Un-mounted while either immersive pane is
          open (reader or editor) so it can cover the toolbar region; the ∀
          lockup (z-60, rendered below) still floats over it. */}
      {!isMobile && !immersivePaneOpen && <NavBar />}
      {/* The muster (NAV-ROW-MUSTER-ADR §IV) — a separate fixed layer over the
          bar band, docked at its right end and clearing the lockup. Desktop
          only: the mobile indicator strip is the pip strip in its own bar.
          Hidden with the bar under either immersive pane. */}
      {!isMobile && !immersivePaneOpen && (
        queueMode ? (
          <QueueMuster feeds={queueMusterFeeds} onGoTo={walkQueueTo} />
        ) : (
          <Muster feeds={musterFeeds} onGoTo={goToFeed} />
        )
      )}
      <ForallMenu
        onAction={handleForallAction}
        hiddenFeeds={hiddenFeeds}
        onRestore={handleRestoreHiddenFeed}
        currentFeed={
          currentFeed ? { id: currentFeed.id, name: currentFeed.name } : null
        }
        onFeedSettings={(feedId) => {
          const v = vessels.find((x) => x.feed.id === feedId);
          if (v) setFeedComposerFor(v.feed);
        }}
        onRefreshAll={queueMode ? undefined : refreshAll}
        anchor={isMobile ? "bar" : "row"}
      />
      <Composer
        open={!!composerOpen}
        quoteTarget={quoteTarget}
        onClose={() => {
          composerSuspendedRef.current = false;
          setComposerOpen(false);
          setQuoteTarget(null);
          // Keep the global compose store (the bridge trigger) in sync so a
          // re-open request from outside this component fires the effect again.
          if (useCompose.getState().isOpen) useCompose.getState().close();
        }}
        onSuspend={() => {
          composerSuspendedRef.current = true;
          setComposerOpen(false);
          if (useCompose.getState().isOpen) useCompose.getState().suspend();
        }}
        onPublished={refreshAfterPublish}
      />
      <NewFeedPrompt
        open={newFeedOpen}
        onClose={() => setNewFeedOpen(false)}
        onCreate={handleCreateFeed}
      />
      <FeedComposer
        open={!!feedComposerFor}
        feed={feedComposerFor}
        deleteBlocked={vessels.filter((v) => !v.feed.hidden).length <= 1}
        scheme={
          feedComposerFor ? appearance[feedComposerFor.id]?.brightness : undefined
        }
        density={
          feedComposerFor ? appearance[feedComposerFor.id]?.density : undefined
        }
        textSize={
          feedComposerFor ? appearance[feedComposerFor.id]?.textSize : undefined
        }
        onSchemeChange={(next) => {
          if (!feedComposerFor) return;
          // Local store repaints the vessel immediately; the server PATCH
          // persists the scheme as feed character (cross-device). The
          // refreshed feed object keeps the vessel state in sync. On failure
          // the optimistic repaint reverts (same contract as
          // handleSetFeedHidden) — a swallowed failure would look applied
          // here and silently reset on the next bootstrap.
          const feedId = feedComposerFor.id;
          const prevScheme = appearance[feedId]?.brightness;
          setVesselBrightness(feedId, next);
          workspaceFeedsApi
            .setAppearance(feedId, { scheme: next })
            .then(({ feed }) =>
              setVessels((prev) =>
                prev.map((v) => (v.feed.id === feed.id ? { ...v, feed } : v)),
              ),
            )
            .catch((err) => {
              console.error("Set feed scheme failed:", err);
              setVesselBrightness(feedId, normalizeBrightness(prevScheme));
            });
        }}
        onDensityChange={(next) => {
          if (!feedComposerFor) return;
          // Same precedence pattern as the scheme (MOBILE-LAYOUT-ADR §VI):
          // local store repaints immediately, the server PATCH persists
          // density as feed character, the refreshed row reconciles state,
          // failure reverts the repaint.
          const feedId = feedComposerFor.id;
          const prevDensity = appearance[feedId]?.density;
          setVesselDensity(feedId, next);
          workspaceFeedsApi
            .setAppearance(feedId, { density: next })
            .then(({ feed }) =>
              setVessels((prev) =>
                prev.map((v) => (v.feed.id === feed.id ? { ...v, feed } : v)),
              ),
            )
            .catch((err) => {
              console.error("Set feed density failed:", err);
              setVesselDensity(feedId, prevDensity ?? DEFAULT_DENSITY);
            });
        }}
        // Merge, rehomed from the floor's vessel-on-vessel drop
        // (WORKSPACE-QUEUE-ADR §XI.2 R1): the panel closes and the same
        // MergeFeedConfirm asks, so there is one question and one failure path.
        onMergeInto={(target) => {
          if (!feedComposerFor) return;
          const source = feedComposerFor;
          setFeedComposerFor(null);
          setPendingMerge({ source, target });
        }}
        onSourceMoved={(fromFeedId, toFeedId) =>
          afterSourceMoved(fromFeedId, toFeedId)
        }
        onTextSizeChange={(next) =>
          feedComposerFor && setVesselTextSize(feedComposerFor.id, next)
        }
        allFeeds={vessels.map((v) => v.feed)}
        onReorder={(feedIds) => void handleReorderFeeds(feedIds)}
        hidden={
          feedComposerFor
            ? (vessels.find((v) => v.feed.id === feedComposerFor.id)?.feed
                .hidden ?? false)
            : false
        }
        onHiddenChange={(next) =>
          feedComposerFor && void handleSetFeedHidden(feedComposerFor.id, next)
        }
        onClose={() => setFeedComposerFor(null)}
        onSourcesChanged={() => {
          if (!feedComposerFor) return;
          void loadVesselItems(feedComposerFor);
          refetchSeen(feedComposerFor.id);
          workspaceFeedsApi
            .listSources(feedComposerFor.id)
            .then(({ sources }) =>
              setVessels((prev) =>
                prev.map((v) =>
                  v.feed.id === feedComposerFor.id ? { ...v, sources } : v,
                ),
              ),
            )
            .catch(() => {});
        }}
        onRenamed={(updated) => {
          setVessels((prev) =>
            prev.map((v) =>
              v.feed.id === updated.id ? { ...v, feed: updated } : v,
            ),
          );
          setFeedComposerFor((curr) =>
            curr && curr.id === updated.id ? updated : curr,
          );
        }}
        onDeleted={(feedId) => {
          setVessels((prev) => prev.filter((v) => v.feed.id !== feedId));
          removeFeedLayout(feedId);
          clearExpandedFor(feedId);
          forgetFeedReadState(feedId);
          setFeedComposerFor(null);
        }}
      />
      <MergeFeedConfirm
        open={!!pendingMerge}
        sourceName={
          pendingMerge
            ? feedDisplayName(pendingMerge.source.id, pendingMerge.source.name)
            : ""
        }
        targetName={
          pendingMerge
            ? feedDisplayName(pendingMerge.target.id, pendingMerge.target.name)
            : ""
        }
        sourceFeedId={pendingMerge?.source.id}
        // Declined, or failed after the dialog painted its error: NO placement
        // work at all. The source never left the layout — its slot was held
        // open for the whole gesture (§IV.1/§IV.4) — so it has already sprung
        // home and the target never moved. `settleAfterAbandonedMerge` has no
        // successor because the state it repaired is unreachable.
        onClose={() => setPendingMerge(null)}
        onConfirm={handleMergeConfirm}
      />
      {ceremony && (
        <ForallCeremony
          key={ceremony.feedId}
          pace={ceremony.pace}
          target={ceremony.target}
          onComplete={() => {
            if (
              ceremony.pace === "ceremonial" &&
              user &&
              typeof window !== "undefined"
            ) {
              try {
                window.localStorage.setItem(
                  `${CEREMONY_SEEN_PREFIX}${user.id}`,
                  "true",
                );
              } catch {
                // Quota / private browsing — fall through; worst case is the
                // ceremony plays again on next first-feed mint, which is rare.
              }
            }
            setCeremony(null);
          }}
        />
      )}
      <ReaderOverlay />
      <MessagesOverlay />
      <DashboardOverlay />
      <LedgerOverlay />
      <SettingsOverlay />
      <LibraryOverlay />
      {/* Desktop only — the Explain engine must never mount on the mobile
          branch (EXPLAIN build-plan §2, ADR §Surface). AboutOverlay mounts on
          BOTH branches: desktop reaches it via the menu's About row and the D3
          chrome-swap button; mobile via its menu's About row (the slot Explain
          would occupy — no hover branch there), rendering as a full-screen
          sheet the disc-X dismisses. */}
      {!isMobile && <ExplainOverlay />}
      <AboutOverlay />
      {/* FIRST-RUN AUTO-ENTRY, REVIVED (owner decision, 2026-09-04). It was
          dormant from 2026-07-15: auto-dropping a fresh device into Explain
          "read as a malfunction, not a welcome" (EXPLAIN-ADR amendment 1), and
          the tour was reached instead by accepting the welcome sheet's last
          step. That sheet is now deleted, so this is the only route left and
          an unoffered tour is an unfindable one.

          DESKTOP ONLY, like <ExplainOverlay> above and for the same reason:
          the beats annotate the workspace, which the mobile pager does not
          lay out the same way (and the tour has never covered it).

          AND QUEUE ONLY (T1, WORKSPACE-QUEUE-ADR §XI.6). The beats describe
          the queue and anchor on its focal entry, so on the floor the
          controller is not mounted at all: a member whose device still says
          `columns` keeps `tourArmed` — and `onboarded_at` unstamped — until
          they are in the queue, and meets the tour there.

          `tourArmed` is the MEMBER-level half of the gate (`onboarded_at` NULL
          + bootstrap settled + no ceremony playing); the controller adds the
          per-device key, the ≥1-vessel wait, beat-3 readiness and the courtesy
          of never opening over a deep-linked pane. Stamping `onboarded_at` is
          this component's job now that nothing else does it — see `onOpened`. */}
      {/* PREVIEW ENTRY — `/reader?firstrun=1`, localhost only, consumes
          nothing (no seen-flag, no `onboarded_at` stamp), so the sequence can
          be watched more than once. See FirstRunPreview for why it is a
          separate component and why the gate is a hostname. */}
      {queueMode && <FirstRunPreview />}
      {queueMode && tourArmed && user && (
        <FirstRunController
          userId={user.id}
          armed
          onOpened={handleTourOpened}
        />
      )}
      </Floor>
    </ExplainProvider>
  );
}

/** The muster in queue mode, and the queue focal's only reader: a settle
 *  re-renders this and not the workspace (`stores/queueFocal.ts`). */
function QueueMuster({
  feeds,
  onGoTo,
}: {
  feeds: MusterFeed[];
  onGoTo: (feedId: string) => void;
}) {
  const focal = useQueueFocal((s) => s.feedId);
  return (
    <Muster
      feeds={feeds.map((f) => (f.id === focal ? { ...f, state: "in" as const } : f))}
      onGoTo={onGoTo}
    />
  );
}

function Floor({
  children,
  floorRef,
  insetTop = 0,
  clipX = false,
}: {
  children?: React.ReactNode;
  floorRef?: React.RefObject<HTMLDivElement>;
  /** The nav bar's height — the floor is inset by it rather than painted under
   *  it (NavBar.tsx). It moves the whole BOX: the scroll viewport's top edge
   *  comes down with it, so content clips against the bar exactly as it clips
   *  against the window, and `floor.getBoundingClientRect()` — which every
   *  pointer→canvas conversion on this surface already goes through — reports
   *  the inset origin for free. Padding would not do: an absolutely-positioned
   *  child is laid out against the PADDING box, so the vessels would not move
   *  and would simply sit behind opaque chrome.
   *
   *  A RELATIVE OFFSET, NOT A MARGIN, and the difference is a real bug rather
   *  than a preference. `LayoutShell`'s `<main>` has no padding or border, so a
   *  `marginTop` here collapses straight through it and pushes MAIN down
   *  instead — main keeps its `min-height: 100dvh`, the document becomes
   *  `100vh + NAV_BAR_H`, and the workspace gains a vertical scroll of exactly
   *  the bar's height that slides the whole floor up under it. It looks correct
   *  at rest, which is why it needs saying here. A relative offset moves the box for painting,
   *  clipping and hit-testing while leaving the flow height alone, so the
   *  document stays exactly one viewport tall. The floor's own height is
   *  shortened to match either way. 0 on mobile. */
  insetTop?: number;
  /** Queue mode: the box does not scroll sideways at all. `clip`, not
   *  `hidden` — `hidden` still lets the browser scroll it to a focused
   *  descendant (§VI.1). */
  clipX?: boolean;
}) {
  // Register the floor as an explainable root (EXPLAIN-ADR D4). Inert outside an
  // ExplainProvider (the loading/redirect Floor), so this is a no-op there.
  const ref = useExplainable("floor", { ref: floorRef });

  // The `<html>` overscroll pin that used to live here is WorkspaceView's now
  // (WORKSPACE-QUEUE-ADR §VI.4), so it covers the queue as well as the floor.
  return (
    <div
      ref={ref}
      style={{
        background: FLOOR,
        minHeight: `calc(100vh - ${insetTop}px)`,
        height: `calc(100vh - ${insetTop}px)`,
        position: "relative",
        top: insetTop,
        // The floor is the scroll VIEWPORT onto an infinitely-wide canvas:
        // pans sideways, never taller than the screen. Deliberately NOT a CSS
        // transform — a transform here would establish a containing block and
        // capture the position:fixed ∀ chrome (and the mobile bar), dragging
        // them around with the canvas instead of leaving them pinned.
        overflowX: clipX ? "clip" : "auto",
        overflowY: clipX ? "clip" : "hidden",
        overscrollBehaviorX: "contain",
      }}
    >
      {children}
    </div>
  );
}

/**
 * The insertion affordance (§IV.1): one GRID-wide stripe at the slot the drop
 * would take. A `merge` paints nothing here — the target vessel's own `armed`
 * outline is that answer. Positioned on the canvas in the same derived
 * coordinates the vessels use, so it lands exactly in the gutter the
 * recomputation will open.
 */
function DropStripe({
  drop,
  layout,
  geom,
}: {
  drop: Drop | null;
  layout: WorkspaceLayout;
  geom: Geometry;
}) {
  if (!drop || drop.kind === "merge") return null;

  let box: { x: number; y: number; w: number; h: number } | null = null;

  if (drop.kind === "new-column") {
    const cols = geom.columns;
    const b = drop.boundaryIndex;
    const x =
      b < cols.length
        ? cols[b].x - GRID
        : cols.length > 0
          ? cols[cols.length - 1].x + cols[cols.length - 1].w
          : GRID;
    box = { x, y: GRID, w: GRID, h: geom.columnH };
  } else {
    const col = layout.columns[drop.columnIndex];
    const span = geom.columns[drop.columnIndex];
    if (!col || !span) return null;
    const at = col.slots[drop.slotIndex];
    let y: number;
    if (at) {
      y = (geom.rects.get(at.feedId)?.y ?? GRID) - GRID;
    } else {
      const last = col.slots[col.slots.length - 1];
      const r = last ? geom.rects.get(last.feedId) : undefined;
      y = r ? r.y + r.h : GRID;
    }
    box = { x: span.x, y, w: span.w, h: GRID };
  }

  return (
    <div
      aria-hidden
      style={{
        position: "absolute",
        left: box.x,
        top: box.y,
        width: box.w,
        height: box.h,
        background: "var(--ah-crimson)",
        zIndex: 4,
        pointerEvents: "none",
      }}
    />
  );
}

function CenteredHint({ children }: { children: React.ReactNode }) {
  return (
    <div
      className="label-ui text-center"
      style={{
        color: "var(--ah-stone-350)",
        position: "absolute",
        top: "50%",
        left: "50%",
        transform: "translate(-50%, -50%)",
      }}
    >
      {children}
    </div>
  );
}

function Hint({ children }: { children: React.ReactNode }) {
  return (
    <div className="label-ui py-6 text-center" style={{ color: "var(--ah-stone-350)" }}>
      {children}
    </div>
  );
}

/** One feed card's reading-count mark, as its own subscription: the selector
 *  returns a primitive, so a pass elsewhere in the feed re-renders nothing
 *  here (WORKSPACE-QUEUE-ADR §IV.8). */
function FeedSeenMarked({
  feedId,
  postId,
  render,
}: {
  feedId: string;
  postId: string;
  render: (seen: SeenMark) => React.ReactNode;
}) {
  const seen = useFeedSeenMark(feedId, postId);
  return <>{render(seen)}</>;
}
