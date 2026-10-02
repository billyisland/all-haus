"use client";

import {
  forwardRef,
  useCallback,
  useEffect,
  useImperativeHandle,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  useSyncExternalStore,
  type ReactNode,
} from "react";
import { flushSync } from "react-dom";
import { animate, useMotionValue, type AnimationPlaybackControls } from "framer-motion";
import {
  factsOf,
  feedSetChanged,
  init,
  refreshed,
  refreshedEmpty,
  settle,
  step,
  tier,
  type Facts,
  type QueueKey,
  type QueueState,
  type Toggle,
} from "../../../lib/workspace/queue";
import { queueGeometry } from "../../../lib/workspace/queueGeometry";
import {
  captureCardAnchor,
  restoreCardAnchor,
  type CardAnchor,
} from "../../../lib/workspace/preserveCardPosition";
import { feedSeenCounts, useFeedSeen } from "../../../stores/feedSeen";
import { useGlasshousePresence } from "../../../stores/glasshouse";
import { useEditorOverlay } from "../../../stores/editorOverlay";
import { useLightbox } from "../../../stores/lightbox";
import { useExplain } from "../../../stores/explain";
import { VesselChassis, type VesselChassisProps } from "../VesselChassis";
import type { PullToRefreshHandle, RefreshResult } from "../PullToRefresh";
import { FEED_PAGE_SIZE, type MergeOutcome } from "../../../lib/workspace/feedMerge";
import {
  QUEUE_EASE,
  QUEUE_MOTION_MS,
  QUEUE_STEP_RATIO,
  VESSEL_WALL,
  type VesselPalette,
} from "../tokens";
import { entryMotion } from "../../../lib/workspace/queueMotion";
import { prefersReducedMotion } from "../../../lib/workspace/motion";
import { queueFeedName } from "../../../lib/workspace/queueLabel";
import { GRID } from "../../../lib/workspace/grid";
import { QueueEntry } from "./QueueEntry";
import { QueueBar } from "./QueueBar";
import { HiddenBars } from "./HiddenBars";
import { PreviewLayer } from "./PreviewLayer";
import { QueueMotionContext } from "./queueBinding";
import { useQueueGesture } from "./useQueueGesture";

// QueueView — the queue mode (WORKSPACE-QUEUE-ADR Phase B). Every visible feed
// in one horizontal sequence, exactly one FOCAL: the feeds passed are lines to
// its left, the feeds ahead are compact to its right, sorted by what needs
// reading. The model is `lib/workspace/queue.ts`; this owns its state.
//
// What it honours:
//
//   · SESSION STATE (§V.6). The queue is `init`ed on mount — a fresh sort,
//     focal at the head — and never persisted.
//   · FACTS ARE READ, NEVER HELD. The counts come off the seen store at the
//     moment an operation needs them; QueueView does not subscribe to the
//     passed sets, because every pass would re-render the focal card tree.
//   · THE HOST OWNS THE DATA (§VI.2). Items, cursor and the load sequence stay
//     in WorkspaceView; this reads them through `renderContents` and never
//     writes them.
//   · THE FEED SET IS SHARED WITH THE FLOOR (§VI.6). A hide or restore arrives
//     as a prop change — whoever made it, and including the optimistic
//     revert — and becomes `hide` / `restore` here; a feed created or deleted
//     becomes a `reconcile`. Nothing here writes the columnar layout.
//   · ONE TAB STOP (§VI.7): the focal scroller. Lines and compact bars are
//     buttons with `tabIndex=-1`; the arrows, Home and End move focal and take
//     focus with them, without scrolling.
//   · AT MOST THREE CARD TREES (§VI.2, §VII.3): focal and its two neighbours,
//     the neighbours' lists laid out but `inert`, `aria-hidden` and unseen,
//     so a step either way lands on a list that is already there. Every other
//     entry mounts none.
//   · POSITION OUTLIVES THE MOUNT (§VII.3). A list's place is kept here, as
//     the card the reader was on and its offset, because the entry that held
//     it dies when the queue walks away. It is CAPTURED before every move
//     that takes focal away — every such move goes through `move` — since
//     once React commits the move the list it would be read from may be gone.
//     It is RESTORED each time a list mounts, before that list's pass tracker
//     attaches, so a post merged in above the anchor is never passed on
//     arrival. The neighbours are never scrolled (they are inert), so an
//     anchor taken as the reader leaves focal stays true until they return.
//   · A FEED AHEAD SHOWS ITS ROWS (§VII.5): the preview layer, over the
//     chassis, on every compact entry — and held unseen on focal, ready for
//     a step back (§VII.3). It keeps its own anchor beside the full list's,
//     never synced with it. A compact entry clipped past the right edge
//     mounts none: what is off-screen costs nothing, as on the floor
//     (COLUMN-LAYOUT §VII), with a focal width of slack so an entry sliding
//     in during a step already has its rows.
//   · A STEP IS ONE NUMBER (§VII.6). The sideways drag (`useQueueGesture`)
//     and every animated walk drive one MotionValue, `u`, and every width and
//     opacity in the queue is a function of it and the entry's place
//     (`entryMotion`), written straight to the style (`queueBinding`). React
//     renders at a step's COMMIT and not before: `u` goes back to 0 and the
//     step applies in the same task (`commitStep`), and because the geometry
//     at `u = ±1` is the next resting state, nothing jumps.
//   · A GESTURE IS NOT ATTENTION (§VII.2). From the first claimed event until
//     the settle ends — and for the whole of a walk — no feed is `engaged`,
//     so nothing crossed dwells; and a sort waits for the end rather than
//     re-sorting under the reader's fingers (§VI.5).
//   · FETCHED ON A TIMER, SHOWN ON A GESTURE (the operator, 2026-09-26). The
//     host reads every feed into a buffer in the background and the badges
//     follow it live, but nothing is SHOWN, and nothing MOVES, until the
//     reader pulls: a feed's top (that feed's buffer, at once), or the EDGE
//     PULL, the same gesture turned on its side at the queue's head (every
//     buffer, then a fresh sort, focal at the head). The one sort the reader
//     did not ask for is the first, and the queue is not shown until it has
//     run — so nothing reorders in front of them.
//   · A WALK OF SEVERAL STEPS MOUNTS ONLY WHERE IT LANDS (§VII.7). The feeds
//     it crosses pass through focal as washes, with no card tree; the landing
//     feed's list mounts as the walk starts, laid out at rest under its clip,
//     so its anchor is restored against final geometry.

export interface QueueFeed {
  id: string;
  numeral: number;
  /** Trimmed; empty when the feed has none (a feed's name is optional). */
  name: string;
  hidden: boolean;
  createdAt: string;
  palette: VesselPalette;
  caughtUp?: boolean;
  /** Ready with cards — the chassis tail the last card can be passed through. */
  hasItems: boolean;
  /** What the tail says: the next page is loading, or there is none. */
  tailNote?: "loading" | "end";
  /** Seeded for its owner (EXPLAIN-ADR D7) — the tour's first beat forks on it. */
  fromStarter: boolean;
}

export interface QueueViewHandle {
  /** Walk to a feed (the muster's `onGoTo`, §VI.4). */
  walkTo: (feedId: string) => void;
}

interface QueueViewProps {
  feeds: QueueFeed[];
  /** The inset viewport — `h` already shortened by the nav bar. */
  vp: { w: number; h: number };
  /** The hidden feeds' bars: the `basic` scheme (§VII.4). */
  hiddenPalette: VesselPalette;
  /** A pane over the queue holds the attention (§VII.2). */
  attentionElsewhere: boolean;
  renderContents: (feedId: string) => ReactNode;
  /** A feed's preview rows (§VII.5) — the host's one card path at `preview`. */
  renderPreview: (feedId: string) => ReactNode;
  /** The reader's pull on the focal feed: its buffer MERGED in, now (§VI.5);
   *  `null` when nothing was buffered. */
  onReveal: (feedId: string) => MergeOutcome | null;
  /** The edge pull: every visible feed's buffer, merged in, now. */
  onRevealAll: () => Map<string, MergeOutcome | null>;
  onLoadMore: (feedId: string) => void;
  onCaughtUpDismiss: (feedId: string) => void;
  onNameClick: (feedId: string) => void;
  onSourceAdded: (feedId: string) => void;
  onHide: (feedId: string) => void;
  onRestore: (feedId: string) => void;
  onFocalChange: (focal: QueueKey | null) => void;
}

/** A boolean React hears about only where it asks — the chassis's gate —
 *  so the start and end of a gesture never re-render the card trees. */
function createFlag() {
  let v = false;
  const subs = new Set<() => void>();
  return {
    get: () => v,
    set(next: boolean) {
      if (next === v) return;
      v = next;
      subs.forEach((f) => f());
    },
    subscribe(f: () => void) {
      subs.add(f);
      return () => {
        subs.delete(f);
      };
    },
  };
}
type Flag = ReturnType<typeof createFlag>;

/** The chassis, disengaged while the queue is moving (§VII.2). Its own
 *  subscription, so the flag re-renders the chassis and never the list: the
 *  children it passes on are the same elements QueueView last rendered. */
function GatedChassis({ busy, engaged, ...rest }: VesselChassisProps & { busy: Flag }) {
  const moving = useSyncExternalStore(busy.subscribe, busy.get, () => false);
  return <VesselChassis {...rest} engaged={engaged && !moving} />;
}

// How long each mouth line stands (§VII.9), and the empty pull's advance.
const MOUTH_MS = 1200;
const MOUTH_LONG_MS = 1600;
const MOUTH_ADVANCE_MS = 900;
// The flash on the feed an empty pull moved to (§VII.8): solid, then gone.
const FLASH_SOLID_MS = 900;
const FLASH_GONE_MS = 1600;
// The first sort's wait for the counts on a fresh load (§VII.10), and how many
// windows it asks for at once.
const INIT_HOLD_MS = 3000;
const INIT_FETCH_CONCURRENCY = 4;

// The edge pull's strip at full travel, px — the feed pull's THRESHOLD — and
// where it stands while it says what the pull found (the feed mouth's
// `MESSAGE_H`, as a share of that).
const EDGE_STRIP_W = 60;
const EDGE_LINE_AT = 0.6;

/** Where an entry's left edge rests: the lines, then focal, then the compact
 *  entries — relative, since a FLIP needs only the difference. */
function restLeft(
  i: number,
  keys: readonly QueueKey[],
  focal: QueueKey | null,
  g: { lineW: number; focalW: number; compactW: number; gap: number },
): number {
  const p = focal === null ? 0 : keys.indexOf(focal);
  if (i <= p) return i * (g.lineW + g.gap);
  return p * (g.lineW + g.gap) + g.focalW + g.gap + (i - p - 1) * (g.compactW + g.gap);
}

/** Focal and the feeds either side of it: the lists held at rest. */
function neighbours(s: QueueState): Set<QueueKey> {
  const i = s.focal === null ? -1 : s.keys.indexOf(s.focal);
  return new Set(i < 0 ? [] : s.keys.slice(Math.max(0, i - 1), i + 2));
}

export const QueueView = forwardRef<QueueViewHandle, QueueViewProps>(
  function QueueView(
    {
      feeds,
      vp,
      hiddenPalette,
      attentionElsewhere,
      renderContents,
      renderPreview,
      onReveal,
      onRevealAll,
      onLoadMore,
      onCaughtUpDismiss,
      onNameClick,
      onSourceAdded,
      onHide,
      onRestore,
      onFocalChange,
    },
    ref,
  ) {
    const geom = useMemo(() => queueGeometry(vp), [vp]);
    const u = useMotionValue(0);
    /** The edge pull's progress, 0..1 (`useQueueGesture`). */
    const edge = useMotionValue(0);
    const [busy] = useState(createFlag);
    const reduced = prefersReducedMotion();
    const focalPullRef = useRef<PullToRefreshHandle>(null);
    /** Keys whose full card list is mounted this render. */
    const fullRef = useRef(new Set<QueueKey>());
    const feedsRef = useRef(feeds);
    feedsRef.current = feeds;
    const onRevealAllRef = useRef(onRevealAll);
    onRevealAllRef.current = onRevealAll;
    const onRevealRef = useRef(onReveal);
    onRevealRef.current = onReveal;

    /** The facts the model sorts by, read fresh (§V.1). `sortRank` is the
     *  numeral: the floor's own rank order, gap-numbered over the live set. */
    const currentFacts = useCallback((): Facts => {
      const { windows, passed } = useFeedSeen.getState();
      return factsOf(
        feedsRef.current.map((f) => {
          const c = feedSeenCounts(windows[f.id], passed[f.id]);
          return {
            id: f.id,
            sortRank: f.numeral,
            hidden: f.hidden,
            newCount: c?.new ?? 0,
            unreadCount: c?.unread ?? 0,
          };
        }),
      );
    }, []);

    const [q, setQ] = useState<QueueState>(() => init(currentFacts()));
    const qRef = useRef(q);
    qRef.current = q;
    const rootRef = useRef<HTMLDivElement>(null);

    // ── Anchors (§VI.2, §VII.3) ─────────────────────────────────────────────
    // Two per feed, never synced: the full list's and the preview layer's.
    const anchorsRef = useRef(
      new Map<string, { full?: CardAnchor; preview?: CardAnchor }>(),
    );
    const previewAnchor = useCallback(
      (feedId: string) => ({
        get: () => anchorsRef.current.get(feedId)?.preview,
        set: (preview: CardAnchor) => {
          const a = anchorsRef.current;
          a.set(feedId, { ...a.get(feedId), preview });
        },
      }),
      [],
    );
    /** The focal feed's list scroller, if its list is mounted. */
    const focalScroller = useCallback(
      () =>
        rootRef.current?.querySelector<HTMLElement>(
          '[data-queue-entry="focal"] [data-vessel-scroll]',
        ) ?? null,
      [],
    );
    const captureFocal = useCallback(() => {
      const focal = qRef.current.focal;
      // A feed a walk is crossing has no list to read (§VII.7).
      if (focal === null || !fullRef.current.has(focal)) return;
      const scroller = focalScroller();
      if (!scroller) return;
      const a = anchorsRef.current;
      a.set(focal, { ...a.get(focal), full: captureCardAnchor(scroller) });
    }, [focalScroller]);
    const restoreFull = useCallback((feedId: string, scroller: HTMLElement) => {
      const anchor = anchorsRef.current.get(feedId)?.full;
      if (anchor) restoreCardAnchor(scroller, anchor);
    }, []);
    /** Every change that can take focal away goes through here, so the list
     *  being left is read while it is still on the page. */
    const move = useCallback(
      (fn: (s: QueueState) => QueueState) => {
        captureFocal();
        setQ(fn);
      },
      [captureFocal],
    );

    // ── The live region (§VI.7) ─────────────────────────────────────────────
    // The queue's own voice, in sentences: what a refresh found, a feed
    // hidden or restored, a line brought back ahead by something new.
    const [announcement, setAnnouncement] = useState({ n: 0, text: "" });
    const announce = useCallback(
      (text: string) => setAnnouncement((a) => ({ n: a.n + 1, text })),
      [],
    );
    /** ‹target› in a mouth line: the trimmed name, or `Feed N` (§VII.9). */
    const shortName = useCallback((id: string) => {
      const f = feedsRef.current.find((x) => x.id === id);
      return f ? f.name || `Channel ${f.numeral}` : "";
    }, []);

    // ── The feed set, as the host changes it ────────────────────────────────
    const shapeKey = feeds.map((f) => `${f.id}:${f.hidden ? 1 : 0}`).join("\0");
    const prevShapeRef = useRef(new Map(feeds.map((f) => [f.id, f.hidden])));
    // The last hide or restore, so a refused PATCH's revert puts the reader
    // back where they were rather than applying the inverse (§VII.11).
    const lastToggleRef = useRef<Toggle | null>(null);
    useEffect(() => {
      const prev = prevShapeRef.current;
      const next = new Map(feedsRef.current.map((f) => [f.id, f.hidden]));
      prevShapeRef.current = next;
      const facts = currentFacts();
      // Read out here, so the updater stays pure under a double invocation.
      const last = lastToggleRef.current;
      // Said in the live region (§VI.7): one feed hidden or restored, or a
      // refused toggle put back — the inverse of the last one.
      const flips = [...next].filter(([id, h]) => prev.has(id) && prev.get(id) !== h);
      if (flips.length === 1 && [...next.keys()].every((id) => prev.has(id))) {
        const [id, hidden] = flips[0];
        const name = shortName(id);
        if (last?.feedId === id && last.hidden !== hidden)
          announce(hidden ? `Couldn't restore ${name}.` : `Couldn't hide ${name}.`);
        else announce(hidden ? `${name} hidden.` : `${name} restored.`);
      }
      move((s0) => {
        const r = feedSetChanged(s0, prev, next, facts, last);
        lastToggleRef.current = r.toggle;
        return r.state;
      });
    }, [shapeKey, currentFacts, move, shortName, announce]);

    // ── Sorts wait for rest (§VI.5) ──────────────────────────────────────────
    // The sorts a refresh asks for (`refreshed`, `refreshedEmpty`, the
    // edge pull's fresh sort) are deferred to the
    // end of any gesture or walk in progress, so nothing re-sorts under the
    // reader's fingers. Nothing sorts on its own: there is no poll (above).
    const pendingSortsRef = useRef<((s: QueueState, facts: Facts) => QueueState)[]>([]);
    /** The first sort is waiting for the counts (below). */
    const holdingRef = useRef(false);
    const flushSortsRef = useRef<() => void>(() => {});
    useEffect(() => {
      const flush = () => {
        // The first sort's hold swallows what is asked for meanwhile: its own
        // `init` sorts by all of it at once (below).
        if (holdingRef.current) return;
        const sorts = pendingSortsRef.current;
        pendingSortsRef.current = [];
        if (sorts.length === 0) return;
        const facts = currentFacts();
        // Through `move`: a fresh sort can take focal away.
        move((s0) => sorts.reduce((acc, op) => op(acc, facts), s0));
      };
      flushSortsRef.current = () => {
        if (!busy.get()) flush();
      };
      return busy.subscribe(() => {
        if (!busy.get()) flush();
      });
    }, [currentFacts, busy, move]);

    // ── The first sort waits for the counts (§VII.10, ruled 2026-09-24) ─────
    // Entered on a fresh load, most feeds have no window yet, so `init` sorted
    // them by rank and they re-sorted over the polling's ten-second first
    // pass. Now the missing windows are asked for at once (a few at a time),
    // and the queue is sorted again when they have all landed or INIT_HOLD_MS
    // has passed, whichever is first — but only if focal is still the feed the
    // reader was put on, and through the deferred sorts, so never under a
    // gesture. The queue is not SHOWN until then (the operator, 2026-09-26: it
    // rearranged itself "a few moments after hard-refreshing the page"), and
    // a window that lands after the cap waits for the reader's next pull.
    const missingWindows = useCallback(() => {
      const { windows } = useFeedSeen.getState();
      return feedsRef.current.filter((f) => !f.hidden && !windows[f.id]).map((f) => f.id);
    }, []);
    /** The first sort has run, so the queue may be shown. */
    const [sorted, setSorted] = useState(() => missingWindows().length === 0);
    // Input is refused until then: a step taken behind the loading line would
    // fail the hold's `focal === heldFocal` and show the queue unsorted.
    const sortedRef = useRef(sorted);
    sortedRef.current = sorted;
    useEffect(() => {
      const missing = missingWindows;
      const ask = missing();
      // Every window landed between the first render and this effect.
      if (ask.length === 0) {
        setSorted(true);
        return;
      }
      const heldFocal = qRef.current.focal;
      holdingRef.current = true;
      let done = false;
      const release = () => {
        if (done) return;
        done = true;
        clearTimeout(timer);
        off();
        holdingRef.current = false;
        pendingSortsRef.current.push((s, facts) =>
          s.focal === heldFocal ? init(facts) : s,
        );
        flushSortsRef.current();
        setSorted(true);
      };
      const timer = setTimeout(release, INIT_HOLD_MS);
      const off = useFeedSeen.subscribe((s, prev) => {
        if (s.windows !== prev.windows && missing().length === 0) release();
      });
      const queue = [...ask];
      const worker = async () => {
        for (let id = queue.shift(); id && !done; id = queue.shift()) {
          // A failure is the polling's to retry and log; here it only means
          // the cap decides.
          await useFeedSeen.getState().fetchWindow(id).catch(() => {});
        }
      };
      for (let i = 0; i < INIT_FETCH_CONCURRENCY; i++) void worker();
      return () => {
        done = true;
        holdingRef.current = false;
        clearTimeout(timer);
        off();
      };
    }, [missingWindows]);

    // ── Moving ──────────────────────────────────────────────────────────────
    const focusOnMoveRef = useRef(false);
    /** `settleNow`, declared below; the walk needs it before it exists. */
    const settleNowRef = useRef<() => void>(() => {});
    const focusFocal = useCallback(() => {
      focalScroller()?.focus({ preventScroll: true });
    }, [focalScroller]);

    /** One step, now: `u` back to 0 and the step applied in the same task, so
     *  the browser paints only the state after (`queueBinding.ts`). */
    const commitStep = useCallback(
      (dir: 1 | -1) => {
        u.jump(0);
        flushSync(() => move((s) => step(s, dir)));
      },
      [u, move],
    );
    const canStep = useCallback((dir: 1 | -1, from?: 1 | -1) => {
      const s = from ? step(qRef.current, from) : qRef.current;
      return step(s, dir) !== s;
    }, []);

    // A walk is a run of `step(±1)` (§V.3: `focus` is not a model operation),
    // so every feed crossed is left unsettled — and plays as one motion, each
    // step `min(450, 600 / k)` ms (§VII.7). Re-targeted by a walk asked for
    // during it. `walk` is the render's half: set only for a walk of two or
    // more steps, it is what mounts the landing list early and keeps the
    // crossed ones unmounted.
    /** `k` is the walk's length as it was asked for — at the start, or at a
     *  re-target — so every step of one walk takes the same time. */
    const walkRef = useRef<{ target: QueueKey; k: number } | null>(null);
    const [walk, setWalk] = useState<{ target: QueueKey; origin: QueueKey } | null>(
      null,
    );
    const walkAnimRef = useRef<AnimationPlaybackControls | null>(null);
    const aliveRef = useRef(true);
    useEffect(
      () => () => {
        aliveRef.current = false;
        walkAnimRef.current?.stop();
      },
      [],
    );

    const runWalk = useCallback(async () => {
      for (;;) {
        const w = walkRef.current;
        const s = qRef.current;
        if (!w || s.focal === null || !aliveRef.current) break;
        const p = s.keys.indexOf(s.focal);
        const t = s.keys.indexOf(w.target);
        if (t < 0 || t === p) break;
        const dir = t > p ? 1 : -1;
        if (step(s, dir) === s) break;
        const controls = animate(u, dir, {
          duration: Math.min(QUEUE_MOTION_MS, 600 / w.k) / 1000,
          ease: QUEUE_EASE,
        });
        walkAnimRef.current = controls;
        await controls;
        walkAnimRef.current = null;
        if (!aliveRef.current) return;
        commitStep(dir);
      }
      walkRef.current = null;
      setWalk(null);
      busy.set(false);
      if (focusOnMoveRef.current) {
        focusOnMoveRef.current = false;
        // Focus needs the landing list live, so this walk settles now.
        settleNowRef.current();
        focusFocal();
      }
    }, [u, commitStep, busy, focusFocal]);

    const walkTo = useCallback(
      (key: QueueKey) => {
        const s = qRef.current;
        if (s.focal === null) return;
        const at = s.keys.indexOf(key);
        const p = s.keys.indexOf(s.focal);
        if (at < 0) return;
        if (walkRef.current) {
          walkRef.current.target = key;
          walkRef.current.k = Math.max(1, Math.abs(at - p));
          // A walk already holding lists moves its landing whatever the new
          // length, or the old target's list stays mounted and the real one
          // lands as a wash.
          setWalk((w) =>
            w
              ? { ...w, target: key }
              : Math.abs(at - p) > 1
                ? { target: key, origin: s.focal as QueueKey }
                : null,
          );
          return;
        }
        if (at === p) return;
        // Mid-drag: the gesture owns the queue until it settles.
        if (busy.get()) return;
        if (reduced) {
          // Instant (§VII.8): the run of steps in one move.
          move((s0) => {
            let x = s0;
            for (let guard = 0; x.focal !== null && x.focal !== key; guard++) {
              const i = x.keys.indexOf(key);
              if (i < 0 || guard > x.keys.length) break;
              const n = step(x, i > x.keys.indexOf(x.focal) ? 1 : -1);
              if (n === x) break;
              x = n;
            }
            return x;
          });
          return;
        }
        walkRef.current = { target: key, k: Math.abs(at - p) };
        if (Math.abs(at - p) > 1) setWalk({ target: key, origin: s.focal });
        busy.set(true);
        void runWalk();
      },
      [busy, reduced, move, runWalk],
    );
    const walkBy = useCallback(
      (dir: 1 | -1) => {
        const s = qRef.current;
        const from = walkRef.current?.target ?? s.focal;
        if (from === null) return;
        const next = s.keys[s.keys.indexOf(from) + dir];
        if (next !== undefined) walkTo(next);
      },
      [walkTo],
    );
    /** Ask for a sort; it runs now, or when the queue next comes to rest. */
    const sortWhenAtRest = useCallback(
      (op: (s: QueueState, facts: Facts) => QueueState) => {
        pendingSortsRef.current.push(op);
        flushSortsRef.current();
      },
      [],
    );
    // ── The mouth (§VI.5, §VII.9) ───────────────────────────────────────────
    // What a pull on the focal feed found, said in the mouth once it has
    // resolved, and in full sentences in the live region. A pull that found
    // nothing on a feed with nothing unread moves on to the first feed ahead,
    // after the line has had a moment, and the feed it lands on flashes.
    const [flash, setFlash] = useState<{ id: string; fading: boolean } | null>(null);
    const timersRef = useRef(new Set<ReturnType<typeof setTimeout>>());
    const later = useCallback((ms: number, fn: () => void) => {
      const t = setTimeout(() => {
        timersRef.current.delete(t);
        if (aliveRef.current) fn();
      }, ms);
      timersRef.current.add(t);
    }, []);
    useEffect(() => {
      const timers = timersRef.current;
      return () => timers.forEach(clearTimeout);
    }, []);
    const flashFeed = useCallback(
      (id: string) => {
        if (reduced) return;
        setFlash({ id, fading: false });
        later(FLASH_SOLID_MS, () =>
          setFlash((f) => (f?.id === id ? { id, fading: true } : f)),
        );
        later(FLASH_GONE_MS, () => setFlash((f) => (f?.id === id ? null : f)));
      },
      [reduced, later],
    );

    /** Reveal a feed's buffer and, if it brought anything, sort and say so —
     *  the same for focal and a feed ahead. Null: nothing new. */
    const revealFound = useCallback(
      (feedId: string): RefreshResult | null => {
        const o = onRevealRef.current(feedId);
        const name = shortName(feedId);
        if (o?.kind === "reloaded") {
          sortWhenAtRest((s, facts) => refreshed(s, feedId, facts));
          if (o.reason === "no-contact") {
            announce(`More than ${FEED_PAGE_SIZE} new posts in ${name}. The channel was reloaded.`);
            return { message: `${FEED_PAGE_SIZE}+ new · channel reloaded`, holdMs: MOUTH_LONG_MS };
          }
          announce(`${name} was reloaded.`);
          return { message: "Channel reloaded", holdMs: MOUTH_MS };
        }
        if (o && o.newCount > 0) {
          sortWhenAtRest((s, facts) => refreshed(s, feedId, facts));
          announce(`${o.newCount} new in ${name}.`);
          return { message: `${o.newCount} new`, holdMs: MOUTH_MS };
        }
        return null;
      },
      [shortName, announce, sortWhenAtRest],
    );

    const refreshFocal = useCallback(
      async (feedId: string): Promise<RefreshResult | void> => {
        const name = shortName(feedId);
        const found = revealFound(feedId);
        if (found) return found;
        // Nothing new. The empty pull advances only from a FINISHED feed.
        const facts = currentFacts();
        const own = facts.get(feedId);
        if (own && tier(own) < 2) {
          sortWhenAtRest((s, f) => refreshed(s, feedId, f));
          announce(`Nothing new in ${name}. ${own.unreadCount} unread below.`);
          return {
            message: `Nothing new · ${own.unreadCount} unread below`,
            holdMs: MOUTH_LONG_MS,
          };
        }
        const after = refreshedEmpty(qRef.current, feedId, facts);
        const target = after.focal;
        if (qRef.current.focal !== feedId || target === null || target === feedId) {
          sortWhenAtRest((s, f) => refreshedEmpty(s, feedId, f));
          announce(`Nothing new in ${name}, and nothing ahead.`);
          return { message: "Nothing new, and nothing ahead", holdMs: MOUTH_LONG_MS };
        }
        // Sort now, so the entries settle while the line is read; then take
        // the step, which carries the line off with the collapsing entry.
        sortWhenAtRest((s, f) => refreshed(s, feedId, f));
        const targetName = shortName(target);
        later(MOUTH_ADVANCE_MS, () => {
          // The reader has moved on, or is moving: the advance is theirs now.
          if (qRef.current.focal !== feedId || busy.get()) return;
          walkTo(target);
          flashFeed(target);
          announce(`Nothing new in ${name}. Moved to ${targetName}.`);
        });
        return {
          message: `Nothing new · over to ${targetName}`,
          holdMs: MOUTH_ADVANCE_MS + QUEUE_MOTION_MS,
        };
      },
      [
        shortName,
        revealFound,
        announce,
        sortWhenAtRest,
        currentFacts,
        later,
        busy,
        walkTo,
        flashFeed,
      ],
    );

    // ── A pull on a feed AHEAD (the operator, 2026-09-26) ───────────────────
    // A compact entry's preview list pulls like focal's: its buffer shown, a
    // fresh read poked, and what it found said in its own mouth. What it never
    // does is ADVANCE — the reader is not in that feed, so there is nothing to
    // move on from — and a pull that found nothing sorts nothing either.
    const refreshAhead = useCallback(
      async (feedId: string): Promise<RefreshResult | void> => {
        const found = revealFound(feedId);
        if (found) return found;
        announce(`Nothing new in ${shortName(feedId)}.`);
        return { message: "Nothing new", holdMs: MOUTH_MS };
      },
      [shortName, announce, revealFound],
    );

    // ── The edge pull (the operator, 2026-09-26) ────────────────────────────
    // Every buffer shown, then a fresh sort with focal at the head — the
    // queue ranked again. The strip at the left edge says what it found, as a
    // feed's mouth does (§VII.9), and goes.
    const [edgeLine, setEdgeLine] = useState<string | null>(null);
    const refreshEverything = useCallback(() => {
      const outcomes = [...onRevealAllRef.current().values()];
      const withNew = outcomes.filter((o) => (o?.newCount ?? 0) > 0);
      const total = withNew.reduce((n, o) => n + (o?.newCount ?? 0), 0);
      sortWhenAtRest((_, facts) => init(facts));
      const feeds = `${withNew.length} ${withNew.length === 1 ? "channel" : "channels"}`;
      announce(
        total === 0
          ? "Nothing new in any channel. The queue is sorted again."
          : `${total} new across ${feeds}. The queue is sorted again.`,
      );
      setEdgeLine(total === 0 ? "Nothing new" : `${total} new · ${feeds}`);
      if (reduced) edge.jump(EDGE_LINE_AT);
      else void animate(edge, EDGE_LINE_AT, { duration: 0.15, ease: QUEUE_EASE });
      later(MOUTH_MS, () => {
        // A pull begun meanwhile owns the strip.
        if (edge.get() !== EDGE_LINE_AT) return setEdgeLine(null);
        if (reduced) {
          edge.jump(0);
          setEdgeLine(null);
          return;
        }
        void animate(edge, 0, { duration: 0.2, ease: QUEUE_EASE }).then(() =>
          setEdgeLine(null),
        );
      });
    }, [sortWhenAtRest, announce, later, reduced, edge]);
    const edgeStripRef = useRef<HTMLDivElement>(null);
    const rowRef = useRef<HTMLDivElement>(null);
    // Bound by hand, synchronously, like every moving style here
    // (`queueBinding.ts`): the strip opens and the row moves over for it.
    useLayoutEffect(() => {
      const apply = (v: number) => {
        const w = v * EDGE_STRIP_W;
        const strip = edgeStripRef.current;
        if (strip) {
          strip.style.width = `${w}px`;
          strip.style.opacity = String(Math.min(1, v * 1.5));
        }
        if (rowRef.current)
          rowRef.current.style.transform = w > 0 ? `translateX(${w}px)` : "";
      };
      apply(edge.get());
      return edge.on("change", apply);
    }, [edge]);

    useImperativeHandle(
      ref,
      () => ({ walkTo }),
      [walkTo],
    );

    // Defined with the rest of *What waits for rest*, below.
    const landOnRef = useRef<((dir: 0 | 1 | -1) => void) | null>(null);
    useQueueGesture(rootRef, {
      u,
      edge,
      onEdgePull: refreshEverything,
      D: QUEUE_STEP_RATIO * geom.focalW,
      reduced,
      canStep,
      commit: commitStep,
      onLanding: (dir) => landOnRef.current?.(dir),
      locked: () => walkRef.current !== null || !sortedRef.current,
      onStart: () => {
        focalPullRef.current?.cancel();
      },
      onBusy: (b) => busy.set(b),
    });

    // ── What waits for rest ────────────────────────────────────────────────
    // Three things follow focal only once the queue has stopped moving,
    // because none is needed in motion and the first two are expensive:
    //
    //   · WHICH LISTS ARE MOUNTED (`listKeys`). At rest, focal and both
    //     neighbours (§VII.3). A step always brings one list the queue did not
    //     hold — the new neighbour — and mounting a card tree is the costliest
    //     thing a commit could do. The new focal never waits (it was a
    //     neighbour, so its list is here); the old lists stay until then too,
    //     rather than being torn down inside the motion.
    //   · WHICH LIST IS LIVE, not `inert` (`restFocal`). Toggling `inert`
    //     restyles the whole subtree — measured ~21ms for one twenty-card
    //     list in headless Chromium, and a commit toggles four — so at the
    //     commit, a motion's last frame, it would stall the motion. Nobody
    //     tabs into or clicks a list mid-swipe, and what a list SHOWS is the
    //     gesture's opacity either way.
    //   · THE MUSTER'S ROUNDEL (`onFocalChange`, into `stores/queueFocal.ts`).
    //     Cheap since focal left the host, whose re-render was the whole
    //     workspace; it waits with the rest so a walk does not strobe it.
    //
    // They run together, synchronously, in an IDLE callback that gives up if
    // a gesture has begun (and is asked again when it settles). Synchronously
    // and not as a transition: a transition's commit lands whenever its render
    // finishes, which measured as 130–170ms frames in the middle of the NEXT
    // swipe. Idle and synchronous, the worst case is a swipe that starts a
    // little late, never one that stutters.
    //
    // ONE EXCEPTION: THE FEED LANDED ON (operator, 2026-09-26). A feed reached
    // by a walk or a long swipe arrives as a wash with no list, and waiting for
    // idle — up to its timeout, then the mount — left its preview rows sitting
    // in the full-width clip long enough to read as a delay before the cards
    // snapped to fit. So its list alone is added on the first frame after
    // rest (`landNow`); the neighbours, `inert` and the host still wait.
    // And EARLIER STILL, once the gesture knows where it lands (`landOn`, the
    // trackpad pass 2026-10-01, g3): as the quiet decides the settle, before
    // it plays, or as momentum's cap spends a swipe whose tail is still
    // arriving. Synchronously, so the mount is paid before the settle's first
    // frame rather than inside it.
    const onFocalChangeRef = useRef(onFocalChange);
    onFocalChangeRef.current = onFocalChange;
    const toldRef = useRef<QueueKey | null | undefined>(undefined);
    const [listKeys, setListKeys] = useState(() => neighbours(q));
    const [restFocal, setRestFocal] = useState(q.focal);
    const settleNow = useCallback(() => {
      if (busy.get() || !aliveRef.current) return;
      const s = qRef.current;
      const next = neighbours(s);
      flushSync(() => {
        setRestFocal(s.focal);
        setListKeys((cur) =>
          cur.size === next.size && [...next].every((k) => cur.has(k)) ? cur : next,
        );
        if (s.focal !== toldRef.current) {
          toldRef.current = s.focal;
          onFocalChangeRef.current(s.focal);
        }
      });
    }, [busy]);
    const landRef = useRef(0);
    const landNow = useCallback(() => {
      if (landRef.current || busy.get()) return;
      landRef.current = requestAnimationFrame(() => {
        landRef.current = 0;
        const f = qRef.current.focal;
        if (f === null || busy.get() || !aliveRef.current) return;
        setListKeys((cur) => (cur.has(f) ? cur : new Set([...cur, f])));
      });
    }, [busy]);
    useEffect(() => () => cancelAnimationFrame(landRef.current), []);
    const landOn = useCallback((dir: 0 | 1 | -1) => {
      if (!aliveRef.current) return;
      const s = qRef.current;
      const f = (dir === 0 ? s : step(s, dir)).focal;
      if (f === null) return;
      flushSync(() =>
        setListKeys((cur) => (cur.has(f) ? cur : new Set([...cur, f]))),
      );
    }, []);
    landOnRef.current = landOn;
    const idleRef = useRef<(() => void) | null>(null);
    const settleWhenIdle = useCallback(() => {
      if (busy.get()) return;
      landNow();
      if (idleRef.current) return;
      const run = () => {
        idleRef.current = null;
        settleNow();
      };
      if (typeof window.requestIdleCallback === "function") {
        const id = window.requestIdleCallback(run, { timeout: 300 });
        idleRef.current = () => window.cancelIdleCallback(id);
      } else {
        // Safari has no idle callback.
        const id = window.setTimeout(run, 60);
        idleRef.current = () => window.clearTimeout(id);
      }
    }, [busy, settleNow, landNow]);
    useEffect(() => {
      settleWhenIdle();
    }, [q, walk, settleWhenIdle]);
    useEffect(
      () =>
        busy.subscribe(() => {
          if (!busy.get()) settleWhenIdle();
        }),
      [busy, settleWhenIdle],
    );
    useEffect(() => () => idleRef.current?.(), []);
    settleNowRef.current = settleNow;

    useEffect(() => {
      function onKey(e: KeyboardEvent) {
        const k = e.key;
        if (k !== "ArrowLeft" && k !== "ArrowRight" && k !== "Home" && k !== "End")
          return;
        // Guarded like every global binding in the workspace (§VI.4).
        if (e.metaKey || e.ctrlKey || e.altKey || e.shiftKey) return;
        const t = e.target as HTMLElement | null;
        if (
          t?.closest(
            'input, textarea, select, [contenteditable=""], [contenteditable="true"], [role="menu"]',
          )
        )
          return;
        if (useExplain.getState().isActive) return;
        if (useGlasshousePresence.getState().isOpen) return;
        if (useEditorOverlay.getState().isOpen) return;
        if (useLightbox.getState().isOpen) return;
        const s = qRef.current;
        if (s.focal === null || !sortedRef.current) return;
        // Not mid-drag (§VI.4); during a walk, a key re-targets it.
        if (busy.get() && !walkRef.current) return;
        e.preventDefault();
        focusOnMoveRef.current = true;
        if (k === "ArrowLeft") walkBy(-1);
        else if (k === "ArrowRight") walkBy(1);
        else if (k === "Home") walkTo(s.keys[0]);
        else walkTo(s.keys[s.keys.length - 1]);
      }
      window.addEventListener("keydown", onKey);
      return () => window.removeEventListener("keydown", onKey);
    }, [walkTo, walkBy, busy]);

    // ── Re-sorts slide (§VII.8) ─────────────────────────────────────────────
    // A hand FLIP on each entry's left edge, never Framer's `layout`, which
    // animates a width change as a transform — the clip's width is the one
    // thing a step animates, and the two would fight. It runs only where the
    // ORDER changed and focal did not: a sort (an arrival, a refresh) or a
    // restore. A step changes places by width,
    // bound to the gesture, and must not slide as well. Where an entry rests
    // is a function of its index and focal's (`restLeft`), so both edges are
    // computed rather than measured. A drag starting mid-slide cuts it short.
    const prevOrderRef = useRef({ keys: q.keys, focal: q.focal });
    const slidesRef = useRef<Animation[]>([]);
    useLayoutEffect(() => {
      const prev = prevOrderRef.current;
      prevOrderRef.current = { keys: q.keys, focal: q.focal };
      if (reduced || prev.focal !== q.focal || prev.keys === q.keys) return;
      if (prev.keys.length === q.keys.length && prev.keys.every((k, i) => k === q.keys[i]))
        return;
      const root = rootRef.current;
      if (!root || typeof Element.prototype.animate !== "function") return;
      const before = new Map(prev.keys.map((k, i) => [k, restLeft(i, prev.keys, prev.focal, geom)]));
      slidesRef.current.forEach((a) => a.cancel());
      slidesRef.current = [];
      q.keys.forEach((k, i) => {
        const from = before.get(k);
        if (from === undefined) return;
        const dx = from - restLeft(i, q.keys, q.focal, geom);
        if (Math.abs(dx) < 1) return;
        const el = root.querySelector<HTMLElement>(`[data-queue-key="${CSS.escape(k)}"]`);
        if (!el) return;
        slidesRef.current.push(
          el.animate(
            [{ transform: `translateX(${dx}px)` }, { transform: "translateX(0)" }],
            { duration: QUEUE_MOTION_MS, easing: `cubic-bezier(${QUEUE_EASE.join(",")})` },
          ),
        );
      });
    }, [q.keys, q.focal, geom, reduced]);
    useEffect(
      () =>
        busy.subscribe(() => {
          if (!busy.get()) return;
          slidesRef.current.forEach((a) => a.finish());
          slidesRef.current = [];
        }),
      [busy],
    );

    // Focus follows a KEYBOARD move, without scrolling; a pointer move leaves
    // it where it was (§VI.7). An animated walk hands focus over where it
    // lands (`runWalk`); this is the instant one's, and a hide's or a
    // restore's. The new focal's list is `inert` until the settle marks it
    // live, and a settle asked for inside an effect is not applied in it
    // (React defers a `flushSync` made during its own commit) — so the focus
    // is held until `restFocal` says the list is live, or it lands on
    // nothing and falls to the body.
    const focusPendingRef = useRef(false);
    useEffect(() => {
      if (focusOnMoveRef.current && !walkRef.current) {
        focusOnMoveRef.current = false;
        focusPendingRef.current = true;
        settleNowRef.current();
      }
      if (!focusPendingRef.current || walkRef.current || restFocal !== q.focal) return;
      focusPendingRef.current = false;
      focusFocal();
    }, [q.focal, restFocal, focusFocal]);

    // A hide or restore started from inside the queue unmounts the control
    // that had focus (the focal bar's ×, a hidden feed's bar), so focus
    // follows the reader to where the queue lands, as a keyboard move does.
    // A pointer anywhere in the queue first takes that hand-over back, so a
    // refused toggle cannot leave it armed for some later move.
    const keepFocusAcross = useCallback(() => {
      if (rootRef.current?.contains(document.activeElement))
        focusOnMoveRef.current = true;
    }, []);

    // A window resize rewraps every card in the focal list (§VII.1), so its
    // anchor is taken before the new geometry commits and put back after.
    // Before means DURING THE RENDER that carries the new geometry (below):
    // the page can re-render for a new viewport before the window's `resize`
    // event is dispatched, so a capture hung on that event reads a list that
    // has already rewrapped (seen driving it).
    const geomSeenRef = useRef(geom);
    useLayoutEffect(() => {
      if (geomSeenRef.current === geom) return;
      geomSeenRef.current = geom;
      const focal = qRef.current.focal;
      if (focal === null || !fullRef.current.has(focal)) return;
      const scroller = focalScroller();
      if (scroller) restoreFull(focal, scroller);
    }, [geom, restoreFull, focalScroller]);

    // A feed's rendered card tree is REUSED across QueueView's own renders —
    // a step, a walk, a settle — because those change places, never data:
    // the same element object lets React skip every card beneath it, which
    // is what keeps a commit to a frame. Any change to a feed's data renders
    // the host, whose render functions are then new, so the cache misses.
    const renderCacheRef = useRef(
      new Map<string, { fn: (id: string) => ReactNode; node: ReactNode }>(),
    );
    const cachedRender = (
      kind: "full" | "preview",
      fn: (id: string) => ReactNode,
      id: string,
    ) => {
      const k = `${kind}:${id}`;
      const hit = renderCacheRef.current.get(k);
      if (hit && hit.fn === fn) return hit.node;
      const node = fn(id);
      renderCacheRef.current.set(k, { fn, node });
      return node;
    };
    // A feed that is gone (deleted, merged away) takes its card trees with it.
    useEffect(() => {
      const cache = renderCacheRef.current;
      const live = new Set(feeds.map((f) => f.id));
      for (const k of cache.keys())
        if (!live.has(k.slice(k.indexOf(":") + 1))) cache.delete(k);
    }, [feeds]);

    // The resize anchor's capture (see above): the DOM still holds the last
    // commit here, and `fullRef` still names its lists. Idempotent, so a
    // render React repeats reads the same page.
    if (geomSeenRef.current !== geom && !busy.get()) captureFocal();

    const byId = useMemo(() => new Map(feeds.map((f) => [f.id, f])), [feeds]);
    const hiddenFeeds = feeds.filter((f) => f.hidden);
    const p = q.focal === null ? -1 : q.keys.indexOf(q.focal);
    const restAt = restFocal === null ? -1 : q.keys.indexOf(restFocal);
    const restP = restAt < 0 ? p : restAt;
    const full = new Set<QueueKey>();
    fullRef.current = full;

    return (
      <QueueMotionContext.Provider value={u}>
        <div
          ref={rootRef}
          role="region"
          aria-label="Channels"
          // Explain (B9): the floor's sentence is untrue here — the queue
          // sorts itself — so the queue answers for the ground under it.
          data-explain="queue"
          onPointerDownCapture={() => {
            focusOnMoveRef.current = false;
            focusPendingRef.current = false;
          }}
          style={{
            position: "relative",
            height: "100%",
            // No sideways scroll: entries past the right edge are CLIPPED, and
            // the far end is reached by moving through the queue (§VI.1).
            overflow: "clip",
          }}
        >
          {/* The edge pull's strip (see *The edge pull*): the feed pull's
              indicator turned on its side. Its width and the row's shift are
              bound to `edge`; the live region says what it found. */}
          <div
            ref={edgeStripRef}
            aria-hidden
            style={{
              position: "absolute",
              left: 0,
              top: 0,
              bottom: 0,
              width: 0,
              opacity: 0,
              overflow: "hidden",
              display: "flex",
              alignItems: "center",
              justifyContent: "center",
              pointerEvents: "none",
            }}
          >
            <span
              className={`label-ui ${edgeLine ? "text-grey-600" : "text-grey-400"}`}
              style={{ writingMode: "vertical-rl", whiteSpace: "nowrap" }}
            >
              {edgeLine ?? "Pull to refresh all channels"}
            </span>
          </div>
          <div
            ref={rowRef}
            style={{
              display: "flex",
              alignItems: "flex-start",
              gap: geom.gap,
              padding: `${GRID}px 0 0 ${GRID}px`,
              height: "100%",
            }}
          >
            {!sorted ? (
            <p className="label-ui text-grey-400" style={{ padding: GRID * 2 }}>
              Loading…
            </p>
          ) : q.keys.map((key, i) => {
              const state = i < p ? "line" : i === p ? "focal" : "compact";
              const d = i - p;
              const f = byId.get(key);
              if (!f) return null;
              const label = queueFeedName(f.numeral, f.name);
              const focal = state === "focal";
              // At rest, focal and both neighbours hold their lists (§VII.3), as
              // `listKeys` says. A walk of several steps holds only where it
              // started and where it will land; the feeds between pass through
              // as washes (§VII.7). So does a swipe that flips past more than one
              // feed: mid-gesture, focal is full only if its list was already
              // held at the last rest (a neighbour), and a feed further on stays
              // a wash until the swipe lets go and it is landed on.
              const isFull = walk
                ? key === walk.target || key === walk.origin
                : (focal && !busy.get()) || listKeys.has(key);
              if (isFull) full.add(key);
              // A wash keeps its preview rows through focal (queueMotion.ts).
              const m = entryMotion(d, geom, isFull);
              // Whatever can move in a step has a clip over a chassis — a bare
              // line cannot widen.
              const hasChassis = isFull || Math.abs(d) <= 1 || state === "compact";
              // Where a compact entry's left edge falls: the lines, focal, then
              // the compact entries before it.
              // Measured from where focal RESTS, so the entry a step brings
              // into the window (still off-screen by the slack) mounts its rows
              // with the settle, not inside the commit.
              const left =
                geom.gap +
                restP * (geom.lineW + geom.gap) +
                (geom.focalW + geom.gap) +
                (i - restP - 1) * (geom.compactW + geom.gap);
              const previewLayer =
                // Focal's own, held until rest when it leaves (a teardown of
                // twenty rows inside the commit is a stall too).
                focal ||
                key === restFocal ||
                // A wash just behind focal: a step back widens it with its
                // rows showing, so they must be there before it does.
                (d === -1 && !isFull) ||
                (state === "compact" && left < vp.w + geom.focalW) ? (
                  <PreviewLayer
                    shown={key !== restFocal}
                    opacityAt={m.preview}
                    width={geom.compactW - 2 * VESSEL_WALL}
                    anchor={previewAnchor(f.id)}
                    onRefresh={
                      key !== restFocal ? () => refreshAhead(f.id) : undefined
                    }
                    messageColor={f.palette.cardMeta}
                  >
                    {cachedRender("preview", renderPreview, f.id)}
                  </PreviewLayer>
                ) : undefined;
              return (
                <QueueEntry
                  key={key}
                  state={state}
                  geom={geom}
                  palette={f.palette}
                  label={label}
                  // A line shows nothing but its colour, so its hover always says
                  // which feed it is; a compact entry shows its numeral, so only a
                  // name adds anything.
                  hoverName={state === "line" ? f.name || label : f.name || undefined}
                  feedId={f.id}
                  onWalk={() => walkTo(key)}
                  widthAt={m.width}
                  reduced={reduced}
                  chassisInert={state === "line" && key !== restFocal}
                  explain={{
                    order: f.numeral,
                    fromStarter: f.fromStarter,
                    feedName: f.name || null,
                  }}
                >
                  {hasChassis ? (
                    // One element whatever the state, so a step turns a neighbour
                    // into focal (and back) without remounting its chassis — only
                    // the props below change with the state.
                    <GatedChassis
                      busy={busy}
                      feedId={f.id}
                      numeral={f.numeral}
                      descriptiveName={focal ? f.name || undefined : undefined}
                      palette={f.palette}
                      horizontal={false}
                      contents={isFull ? "full" : "compact"}
                      engaged={focal && isFull && !attentionElsewhere}
                      onDwell={focal ? () => setQ((s) => settle(s, f.id)) : undefined}
                      countsSeen={isFull}
                      // Passing starts at rest (see *What waits for rest*): a
                      // list cannot be read down until the swipe has ended.
                      tracking={focal && key === restFocal}
                      listHidden={key !== restFocal}
                      restoreScroll={(el) => restoreFull(f.id, el)}
                      tailSpacer={isFull && f.hasItems}
                      tailNote={focal ? f.tailNote : undefined}
                      height={geom.entryH}
                      scrolls
                      bodyFills
                      scrollTabIndex={focal ? 0 : -1}
                      scrollLabel={focal ? label : undefined}
                      pullRef={focal ? focalPullRef : undefined}
                      listOpacityAt={m.list}
                      barOpacityAt={m.bar}
                      onNameClick={() => onNameClick(f.id)}
                      onSourceAdded={() => onSourceAdded(f.id)}
                      onHide={() => {
                        keepFocusAcross();
                        onHide(f.id);
                      }}
                      onRefresh={isFull ? () => refreshFocal(f.id) : undefined}
                      onLoadMore={focal && isFull ? onLoadMore : undefined}
                      outline={
                        flash?.id === key
                          ? `4px solid ${flash.fading ? "transparent" : f.palette.crimson}`
                          : undefined
                      }
                      outlineTransition={
                        flash?.id === key
                          ? `outline-color ${FLASH_GONE_MS - FLASH_SOLID_MS}ms ease-out`
                          : undefined
                      }
                      caughtUp={focal ? f.caughtUp : undefined}
                      onCaughtUpDismiss={
                        focal ? () => onCaughtUpDismiss(f.id) : undefined
                      }
                      // The compact bar stays on a wash in every state, so a
                      // feed a swipe passes through does not swap bars at each
                      // step; the focal bar arrives with the list, at rest.
                      bar={
                        state === "compact" || !isFull ? (
                          <QueueBar
                            palette={f.palette}
                            label={label}
                            width={geom.compactW - 2 * VESSEL_WALL}
                            widthAt={(v) => Math.max(0, m.width(v) - 2 * VESSEL_WALL)}
                            feedId={f.id}
                            onWalk={() => walkTo(key)}
                          />
                        ) : undefined
                      }
                      previewLayer={previewLayer}
                    >
                      {isFull ? cachedRender("full", renderContents, f.id) : null}
                    </GatedChassis>
                  ) : null}
                </QueueEntry>
              );
            })}
            {/* After the last entry and outside the keys, so no walk reaches
                them (§VII.4 as amended 2026-09-26). */}
            {sorted && (
              <HiddenBars
                hidden={hiddenFeeds}
                height={geom.entryH}
                palette={hiddenPalette}
                onRestore={(id) => {
                  keepFocusAcross();
                  onRestore(id);
                }}
              />
            )}
          </div>
          {/* The queue's own voice (§VI.7): see *The live region*. */}
          <div key={announcement.n} aria-live="polite" className="sr-only">
            {announcement.text}
          </div>
        </div>
      </QueueMotionContext.Provider>
    );
  },
);
