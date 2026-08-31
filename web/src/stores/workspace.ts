import { create } from "zustand";
import {
  applyDrop as applyDropTo,
  insertFeed as insertFeedInto,
  removeFeed as removeFeedFrom,
  resizeSlot as resizeSlotIn,
  restoreSlot as restoreSlotIn,
  regimentedLayout,
  layoutFeedIds,
  FACTORY_W,
  type Column,
  type Drop,
  type Slot,
  type SlotLocation,
  type Viewport,
  type WorkspaceLayout,
} from "../lib/workspace/layout";
import {
  normalizeBrightness,
  normalizeDensity,
  type Brightness,
  type Density,
  type Orientation,
  type TextSize,
} from "../components/workspace/tokens";

// =============================================================================
// useWorkspace — the columnar floor's state (WORKSPACE-COLUMN-LAYOUT-ADR §III,
// §VIII). Two records, disjoint by design:
//
//   layout      — purely STRUCTURAL: columns left to right, slots top to
//                 bottom, per-slot sizes. Geometry is DERIVED from this by
//                 lib/workspace/layout.ts and never stored, so a state that
//                 violates the spacing rules is unrepresentable and there is
//                 nothing to detect, resolve or heal. (This replaces the
//                 free-coordinate `Record<feedId, {x, y, w, h}>` and, with it,
//                 the resting-overlap heal that existed to escape the states
//                 that model permitted.)
//   appearance  — purely PER-FEED: brightness/density/orientation/textSize.
//                 Neither record reaches into the other.
//
// Proviso on `appearance` (§III.1): scheme and density are server-authoritative
// FEED CHARACTER (feeds.appearance, MOBILE-LAYOUT-ADR §VI) — this record is
// their local CACHE and fallback, so the bootstrap reconcile and the
// FeedComposer's PATCH-with-revert are unchanged. `orientation` and `textSize`
// are local-only and have no server copy.
//
// Per WORKSPACE-EXPERIMENT-ADR §3 (now in planning-archive/) localStorage stays
// the source of truth, keyed by user id, written back debounced 200ms.
// =============================================================================

export interface VesselAppearance {
  brightness?: Brightness;
  density?: Density;
  orientation?: Orientation;
  textSize?: TextSize;
}

interface WorkspaceState {
  userId: string | null;
  layout: WorkspaceLayout;
  appearance: Record<string, VesselAppearance>;
  /** §V's parade-ground view. A VIEW over the feed list, not an edit — the
   *  stored layout is untouched while it is on, which is what makes leaving it
   *  trivial and crash-safe. */
  regimented: boolean;
  hydrated: boolean;

  hydrate: (userId: string) => void;

  applyDrop: (feedId: string, drop: Drop) => void;
  insertFeed: (feedId: string) => void;
  removeFeed: (feedId: string) => void;
  /** Faithful revert for an optimistic `removeFeed` whose server call failed:
   *  the slot returns to the column and index it was captured at
   *  (`locateSlot`), not to a fresh right-most factory column. */
  restoreSlot: (removed: SlotLocation) => void;
  resizeSlot: (
    feedId: string,
    size: { w: number; h: number },
    vp: Viewport,
  ) => void;

  setVesselBrightness: (feedId: string, brightness: Brightness) => void;
  setVesselDensity: (feedId: string, density: Density) => void;
  setVesselOrientation: (feedId: string, orientation: Orientation) => void;
  setVesselTextSize: (feedId: string, textSize: TextSize) => void;

  /**
   * Bootstrap-time reconcile against the authoritative server feed list. Two
   * jobs, and NO third: prune slots whose feed the server no longer returns
   * (deleted on another device) or has hidden, and append every visible feed
   * that has no slot. There is no heal, because there is nothing to heal —
   * illegal arrangements are unrepresentable. Appearance is pruned against the
   * LIVE set, not the visible one: a hidden feed keeps its character for when
   * it comes back.
   */
  reconcileFeeds: (liveIds: string[], visibleIds: string[]) => void;

  setRegimented: (regimented: boolean) => void;
  /** §V's edit-while-regimented: stamp the derived regimented arrangement as
   *  the custom layout and leave the mode, for the caller to then apply its one
   *  edit. */
  materializeRegimented: (
    feeds: { id: string; sortRank: number }[],
    vp: Viewport,
  ) => void;
}

const STORAGE_PREFIX = "workspace:layout:v2:";
const REGIMENTED_PREFIX = "workspace:regimented:";
/** The free-coordinate floor's key. Read once at hydrate for its appearance
 *  fields, then deleted (§VIII). */
const V1_PREFIX = "workspace:layout:";
const WRITE_DEBOUNCE_MS = 200;

let writeTimer: ReturnType<typeof setTimeout> | null = null;

const storageKey = (userId: string) => `${STORAGE_PREFIX}${userId}`;
const regimentedKey = (userId: string) => `${REGIMENTED_PREFIX}${userId}`;
const v1Key = (userId: string) => `${V1_PREFIX}${userId}`;

const EMPTY_LAYOUT: WorkspaceLayout = { columns: [] };

interface Persisted {
  layout: WorkspaceLayout;
  appearance: Record<string, VesselAppearance>;
}

/** Retire stale values from older builds on the way in — the same normalisation
 *  the v1 reader ran, so a scheme or density that has since been renamed lands
 *  as its successor rather than falling back to the default. */
function cleanAppearance(raw: unknown): Record<string, VesselAppearance> {
  const out: Record<string, VesselAppearance> = {};
  if (!raw || typeof raw !== "object") return out;
  for (const [feedId, val] of Object.entries(raw as Record<string, unknown>)) {
    if (!val || typeof val !== "object") continue;
    const v = val as Record<string, unknown>;
    const a: VesselAppearance = {};
    if (v.brightness !== undefined)
      a.brightness = normalizeBrightness(v.brightness as Brightness);
    if (v.density !== undefined)
      a.density = normalizeDensity(v.density as Density);
    if (v.orientation === "horizontal" || v.orientation === "vertical")
      a.orientation = v.orientation;
    if (
      typeof v.textSize === "number" &&
      v.textSize >= 1 &&
      v.textSize <= 5 &&
      Number.isInteger(v.textSize)
    )
      a.textSize = v.textSize as TextSize;
    if (Object.keys(a).length > 0) out[feedId] = a;
  }
  return out;
}

/** Defensive parse: a malformed blob (hand-edited, or written by a build that
 *  has since changed shape) must degrade to "no layout" and let the bootstrap
 *  reconcile rebuild, never throw on the render path. */
function cleanLayout(raw: unknown): WorkspaceLayout {
  if (!raw || typeof raw !== "object") return EMPTY_LAYOUT;
  const cols = (raw as { columns?: unknown }).columns;
  if (!Array.isArray(cols)) return EMPTY_LAYOUT;
  const seen = new Set<string>();
  const columns: Column[] = [];
  for (const c of cols) {
    const col = c as { id?: unknown; slots?: unknown };
    if (typeof col.id !== "string" || !Array.isArray(col.slots)) continue;
    const slots: Slot[] = [];
    for (const s of col.slots) {
      const slot = s as { feedId?: unknown; w?: unknown; h?: unknown };
      if (typeof slot.feedId !== "string") continue;
      // One slot per feed, floor-wide: a duplicate would render two vessels
      // for one feed and give drop resolution two answers.
      if (seen.has(slot.feedId)) continue;
      seen.add(slot.feedId);
      slots.push({
        feedId: slot.feedId,
        w:
          typeof slot.w === "number" && Number.isFinite(slot.w)
            ? slot.w
            : FACTORY_W,
        h:
          typeof slot.h === "number" && Number.isFinite(slot.h)
            ? slot.h
            : null,
      });
    }
    if (slots.length > 0) columns.push({ id: col.id, slots });
  }
  return { columns };
}

function readFromStorage(userId: string): Persisted | null {
  if (typeof window === "undefined") return null;
  try {
    const raw = window.localStorage.getItem(storageKey(userId));
    if (!raw) return null;
    const parsed = JSON.parse(raw) as {
      columns?: unknown;
      appearance?: unknown;
    };
    if (!parsed || typeof parsed !== "object") return null;
    return {
      layout: cleanLayout(parsed),
      appearance: cleanAppearance(parsed.appearance),
    };
  } catch {
    return null;
  }
}

/**
 * §VIII. The v1 key held `{x, y, w, h}` per feed alongside its appearance
 * fields. COORDINATES ARE DISCARDED — the columnar model has no use for them,
 * and the bootstrap reconcile places every feed from nothing. But `textSize`
 * and `orientation` are LOCAL-ONLY (no server copy, unlike scheme/density), so
 * a wholesale wipe would silently lose real settings; brightness and density
 * come across too, as warm cache with the server still authoritative.
 *
 * A one-shot read, not a migration framework. The 5a- (`{x,y}`), 5b-
 * (`{x,y,w,h}`) and 5c- (…+ appearance) era shapes all still occur in the wild
 * and all read forward here, because every field is optional.
 */
function migrateV1(userId: string): Record<string, VesselAppearance> {
  if (typeof window === "undefined") return {};
  try {
    const raw = window.localStorage.getItem(v1Key(userId));
    if (!raw) return {};
    return cleanAppearance(JSON.parse(raw));
  } catch {
    return {};
  }
}

function writeNow(userId: string, layout: WorkspaceLayout, appearance: Record<string, VesselAppearance>) {
  if (typeof window === "undefined") return;
  try {
    window.localStorage.setItem(
      storageKey(userId),
      JSON.stringify({ columns: layout.columns, appearance }),
    );
  } catch {
    // Quota exceeded / private browsing — silently drop. The UI keeps the
    // in-memory layout; a write failure must not crash the floor.
  }
}

function scheduleWrite(
  userId: string,
  layout: WorkspaceLayout,
  appearance: Record<string, VesselAppearance>,
) {
  if (typeof window === "undefined") return;
  if (writeTimer) clearTimeout(writeTimer);
  writeTimer = setTimeout(() => {
    writeNow(userId, layout, appearance);
    writeTimer = null;
  }, WRITE_DEBOUNCE_MS);
}

export const useWorkspace = create<WorkspaceState>((set, get) => {
  /** Commit a structural change and persist it. A no-op transform (the layout
   *  module returns the SAME object when nothing moved) writes nothing. */
  function commitLayout(next: WorkspaceLayout) {
    if (next === get().layout) return;
    set({ layout: next });
    const userId = get().userId;
    if (userId) scheduleWrite(userId, next, get().appearance);
  }

  function patchAppearance(feedId: string, patch: VesselAppearance) {
    const appearance = {
      ...get().appearance,
      [feedId]: { ...get().appearance[feedId], ...patch },
    };
    set({ appearance });
    const userId = get().userId;
    if (userId) scheduleWrite(userId, get().layout, appearance);
  }

  return {
    userId: null,
    layout: EMPTY_LAYOUT,
    appearance: {},
    regimented: false,
    hydrated: false,

    hydrate: (userId) => {
      if (get().userId === userId && get().hydrated) return;
      if (writeTimer) {
        clearTimeout(writeTimer);
        writeTimer = null;
      }
      const stored = readFromStorage(userId);
      const layout = stored?.layout ?? EMPTY_LAYOUT;
      let appearance = stored?.appearance ?? {};

      if (!stored) {
        // First run on this device since the rewrite: lift what the v1 key
        // still has that this model uses, write v2 SYNCHRONOUSLY (so the
        // deletion below can never outrun the debounce), then retire v1.
        appearance = migrateV1(userId);
        if (typeof window !== "undefined") {
          if (Object.keys(appearance).length > 0)
            writeNow(userId, layout, appearance);
          try {
            window.localStorage.removeItem(v1Key(userId));
          } catch {
            // Nothing to do — a surviving v1 key is inert, and the next
            // hydrate would simply re-read the same appearance.
          }
        }
      }

      let regimented = false;
      if (typeof window !== "undefined") {
        try {
          regimented =
            window.localStorage.getItem(regimentedKey(userId)) === "true";
        } catch {
          regimented = false;
        }
      }

      // No placement here: at hydrate the store cannot tell a hidden feed from
      // a deleted one. reconcileFeeds (bootstrap, once the server list is in)
      // owns pruning and placement.
      set({ userId, layout, appearance, regimented, hydrated: true });
    },

    applyDrop: (feedId, drop) =>
      commitLayout(applyDropTo(get().layout, feedId, drop)),

    insertFeed: (feedId) => commitLayout(insertFeedInto(get().layout, feedId)),

    removeFeed: (feedId) => commitLayout(removeFeedFrom(get().layout, feedId)),

    restoreSlot: (removed) => commitLayout(restoreSlotIn(get().layout, removed)),

    resizeSlot: (feedId, size, vp) =>
      commitLayout(resizeSlotIn(get().layout, feedId, size, vp)),

    setVesselBrightness: (feedId, brightness) =>
      patchAppearance(feedId, { brightness }),

    setVesselDensity: (feedId, density) => patchAppearance(feedId, { density }),

    setVesselOrientation: (feedId, orientation) =>
      patchAppearance(feedId, { orientation }),

    setVesselTextSize: (feedId, textSize) =>
      patchAppearance(feedId, { textSize }),

    reconcileFeeds: (liveIds, visibleIds) => {
      const live = new Set(liveIds);
      const visible = new Set(visibleIds);
      let layout = get().layout;
      for (const id of layoutFeedIds(layout))
        if (!visible.has(id)) layout = removeFeedFrom(layout, id);
      // List order, so a first run lands the seeded starter feeds left to right
      // in the order the gateway returned them (§III.4).
      for (const id of visibleIds) layout = insertFeedInto(layout, id);

      const appearance = get().appearance;
      const stale = Object.keys(appearance).filter((id) => !live.has(id));
      const nextAppearance =
        stale.length > 0
          ? Object.fromEntries(
              Object.entries(appearance).filter(([id]) => live.has(id)),
            )
          : appearance;

      if (layout === get().layout && nextAppearance === appearance) return;
      set({ layout, appearance: nextAppearance });
      const userId = get().userId;
      if (userId) scheduleWrite(userId, layout, nextAppearance);
    },

    setRegimented: (regimented) => {
      set({ regimented });
      const userId = get().userId;
      if (userId && typeof window !== "undefined") {
        try {
          window.localStorage.setItem(
            regimentedKey(userId),
            regimented ? "true" : "false",
          );
        } catch {
          // Worst case the mode doesn't survive a reload.
        }
      }
    },

    materializeRegimented: (feeds, vp) => {
      const layout = regimentedLayout(feeds, vp);
      set({ layout, regimented: false });
      const userId = get().userId;
      if (userId) {
        scheduleWrite(userId, layout, get().appearance);
        if (typeof window !== "undefined") {
          try {
            window.localStorage.setItem(regimentedKey(userId), "false");
          } catch {
            // See setRegimented.
          }
        }
      }
    },
  };
});
