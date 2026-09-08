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
  workspaceFeeds as workspaceFeedsApi,
  follows as followsApi,
  auth,
  type WorkspaceFeed,
  type WorkspaceFeedSource,
} from "../../lib/api";
import type { PipStatus } from "../../lib/ndk";
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
import { PostThread } from "../post/PostThread";
import type { CardContext } from "../post/chassis";
import type { Post } from "../../lib/post/types";
import { quotePreviewContent } from "../../lib/post/quote-preview";
import { originWebUrl } from "../../lib/post/origin-url";
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
import { Muster } from "./Muster";
import { useMobileActiveFeed } from "../../stores/mobileActiveFeed";
import { useFeedArrivals } from "../../stores/feedArrivals";
import { Composer, type ReplyTarget } from "./Composer";
import type { QuoteTarget } from "../../lib/publishNote";
import { getCachedWriterName, resolveWriterName } from "../../hooks/useWriterName";
import { PipPanel } from "./PipPanel";
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
  LazyNetworkOverlay as NetworkOverlay,
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
import { useLightbox } from "../../stores/lightbox";

const FLOOR = "var(--ah-bone)"; // grey-100 per Step 1 / Colour tokens committed
const DEFAULT_FEED_NAME = "Founder's feed";

/** Px of pan before the virtualization band is re-read (hysteresis dead band).
 *  Well under the one-viewport mount margin, so a vessel is never parked while
 *  any part of it is on screen. */
const VIRT_QUANT = 200;

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
  return {
    kind: "external",
    postId: p.id,
    url: p.origin.uri,
    title: p.body.title,
    siteName: p.origin.sourceName,
    // The reader bar's inward link (`/source/:id`) — the same target the card's
    // provenance line offers, carried over so the pane names the thing the
    // reader subscribed to and not just the site (BYLINE-AND-PROVENANCE D7).
    sourceId: p.externalSourceId ?? null,
    // The item's own enclosures — the pane plays a video the origin page may
    // have no player for (the card already did; the pane did not).
    media: p.body.media ?? null,
  };
}

// Friendly origin label shown on the quoted-mini when quoting an external post
// (mirrors PostOriginTag / SourceAttribution). Falls back to the source name,
// then the upper-cased protocol.
const EXTERNAL_QUOTE_LABEL: Record<string, string> = {
  atproto: "BLUESKY",
  activitypub: "FEDIVERSE",
  nostr_external: "NOSTR",
  rss: "RSS",
  email: "EMAIL",
};

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


export function WorkspaceView() {
  const { user, loading } = useAuth();
  const router = useRouter();
  // MOBILE-LAYOUT-ADR: mobile is not a reflow of the canvas — it is a
  // different interaction model over the same feeds. This switch swaps the
  // body (vessels ↔ pager) while everything else (data, overlays, composer,
  // pip panel) is shared.
  const isMobile = useIsMobile();
  // On mobile every feed follows the GLOBAL light/dark toggle (uniform), not
  // its per-feed scheme; on desktop feeds keep their scheme (light-islanded).
  const globalDark = useColorScheme((s) => s.dark);
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
    if (composeReqOpen && composeReqMode === "note") {
      setReplyTarget(null);
      setQuoteTarget(null);
      setComposerOpen("note");
    }
  }, [composeReqOpen, composeReqMode]);
  const [replyTarget, setReplyTarget] = useState<ReplyTarget | null>(null);
  // Quote target — set when Quote is clicked on a card; the composer publishes a
  // NIP-18 quote note embedding it. Mutually exclusive with replyTarget.
  const [quoteTarget, setQuoteTarget] = useState<QuoteTarget | null>(null);
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
        setReplyTarget(null);
        setQuoteTarget(null);
        setComposerOpen("note");
      }
    }
    document.addEventListener("keydown", handleKeyDown);
    return () => document.removeEventListener("keydown", handleKeyDown);
  }, []);
  // At most one conversation is expanded per feed. This maps a feed id to its
  // single open card: `key` (`feedItemId ?? id`) is the card slot, `root` is the
  // post the conversation is rooted on — normally the card's own post, but the
  // quoted post when the card was opened by clicking its embedded quote (so the
  // quote expands with full seniority, no trace of its host). Opening another
  // card in the same feed replaces the entry, collapsing the previous one.
  const [expandedByFeed, setExpandedByFeed] = useState<
    Record<string, { key: string; root: string }>
  >({});
  // Drop a feed's expansion entry. Called on refresh (a reload collapses the
  // open conversation) and on delete/merge — a vessel that no longer exists
  // must not leave its key behind, or a feed later minted with the same id
  // would open pre-expanded onto a stale card.
  const clearExpandedFor = useCallback((feedId: string) => {
    setExpandedByFeed((prev) => {
      if (!(feedId in prev)) return prev;
      const next = { ...prev };
      delete next[feedId];
      return next;
    });
  }, []);
  // A single global tick: bumped after a reply publishes so any open PostThread
  // busts its cache and refetches (replaces the legacy per-target refresh map).
  const [threadRefreshTick, setThreadRefreshTick] = useState(0);
  const [pipPanel, setPipPanel] = useState<{
    pubkey: string;
    status?: PipStatus;
    rect: DOMRect;
    // Slice 14: which feed the panel was opened from. The volume bar's commit
    // surface scopes per-feed-per-author, so the panel needs to know which
    // ⊔ contributed the click.
    feedId: string;
  } | null>(null);
  const [followedPubkeys, setFollowedPubkeys] = useState<Set<string>>(
    new Set(),
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
  const setVesselOrientation = useWorkspace((s) => s.setVesselOrientation);
  const setVesselTextSize = useWorkspace((s) => s.setVesselTextSize);
  const regimented = useWorkspace((s) => s.regimented);
  const setRegimented = useWorkspace((s) => s.setRegimented);
  const materializeRegimented = useWorkspace((s) => s.materializeRegimented);

  // The reader is the one immersive pane: while it is open it may cover the nav
  // bar entirely (Glasshouse `coverNavChrome`), so the bar + muster un-mount
  // and only the z-60 ∀ lockup floats above the reading surface. Every other
  // pane keeps the bar live (navigation over an open pane —
  // WORKSPACE-COLUMN-LAYOUT §VI), so this is scoped to the reader alone. One
  // pane opens at a time, so "reader open" is an unambiguous signal.
  const readerOpen = useReader((s) => s.isOpen);

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

  // Ctrl+←/→ jumps the floor to its far end — the keyboard twin of panning a
  // space whose resting extent is exactly the feeds' span. Plain arrows stay
  // free (the reader's ←/→ skip, text-field caret movement); Ctrl+arrow inside
  // an editable field keeps its native word-jump, and an open Glasshouse owns
  // the keyboard.
  useEffect(() => {
    if (isMobile) return;
    function onKey(e: KeyboardEvent) {
      if (e.key !== "ArrowLeft" && e.key !== "ArrowRight") return;
      if (!e.ctrlKey || e.metaKey || e.altKey || e.shiftKey) return;
      const t = e.target as HTMLElement | null;
      if (
        t?.closest(
          'input, textarea, select, [contenteditable=""], [contenteditable="true"]',
        )
      )
        return;
      if (useGlasshousePresence.getState().isOpen) return;
      // Not while a vessel is held: scrolling the floor under a live framer
      // drag origin teleports the vessel relative to the ground and lets the
      // pointer-based merge arming read whatever scrolled under the cursor.
      if (dragActiveRef.current) return;
      const floor = floorRef.current;
      if (!floor) return;
      e.preventDefault();
      floor.scrollTo({
        left:
          e.key === "ArrowLeft" ? 0 : floor.scrollWidth - floor.clientWidth,
        behavior: prefersReducedMotion() ? "auto" : "smooth",
      });
    }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [isMobile]);

  // The local, non-Glasshouse transient surfaces. With `lensSuppress` gone
  // (Slice 4) there is no generic "a modal is open" registry, and these are all
  // plain component state anyway — so the `\` handler reads them off a ref
  // instead of re-attaching its listener every time one opens.
  const localSurfaceOpenRef = useRef(false);
  localSurfaceOpenRef.current =
    newFeedOpen ||
    !!pendingMerge ||
    !!pipPanel ||
    !!feedComposerFor ||
    !!composerOpen ||
    !!ceremony;

  // `\` toggles the regimented layout (§V): every visible feed on screen at
  // once, numeral order, factory width — the parade ground. It is a VIEW, so
  // the stored layout is untouched and a second press drops straight back to
  // it. Guarded the way every other global binding here is: never in an
  // editable field, never with a modifier (so ⌘\ / Ctrl+\ stay free), never
  // while a Glasshouse pane, the lightbox, one of the local surfaces above or
  // an Explain program owns the keyboard, and never mid-drag.
  useEffect(() => {
    if (isMobile) return;
    function onKey(e: KeyboardEvent) {
      if (e.key !== "\\") return;
      if (e.metaKey || e.ctrlKey || e.altKey || e.shiftKey) return;
      const t = e.target as HTMLElement | null;
      // [role="menu"] covers the open ∀ dropdown (focus sits on a menu row
      // while it is up — it is neither a Glasshouse nor one of the local
      // surfaces below, so nothing else guards it).
      if (
        t?.closest(
          'input, textarea, select, [contenteditable=""], [contenteditable="true"], [role="menu"]',
        )
      )
        return;
      // The frozen floor owns the keyboard while a program runs, and Explain is
      // not in the Glasshouse presence registry — the pane check alone misses it.
      if (useExplain.getState().isActive) return;
      if (useGlasshousePresence.getState().isOpen) return;
      if (useEditorOverlay.getState().isOpen) return;
      if (useLightbox.getState().isOpen) return;
      if (localSurfaceOpenRef.current) return;
      if (dragActiveRef.current) return;
      if (resizeActiveRef.current) return;
      e.preventDefault();
      const next = !useWorkspace.getState().regimented;
      setRegimented(next);
      // Entering the parade jumps to the left edge — the lowest-numbered
      // VISIBLE feed (which is Feed 1 unless it is minimised; the parade reads
      // in numeral order but with gaps, NAV-ROW-MUSTER-ADR §III.1).
      // Instant, not smooth: the whole floor just changed shape under the
      // scroll position, so there is nothing coherent to animate between.
      if (next) floorRef.current?.scrollTo({ left: 0, behavior: "auto" });
    }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [isMobile, setRegimented]);

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
  }, [user, loading, isMobile, syncPan]);
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
    removeFeedLayout(source.id);
    clearExpandedFor(source.id);
    setPendingMerge(null);
  }

  const loadVesselItems = useCallback(async (feed: WorkspaceFeed) => {
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
    try {
      const data = await workspaceFeedsApi.items(feed.id);
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
    } catch (err) {
      console.error("Vessel items load error:", err);
      setVessels((prev) =>
        prev.map((v) =>
          v.feed.id === feed.id ? { ...v, status: "error" } : v,
        ),
      );
    }
  }, [clearExpandedFor]);

  // Feed ids with a load-more request in flight. This is the CONCURRENCY guard;
  // the vessel's own `loadingMore` field is presentation only (it drives the
  // spinner). React state can't guard here: `vesselsRef` only catches up on
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
    const cursor = current.nextCursor;
    setVessels((prev) =>
      prev.map((v) =>
        v.feed.id === feedId ? { ...v, loadingMore: true } : v,
      ),
    );
    try {
      const data = await workspaceFeedsApi.items(feedId, { cursor });
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
      setVessels((prev) =>
        prev.map((v) =>
          v.feed.id === feedId ? { ...v, loadingMore: false } : v,
        ),
      );
    } finally {
      loadingMoreRef.current.delete(feedId);
    }
  }, []);

  const vesselsRef = useRef(vessels);
  vesselsRef.current = vessels;

  function refreshAll() {
    // Refreshing every vessel collapses every expanded conversation.
    setExpandedByFeed({});
    vesselsRef.current.forEach((v) => void loadVesselItems(v.feed));
  }

  function handleForallAction(key: ForallAction) {
    if (key === "new-note") {
      setReplyTarget(null);
      setQuoteTarget(null);
      setComposerOpen("note");
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
    return descriptive ? `Feed ${num}: ${descriptive}` : `Feed ${num}`;
  }

  const hiddenFeeds = vessels
    .filter((v) => v.feed.hidden)
    .map((v) => ({
      id: v.feed.id,
      name: v.feed.name.trim() || "Unnamed feed",
    }));

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
      const src = vessels.find((v) => v.feed.id === payload.feedId);
      const tgt = vessels.find((v) => v.feed.id === targetFeedId);
      if (src) void loadVesselItems(src.feed);
      if (tgt) void loadVesselItems(tgt.feed);
      for (const fid of [payload.feedId, targetFeedId]) {
        workspaceFeedsApi
          .listSources(fid)
          .then(({ sources }) => {
            setVessels((prev) =>
              prev.map((v) => (v.feed.id === fid ? { ...v, sources } : v)),
            );
          })
          .catch(() => {});
      }
    } catch (err) {
      console.error("Move source failed:", err);
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

  useEffect(() => {
    if (!loading && !user) router.push("/auth?mode=login");
  }, [user, loading, router]);

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
    window.history.replaceState({}, "", `/reader${qs ? `?${qs}` : ""}`);
    openOverlayFromParams(seed);
  }, []);

  // Slice 12: fetch the user's followed pubkeys once on mount so the pip
  // panel can render its initial follow state without a per-open round-trip.
  // Failure is non-fatal — panel just defaults to "not following."
  useEffect(() => {
    if (!user) return;
    let cancelled = false;
    followsApi
      .listPubkeys()
      .then(({ pubkeys }) => {
        if (cancelled) return;
        setFollowedPubkeys(new Set(pubkeys));
      })
      .catch(() => {
        if (!cancelled) setFollowedPubkeys(new Set());
      });
    return () => {
      cancelled = true;
    };
  }, [user]);

  // Hydrate the workspace store from localStorage as soon as the user is
  // known. Bootstrap below depends on hydration so default-slot writes don't
  // overwrite a stored layout.
  useEffect(() => {
    if (user) hydrate(user.id);
  }, [user, hydrate]);

  // Bootstrap: one aggregate call returns the feed list plus, per feed, its
  // sources + first page of items (performance audit #3) — collapsing the old
  // list()+per-feed listSources()+items() fan-out into a single round trip.
  // Feeds absent from `vessels` (a freshly minted default, or a server-side
  // hydration hiccup) fall back to the per-vessel lazy loaders below.
  // Re-runs only when the authenticated user changes.
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
        if (user.onboardedAt === null && !useGlasshousePresence.getState().isOpen) {
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
  }, [user, hydrated, loadVesselItems]);

  // The feed's card list — shared verbatim by the desktop vessel and the
  // mobile full-bleed page (MOBILE-LAYOUT-ADR §III), so the two surfaces
  // cannot drift. Orientation never reaches the cards (it is a chassis
  // property); scheme/density/text size ride the layout store as on desktop.
  function renderFeedContents(v: VesselState) {
    const look = appearance[v.feed.id] ?? {};
    // Both surfaces render the feed's colourway in the global mode's light or
    // dark variant. Desktop vessels and the mobile pages are both islanded
    // (LIGHT_ISLAND_STYLE), so the derived text slugs the palette references
    // resolve canonical regardless of mode and the variant supplies light/dark.
    const feedPalette = paletteFor(look.brightness, globalDark);
    return (
      <>
            {v.status === "loading" && <Hint>LOADING…</Hint>}
            {v.status === "error" && <Hint>COULDN&rsquo;T LOAD FEED</Hint>}
            {v.status === "ready" &&
              v.items.length === 0 &&
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
            {v.status === "ready" && v.caughtUp && v.items.length > 0 && (
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
              v.items.map((item) =>
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
                      dragData: (() => {
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
                    const toggleExpand = () =>
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
                          [v.feed.id]: { key: expandKey, root: post.id },
                        };
                      });
                    // The focal click is a CLOSE, never the toggle above: while
                    // a quote expansion is open the toggle swings to the host,
                    // and the focal must still collapse the conversation (§4).
                    const collapseHere = () =>
                      setExpandedByFeed((prev) => {
                        if (prev[v.feed.id]?.key !== expandKey) return prev;
                        const next = { ...prev };
                        delete next[v.feed.id];
                        return next;
                      });
                    // Clicking the embedded quote tile opens the QUOTED post as
                    // the focal of an expanded conversation — full seniority, no
                    // residue of the host that embedded it. Distinct from a body
                    // click (which expands the host): the tile stops propagation,
                    // so the two clicks never collide. The gateway minted a
                    // feed_items twin when the tile hydrated, so /thread resolves
                    // the quoted post's id (post.quotes).
                    const expandQuote = (quotedPostId: string) =>
                      setExpandedByFeed((prev) => ({
                        ...prev,
                        [v.feed.id]: { key: expandKey, root: quotedPostId },
                      }));
                    const onPipOpen = (
                      pubkey: string,
                      rect: DOMRect,
                      status: typeof post.author.pipStatus | undefined,
                    ) => setPipPanel({ pubkey, rect, status, feedId: v.feed.id });
                    // Native reply only (external interact-back is a Phase 2/3
                    // documented cut). version = the all.haus event id (vote +
                    // reply target); type picks the kind.
                    const replyFromPost = (p: Post) => {
                      setQuoteTarget(null);
                      setReplyTarget({
                        eventId: p.version ?? p.id,
                        eventKind: p.type === "article" ? 30023 : 1,
                        authorPubkey: p.author.pubkey ?? "",
                        authorName: "",
                        excerpt: (p.body.text ?? "").slice(0, 120),
                      });
                      setComposerOpen("note");
                    };
                    // Native quote → a NIP-18 quote note that embeds this post.
                    // version = the nostr event id of the thing being quoted.
                    const quoteFromPost = (p: Post) => {
                      // External post (no nostr pubkey): quote as a native note
                      // that references the origin by post_id + public URL,
                      // rendering the same rich quoted-mini (migration 102).
                      if (!p.author.pubkey) {
                        setReplyTarget(null);
                        setQuoteTarget({
                          eventId: "",
                          eventKind: 1,
                          authorPubkey: "",
                          isExternal: true,
                          quotedPostId: p.id,
                          quotedUrl: originWebUrl(p) ?? undefined,
                          quotedSource:
                            p.origin.sourceName ??
                            EXTERNAL_QUOTE_LABEL[p.origin.protocol] ??
                            p.origin.protocol.toUpperCase(),
                          previewTitle: p.body.title ?? undefined,
                          previewContent: quotePreviewContent(p),
                          previewAuthorName:
                            p.author.displayName ?? p.author.handle ?? undefined,
                        });
                        setComposerOpen("note");
                        return;
                      }
                      const eventId = p.version ?? p.id;
                      const pubkey = p.author.pubkey ?? "";
                      // Native display names aren't on the workspace Post (the
                      // byline resolves them via useWriterName), so read that
                      // warm cache for the "Quoting …" banner; fall back to the
                      // handle, then patch in an async resolve on a cold cache.
                      const cachedName = pubkey
                        ? getCachedWriterName(pubkey)
                        : null;
                      setReplyTarget(null);
                      setQuoteTarget({
                        eventId,
                        eventKind: p.type === "article" ? 30023 : 1,
                        authorPubkey: pubkey,
                        previewTitle: p.body.title ?? undefined,
                        previewContent: quotePreviewContent(p),
                        previewAuthorName:
                          p.author.displayName ?? cachedName ?? p.author.handle ?? undefined,
                      });
                      setComposerOpen("note");
                      if (pubkey && !p.author.displayName && !cachedName) {
                        void resolveWriterName(pubkey).then((info) => {
                          if (!info) return;
                          setQuoteTarget((prev) =>
                            prev && prev.eventId === eventId
                              ? { ...prev, previewAuthorName: info.displayName }
                              : prev,
                          );
                        });
                      }
                    };
                    // Article click → reader pane (§3.1 / Phase R). Native by
                    // d-tag (/article/<dTag>), external by URL (/read/<postId>).
                    // Actions are stable refs, so getState() avoids subscribing.
                    const openReaderFromPost = (p: Post) => {
                      const reader = useReader.getState();
                      // Frame the reader in the launching feed's COLOURWAY (not a
                      // colour — the pane re-derives bar, ⊓ and ear arrows off one
                      // palette, and hands the scheme on again when the bar's
                      // source link opens a surface), and hand it the feed's
                      // article list so the skip ears step through them in place.
                      const frame = { frameScheme: ctx.palette.scheme };
                      const entries = v.items
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
                    const collapsedCard = (
                      <PostCardInteractive
                        post={post}
                        level="feed"
                        expanded={false}
                        ctx={ctx}
                        onPipOpen={onPipOpen}
                        onExpand={toggleExpand}
                        onQuoteOpen={expandQuote}
                        onOpenReader={openReaderFromPost}
                        onReply={
                          post.author.pubkey
                            ? () => replyFromPost(post)
                            : undefined
                        }
                        onQuote={() => quoteFromPost(post)}
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
                            onCollapse={collapseHere}
                            onReply={replyFromPost}
                            onQuote={quoteFromPost}
                            onOpenReader={openReaderFromPost}
                            onPipOpen={onPipOpen}
                            refreshKey={threadRefreshTick}
                          />
                        </Fragment>
                      );
                    }
                    return <Fragment key={item.id}>{collapsedCard}</Fragment>;
                  })(),
              )}
      </>
    );
  }

  if (loading || !user) {
    return <Floor />;
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
      <Floor floorRef={floorRef} insetTop={barH}>
      {bootstrap === "loading" && (
        <CenteredHint>BOOTSTRAPPING WORKSPACE…</CenteredHint>
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
      {bootstrap === "ready" && !isMobile && (
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
                onSourceAdded={() => {
                  void loadVesselItems(v.feed);
                  workspaceFeedsApi
                    .listSources(v.feed.id)
                    .then(({ sources }) =>
                      setVessels((prev) =>
                        prev.map((vs) =>
                          vs.feed.id === v.feed.id ? { ...vs, sources } : vs,
                        ),
                      ),
                    )
                    .catch(() => {});
                }}
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
                hidden={ceremony?.feedId === v.feed.id}
                floorRef={floorRef}
                onCardDrop={(raw) => handleCardDrop(v.feed.id, raw)}
                onRefresh={() => loadVesselItems(v.feed)}
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
                {renderFeedContents(v)}
              </Vessel>
              );
            })}
        </div>
      )}
      {/* The nav bar (§VI) — chrome only; the lockup docks into its left end
          via ForallMenu anchor="row" below. Desktop only: the mobile bar
          carries its own wordmark. Un-mounted while the reader is open so the
          immersive reading pane can cover the toolbar region; the ∀ lockup
          (z-60, rendered below) still floats over it. */}
      {!isMobile && !readerOpen && <NavBar />}
      {/* The muster (NAV-ROW-MUSTER-ADR §IV) — a separate fixed layer over the
          bar band, docked at its right end and clearing the lockup. Desktop
          only: the mobile indicator strip is the pip strip in its own bar.
          Hidden with the bar under an open reader. */}
      {!isMobile && !readerOpen && <Muster feeds={musterFeeds} onGoTo={goToFeed} />}
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
        anchor={isMobile ? "bar" : "row"}
      />
      <Composer
        open={!!composerOpen}
        replyTarget={replyTarget}
        quoteTarget={quoteTarget}
        onClose={() => {
          setComposerOpen(false);
          setReplyTarget(null);
          setQuoteTarget(null);
          // Keep the global compose store (the bridge trigger) in sync so a
          // re-open request from outside this component fires the effect again.
          if (useCompose.getState().isOpen) useCompose.getState().close();
        }}
        onPublished={refreshAll}
        onReplied={() => {
          // Bump the global thread tick so an open PostThread busts its cache and
          // refetches, surfacing the just-published reply.
          setThreadRefreshTick((t) => t + 1);
        }}
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
        orientation={
          feedComposerFor
            ? appearance[feedComposerFor.id]?.orientation
            : undefined
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
        // Orientation is a canvas property with no spatial substrate on the
        // phone (§VI) — the control doesn't render on mobile.
        onOrientationChange={
          isMobile
            ? undefined
            : (next) =>
                feedComposerFor &&
                setVesselOrientation(feedComposerFor.id, next)
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
      <PipPanel
        open={!!pipPanel}
        pubkey={pipPanel?.pubkey ?? ""}
        pipStatus={pipPanel?.status}
        feedId={pipPanel?.feedId}
        anchorRect={
          pipPanel
            ? {
                top: pipPanel.rect.top,
                left: pipPanel.rect.left,
                bottom: pipPanel.rect.bottom,
                right: pipPanel.rect.right,
              }
            : null
        }
        initialIsFollowing={
          pipPanel ? followedPubkeys.has(pipPanel.pubkey) : false
        }
        onClose={() => setPipPanel(null)}
        onFollowChanged={(pk, isFollowing) => {
          setFollowedPubkeys((prev) => {
            const next = new Set(prev);
            if (isFollowing) next.add(pk);
            else next.delete(pk);
            return next;
          });
        }}
        onVolumeChanged={(feedId) => {
          // Mute state is honoured by the items query (slice 4); refetch the
          // affected vessel so a freshly-muted author drops from the visible
          // set without a manual reload.
          const target = vessels.find((v) => v.feed.id === feedId);
          if (target) void loadVesselItems(target.feed);
        }}
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
      <NetworkOverlay />
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

          DESKTOP ONLY, like <ExplainOverlay> above and for the same reason: the
          six beats annotate the floor, which the mobile branch does not have.

          `tourArmed` is the MEMBER-level half of the gate (`onboarded_at` NULL
          + bootstrap settled + no ceremony playing); the controller adds the
          per-device key, the ≥1-vessel wait, beat-3 readiness and the courtesy
          of never opening over a deep-linked pane. Stamping `onboarded_at` is
          this component's job now that nothing else does it — see `onOpened`. */}
      {/* PREVIEW ENTRY — `/reader?firstrun=1`, localhost only, consumes
          nothing (no seen-flag, no `onboarded_at` stamp), so the sequence can
          be watched more than once. See FirstRunPreview for why it is a
          separate component and why the gate is a hostname. */}
      {!isMobile && <FirstRunPreview />}
      {!isMobile && tourArmed && user && (
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

function Floor({
  children,
  floorRef,
  insetTop = 0,
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
}) {
  // Register the floor as an explainable root (EXPLAIN-ADR D4). Inert outside an
  // ExplainProvider (the loading/redirect Floor), so this is a no-op there.
  const ref = useExplainable("floor", { ref: floorRef });

  // The floor's own `overscroll-behavior-x: contain` only bites while the floor
  // is ACTUALLY scrollable — a taut floor narrower than the viewport (two or
  // three feeds on a wide screen: the common case) is not, so the browser
  // ignores it and hands a sideways swipe to its back/forward gesture. On a
  // surface where sideways is how both the feeds and the floor move, that reads
  // as the workspace randomly navigating away. Nothing here scrolls the
  // DOCUMENT sideways, so the document's horizontal overscroll can only ever be
  // that gesture; refuse it for as long as the workspace is mounted, and hand it
  // back on the way out so the rest of the site keeps it.
  useEffect(() => {
    const html = document.documentElement;
    const prev = html.style.overscrollBehaviorX;
    html.style.overscrollBehaviorX = "none";
    return () => {
      html.style.overscrollBehaviorX = prev;
    };
  }, []);
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
        overflowX: "auto",
        overflowY: "hidden",
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
