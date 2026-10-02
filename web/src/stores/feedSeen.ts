import { useMemo } from "react";
import { create } from "zustand";
import { workspaceFeeds, type FeedSeenWindow } from "../lib/api";

// =============================================================================
// useFeedSeen — the reading counts' client half (WORKSPACE-QUEUE-ADR §IV.5).
// Two records per feed, and they are different kinds of thing:
//
//   windows — the feed's WINDOW, exactly as the server last sent it (a `GET` or
//             `POST …/seen`). In memory only: the server re-derives it on every
//             fetch, so there is nothing here worth keeping. It is ADOPTED
//             wholesale and never edited — in particular no flag is ever
//             cleared locally, because the items carry no `created_at` and only
//             the server knows which arrivals a new baseline covers (§IV.4).
//   passed  — the posts THIS DEVICE has watched scroll past, `post_id →
//             publishedAt`. Persisted, one localStorage key per feed, so a
//             scroll that passes cards rewrites only the feed being scrolled.
//
// unread = window − passed; new = (window ∩ isNew) − passed. Both are DERIVED
// (`feedSeenCounts`), never stored, and a feed with no window yet has no counts
// at all — `null`, never 0, which would be a claim.
//
// "Passed" is exposure, not attention: nothing here touches the reading log
// (§IV.6), and no later slice may merge the two.
//
// Name: `feedArrivals` is taken (feeds minted outside WorkspaceView), so every
// identifier in this ADR's Phase A is `feedSeen*` (§III).
// =============================================================================

/** The passed set's key — one per (member, feed). */
const KEY_PREFIX = "workspace:passed:v1:";
const userPrefix = (userId: string) => `${KEY_PREFIX}${userId}:`;
const storageKey = (userId: string, feedId: string) =>
  `${userPrefix(userId)}${feedId}`;

const WRITE_DEBOUNCE_MS = 200;
/** Safety cap per feed; the oldest `publishedAt` goes first. The floor prunes
 *  long before this in any real feed — the window itself is capped at 500. */
export const PASSED_CAP = 3000;
/** What a feed's set is cut to when the browser refuses the write for space. */
export const PASSED_QUOTA_CAP = 1000;

export type PassedSet = Record<string, number>;

/** What one key holds. `floor` is the newest `windowStart` the server has sent
 *  for the feed, in unix seconds, kept beside the set so a HYDRATE can prune
 *  at the floor before any window has arrived this session. It is the
 *  server's value carried forward, never the client's clock (§IV.1). */
interface Persisted {
  floor: number | null;
  passed: PassedSet;
}

// -----------------------------------------------------------------------------
// The `asOf` token, compared without a Date.
//
// It is Postgres `timestamptz::text` — `2026-09-22 18:51:54.123456+00` — and the
// baseline write must be sent the NEWEST one the client holds for a feed
// (§IV.4). A JS `Date` would truncate it to milliseconds (root Invariants › a
// position in a timeline keeps Postgres's precision), and the text does not
// sort as a string, because Postgres trims trailing zeros from the fraction and
// the offset follows the session's TimeZone. So it is taken apart: whole
// seconds via Date.parse (exact at second precision), microseconds from the
// digits, as one BigInt.
// -----------------------------------------------------------------------------

const PG_TS_RE =
  /^(\d{4}-\d{2}-\d{2})[ T](\d{2}:\d{2}:\d{2})(?:\.(\d{1,6}))?(Z|[+-]\d{2}(?::?\d{2})?)$/;

/** Microseconds since the epoch, or null for a string that is not a
 *  Postgres timestamptz rendering. Exported for the tests. */
export function asOfMicros(ts: string): bigint | null {
  const m = PG_TS_RE.exec(ts);
  if (!m) return null;
  const [, date, time, frac = "", rawOffset] = m;
  let offset = rawOffset;
  if (offset !== "Z") {
    const digits = offset.slice(1).replace(":", "");
    offset = `${offset[0]}${digits.slice(0, 2)}:${digits.slice(2, 4) || "00"}`;
  }
  const ms = Date.parse(`${date}T${time}${offset}`);
  if (Number.isNaN(ms)) return null;
  return BigInt(ms / 1000) * 1_000_000n + BigInt(frac.padEnd(6, "0"));
}

/** Unix seconds of a server timestamp, rounded DOWN — used for the floor, where
 *  rounding down keeps an entry a second longer rather than dropping one the
 *  window still lists. */
function floorSeconds(ts: string): number | null {
  const us = asOfMicros(ts);
  return us === null ? null : Number(us / 1_000_000n);
}

// -----------------------------------------------------------------------------
// The passed set's own arithmetic. Pure; every caller passes and gets back a
// fresh record, so a union can never alias another tab's copy.
// -----------------------------------------------------------------------------

/** Monotone: nothing in either argument is lost. This is what makes two tabs
 *  writing the same key safe — neither can remove the other's passes. */
function union(a: PassedSet, b: PassedSet): PassedSet {
  return { ...a, ...b };
}

/** Drop what is below the floor (it can never be counted again), then, past
 *  `cap`, the oldest by `publishedAt`. Returns the SAME object when nothing was
 *  dropped, so an unchanged set writes and renders nothing. */
function prune(set: PassedSet, floor: number | null, cap: number): PassedSet {
  let entries = Object.entries(set);
  const before = entries.length;
  if (floor !== null) entries = entries.filter(([, at]) => at >= floor);
  if (entries.length > cap) {
    entries.sort((x, y) => y[1] - x[1]);
    entries = entries.slice(0, cap);
  }
  return entries.length === before ? set : Object.fromEntries(entries);
}

function maxFloor(a: number | null, b: number | null): number | null {
  if (a === null) return b;
  if (b === null) return a;
  return Math.max(a, b);
}

/** Defensive parse: a malformed value (hand-edited, or a later build's shape)
 *  degrades to an empty set, never a throw on the render path. */
function parsePersisted(raw: string | null): Persisted {
  const empty: Persisted = { floor: null, passed: {} };
  if (!raw) return empty;
  try {
    const v = JSON.parse(raw) as { floor?: unknown; passed?: unknown };
    if (!v || typeof v !== "object") return empty;
    const passed: PassedSet = {};
    if (v.passed && typeof v.passed === "object") {
      for (const [id, at] of Object.entries(v.passed as Record<string, unknown>))
        if (typeof at === "number" && Number.isFinite(at)) passed[id] = at;
    }
    const floor =
      typeof v.floor === "number" && Number.isFinite(v.floor) ? v.floor : null;
    return { floor, passed };
  } catch {
    return empty;
  }
}

// -----------------------------------------------------------------------------
// Storage. Every access is wrapped: the set is a convenience, and losing it
// must never break the workspace (§IV.5).
// -----------------------------------------------------------------------------

function storage(): Storage | null {
  if (typeof window === "undefined") return null;
  try {
    return window.localStorage;
  } catch {
    return null;
  }
}

function readKey(key: string): Persisted {
  const ls = storage();
  if (!ls) return { floor: null, passed: {} };
  try {
    return parsePersisted(ls.getItem(key));
  } catch {
    return { floor: null, passed: {} };
  }
}

/** Every key of this member's, by prefix. */
function ownKeys(userId: string): string[] {
  const ls = storage();
  if (!ls) return [];
  const prefix = userPrefix(userId);
  const out: string[] = [];
  try {
    for (let i = 0; i < ls.length; i++) {
      const k = ls.key(i);
      if (k && k.startsWith(prefix)) out.push(k);
    }
  } catch {
    return [];
  }
  return out;
}

function isQuotaError(err: unknown): boolean {
  if (!err || typeof err !== "object") return false;
  const e = err as { name?: string; code?: number };
  return (
    e.name === "QuotaExceededError" ||
    e.name === "NS_ERROR_DOM_QUOTA_REACHED" ||
    e.code === 22 ||
    e.code === 1014
  );
}

/** Write one feed's key. Returns the set that was actually written (it may
 *  have been cut for quota), or null when nothing could be. */
function writeKey(key: string, value: Persisted): PassedSet | null {
  const ls = storage();
  if (!ls) return null;
  try {
    ls.setItem(key, JSON.stringify(value));
    return value.passed;
  } catch (err) {
    if (!isQuotaError(err)) return null;
  }
  // §IV.5: on quota, cut the feed's set to the newest 1,000 and retry once;
  // if that fails too, drop the write silently.
  const cut = prune(value.passed, value.floor, PASSED_QUOTA_CAP);
  try {
    ls.setItem(key, JSON.stringify({ floor: value.floor, passed: cut }));
    return cut;
  } catch {
    return null;
  }
}

// -----------------------------------------------------------------------------
// The store
// -----------------------------------------------------------------------------

export interface FeedSeenCounts {
  unread: number;
  new: number;
  /** The window hit the server's cap: the unread figure is a floor, not a
   *  total (the pill reads `500+`, §IV.8). */
  truncated: boolean;
  /** Truncated AND every kept post is an arrival, so the new figure is a
   *  floor too. */
  newTruncated: boolean;
}

interface FeedSeenState {
  userId: string | null;
  windows: Record<string, FeedSeenWindow>;
  /** The newest `asOf` held for each feed, from a window OR an items page —
   *  the one a look sends (§IV.4). */
  latestAsOf: Record<string, string>;
  passed: Record<string, PassedSet>;
  /** Per feed, the newest floor (unix seconds) the server has sent. */
  floors: Record<string, number>;

  /** Load every passed set of this member's, pruned. Hydrating a different
   *  identity drops the previous one's memory and pending writes. */
  hydrate: (userId: string) => void;

  /** Adopt a window the server sent. First contact (`seenBaselineAt: null`)
   *  answers with a `POST …/seen` at that window's own `asOf` and marks
   *  nothing passed (§IV.5). */
  adoptWindow: (feedId: string, window: FeedSeenWindow) => void;
  /** Record an `asOf` seen elsewhere (an items page), if it is newer. */
  noteAsOf: (feedId: string, asOf: string) => void;

  /** The poll: `GET …/seen`, adopted. Rejects on failure — backoff is the
   *  poller's (§IV.9). */
  fetchWindow: (feedId: string) => Promise<void>;
  /** A look: `POST …/seen` with the given `asOf`, or the newest held; the
   *  response replaces the window. A failure leaves the old baseline, which
   *  errs toward showing more as new (§IV.4). Resolves false when there was
   *  no `asOf` to send or the call failed. */
  markSeen: (feedId: string, asOf?: string) => Promise<boolean>;

  /** A card left the top of its scroller after being seen (§IV.7).
   *  `publishedAt` is required only for a post the window does not list. */
  markPassed: (feedId: string, postId: string, publishedAt?: number) => void;

  /** Forget every feed not in the live set, memory and storage alike. */
  reconcileFeeds: (liveIds: string[]) => void;
}

// ---- writes, debounced per feed ---------------------------------------------

const writeTimers = new Map<string, ReturnType<typeof setTimeout>>();
/** Feeds with a write pending, per the userId they belong to. */
const dirty = new Set<string>();
let dirtyUser: string | null = null;

/** First contact in flight, so a poll landing mid-call does not send a second. */
const firstContact = new Set<string>();

// The module-scope listeners' targets, assigned inside the store's initialiser, which runs at `create` — before any
// listener below can fire.
let flushAll: () => void = () => {};
let onStorage: (key: string | null, newValue: string | null) => void = () => {};

export const useFeedSeen = create<FeedSeenState>((set, get) => {
  /** Union the key's current contents into memory, prune, write, and adopt
   *  what was written. Union-before-write is the two-tab rule (§IV.5). */
  function flushFeed(feedId: string) {
    const t = writeTimers.get(feedId);
    if (t) {
      clearTimeout(t);
      writeTimers.delete(feedId);
    }
    if (!dirty.delete(feedId)) return;
    const userId = get().userId;
    if (!userId || userId !== dirtyUser) return;
    const key = storageKey(userId, feedId);
    const onDisk = readKey(key);
    const floor = maxFloor(onDisk.floor, get().floors[feedId] ?? null);
    const merged = prune(
      union(onDisk.passed, get().passed[feedId] ?? {}),
      floor,
      PASSED_CAP,
    );
    const written = writeKey(key, { floor, passed: merged });
    // Memory takes the union too (another tab's passes arrive here even when
    // no storage event did), or the quota cut when there was one. A failed
    // write keeps the in-memory union: the counts should still reflect it.
    const next = written ?? merged;
    set((s) => ({
      passed: { ...s.passed, [feedId]: next },
      floors: floor === null ? s.floors : { ...s.floors, [feedId]: floor },
    }));
  }

  function scheduleWrite(feedId: string) {
    const userId = get().userId;
    if (!userId || !storage()) return;
    dirty.add(feedId);
    dirtyUser = userId;
    const t = writeTimers.get(feedId);
    if (t) clearTimeout(t);
    writeTimers.set(
      feedId,
      setTimeout(() => flushFeed(feedId), WRITE_DEBOUNCE_MS),
    );
  }

  flushAll = () => {
    for (const feedId of [...dirty]) flushFeed(feedId);
  };

  onStorage = (key, newValue) => {
    const userId = get().userId;
    if (!userId || !key || !key.startsWith(userPrefix(userId))) return;
    const feedId = key.slice(userPrefix(userId).length);
    // A removal elsewhere (reconcile in another tab) is not a fact about our
    // passes; union ignores it by construction.
    if (newValue === null) return;
    const incoming = parsePersisted(newValue);
    const floor = maxFloor(incoming.floor, get().floors[feedId] ?? null);
    const merged = prune(
      union(get().passed[feedId] ?? {}, incoming.passed),
      floor,
      PASSED_CAP,
    );
    set((s) => ({
      passed: { ...s.passed, [feedId]: merged },
      floors: floor === null ? s.floors : { ...s.floors, [feedId]: floor },
    }));
  };

  function noteAsOfIn(
    latest: Record<string, string>,
    feedId: string,
    asOf: string,
  ): Record<string, string> {
    const incoming = asOfMicros(asOf);
    // Our own server's token failing to parse is a fault of ours, not an
    // absence: say so, and keep the one we trust.
    if (incoming === null) {
      console.warn("feedSeen: unparseable asOf from the server", asOf);
      return latest;
    }
    const held = latest[feedId];
    const heldUs = held ? asOfMicros(held) : null;
    if (heldUs !== null && heldUs >= incoming) return latest;
    return { ...latest, [feedId]: asOf };
  }

  return {
    userId: null,
    windows: {},
    latestAsOf: {},
    passed: {},
    floors: {},

    hydrate: (userId) => {
      if (get().userId === userId) return;
      // A pending write belongs to the identity that made it; hydrating a
      // different one drops it rather than flushing it under the new key.
      for (const t of writeTimers.values()) clearTimeout(t);
      writeTimers.clear();
      dirty.clear();
      dirtyUser = null;
      firstContact.clear();

      const passed: Record<string, PassedSet> = {};
      const floors: Record<string, number> = {};
      const prefix = userPrefix(userId);
      for (const key of ownKeys(userId)) {
        const feedId = key.slice(prefix.length);
        const stored = readKey(key);
        passed[feedId] = prune(stored.passed, stored.floor, PASSED_CAP);
        if (stored.floor !== null) floors[feedId] = stored.floor;
      }
      set({ userId, windows: {}, latestAsOf: {}, passed, floors });
    },

    adoptWindow: (feedId, win) => {
      const held = get().passed[feedId] ?? {};
      const prevFloor = get().floors[feedId] ?? null;
      const nextFloor = maxFloor(floorSeconds(win.windowStart), prevFloor);
      const pruned = prune(held, nextFloor, PASSED_CAP);
      set((s) => ({
        windows: { ...s.windows, [feedId]: win },
        latestAsOf: noteAsOfIn(s.latestAsOf, feedId, win.asOf),
        passed:
          pruned === held ? s.passed : { ...s.passed, [feedId]: pruned },
        floors:
          nextFloor === null ? s.floors : { ...s.floors, [feedId]: nextFloor },
      }));
      // Persist the prune, and the floor it was taken at — but a feed that has
      // passed nothing has no key worth creating for a floor alone.
      if (
        Object.keys(held).length > 0 &&
        (pruned !== held || nextFloor !== prevFloor)
      )
        scheduleWrite(feedId);

      // First contact initialises the watermark rather than recording a look,
      // so it does not wait for dwell (§IV.4 moment 3). Nothing is marked
      // passed: the first look is the whole window unread and nothing new.
      if (win.seenBaselineAt === null && !firstContact.has(feedId)) {
        firstContact.add(feedId);
        void get()
          .markSeen(feedId, win.asOf)
          .finally(() => firstContact.delete(feedId));
      }
    },

    noteAsOf: (feedId, asOf) => {
      const latestAsOf = noteAsOfIn(get().latestAsOf, feedId, asOf);
      if (latestAsOf !== get().latestAsOf) set({ latestAsOf });
    },

    fetchWindow: async (feedId) => {
      const userId = get().userId;
      const win = await workspaceFeeds.seen(feedId);
      // A response for an identity no longer signed in here is not ours.
      if (get().userId !== userId) return;
      get().adoptWindow(feedId, win);
    },

    markSeen: async (feedId, asOf) => {
      const sent = asOf ?? get().latestAsOf[feedId];
      if (!sent) return false;
      const userId = get().userId;
      try {
        const win = await workspaceFeeds.markSeen(feedId, sent);
        if (get().userId !== userId) return false;
        get().adoptWindow(feedId, win);
        return true;
      } catch (err) {
        console.warn("feedSeen: markSeen failed", feedId, err);
        return false;
      }
    },

    markPassed: (feedId, postId, publishedAt) => {
      const held = get().passed[feedId] ?? {};
      if (postId in held) return;
      const listed = get().windows[feedId]?.items.find((i) => i.id === postId);
      const at = listed?.publishedAt ?? publishedAt;
      // Unknown date and not in the window: it cannot be counted, so there is
      // nothing a record of it would change.
      if (at === undefined) return;
      set((s) => ({
        passed: { ...s.passed, [feedId]: { ...held, [postId]: at } },
      }));
      scheduleWrite(feedId);
    },

    reconcileFeeds: (liveIds) => {
      const live = new Set(liveIds);
      const userId = get().userId;
      const drop = <T>(rec: Record<string, T>) => {
        const stale = Object.keys(rec).filter((id) => !live.has(id));
        if (stale.length === 0) return rec;
        const next = { ...rec };
        for (const id of stale) delete next[id];
        return next;
      };
      set((s) => ({
        windows: drop(s.windows),
        latestAsOf: drop(s.latestAsOf),
        passed: drop(s.passed),
        floors: drop(s.floors),
      }));
      for (const id of [...dirty]) {
        if (live.has(id)) continue;
        dirty.delete(id);
        const t = writeTimers.get(id);
        if (t) clearTimeout(t);
        writeTimers.delete(id);
      }
      if (!userId) return;
      const ls = storage();
      if (!ls) return;
      const prefix = userPrefix(userId);
      for (const key of ownKeys(userId)) {
        if (live.has(key.slice(prefix.length))) continue;
        try {
          ls.removeItem(key);
        } catch {
          // An orphaned key is inert: nothing reads a feed that is not live.
        }
      }
    },
  };
});

// Flushed on the way out, as the layout store is: `pagehide` and not
// `beforeunload` (unreliable on mobile), and `visibilitychange → hidden` for
// the app switch that never unloads. The `storage` event is how a pass in one
// tab stops counting in another (§IV.5). Registered once, at module scope,
// because the store outlives every component that reads it.
if (typeof window !== "undefined") {
  window.addEventListener("pagehide", () => flushAll());
  window.addEventListener("storage", (e: StorageEvent) =>
    onStorage(e.key, e.newValue),
  );
  if (typeof document !== "undefined")
    document.addEventListener("visibilitychange", () => {
      if (document.visibilityState === "hidden") flushAll();
    });
}

// -----------------------------------------------------------------------------
// Derivations
// -----------------------------------------------------------------------------

/** The two counts, or null while the feed has no window — no badge, never 0. */
export function feedSeenCounts(
  win: FeedSeenWindow | undefined,
  passed: PassedSet | undefined,
): FeedSeenCounts | null {
  if (!win) return null;
  const p = passed ?? {};
  let unread = 0;
  let fresh = 0;
  let allNew = true;
  for (const item of win.items) {
    if (!item.isNew) allNew = false;
    if (item.id in p) continue;
    unread++;
    if (item.isNew) fresh++;
  }
  return {
    unread,
    new: fresh,
    truncated: win.truncated,
    newTruncated: win.truncated && allNew && win.items.length > 0,
  };
}

/** A card's place in the reading counts: `new` (full ink and the label),
 *  `unread` (full ink), `read` (passed inside the window: the card's ground darkens), or
 *  nothing (outside the window, where we do not know). From the WINDOW, never
 *  the loaded list, so a card and the count can never disagree (§IV.8). */
export type SeenMark = "new" | "unread" | "read" | null;

export function feedSeenMark(
  win: FeedSeenWindow | undefined,
  passed: PassedSet | undefined,
  postId: string,
): SeenMark {
  if (!win) return null;
  const isNew = windowIndex(win).get(postId);
  if (isNew === undefined) return null;
  if (passed && postId in passed) return "read";
  return isNew ? "new" : "unread";
}

/** `post_id → isNew`, built once per adopted window: a window is never
 *  mutated, so its identity is its version. */
const indexes = new WeakMap<FeedSeenWindow, Map<string, boolean>>();
function windowIndex(win: FeedSeenWindow): Map<string, boolean> {
  let idx = indexes.get(win);
  if (!idx) {
    idx = new Map(win.items.map((i) => [i.id, i.isNew]));
    indexes.set(win, idx);
  }
  return idx;
}

/** A feed's counts, re-rendering only when its window or its passed set
 *  changes. */
export function useFeedSeenCounts(feedId: string): FeedSeenCounts | null {
  const win = useFeedSeen((s) => s.windows[feedId]);
  const passed = useFeedSeen((s) => s.passed[feedId]);
  return useMemo(() => feedSeenCounts(win, passed), [win, passed]);
}

/** One card's mark, re-rendering only when the MARK changes — a primitive, so
 *  a pass elsewhere in the feed does not re-render every card in it. */
export function useFeedSeenMark(
  feedId: string,
  postId: string,
): SeenMark {
  return useFeedSeen((s) =>
    feedSeenMark(s.windows[feedId], s.passed[feedId], postId),
  );
}
