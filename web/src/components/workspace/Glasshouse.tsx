"use client";

// =============================================================================
// Glasshouse — the canonical "frosted overlay over the workspace" primitive.
//
// One shape, reused everywhere a surface opens *over* the workspace (the reader
// pane, direct messages, future panels):
//   - a full-viewport frosted scrim (z-[55], `.gh-scrim`) — backdrop blur PLUS a
//     desaturate + neutral wash that converges any per-feed scheme behind toward
//     the mode's ground, so the pane always meets the same field (separation is
//     the scrim's job — GLASSHOUSE-AND-PALETTE-ADR §III.1); click-to-close;
//   - a pale parchment pane (z-[56], `bg-glasshouse` = #F5F4F0) lifted by an
//     elevation shadow alone (no top edge), click-through guarded. The pane is
//     LIGHTER than both the bone floor and the washed scrim ground, so it reads
//     as lifted paper (the identity is the pane's — §III.2); fields inside it are
//     the brighter white wells. It opens snapped-centred on the 20px lattice and
//     is DRAGGABLE by any empty part of itself (the top-centre grip is just the
//     discoverable affordance; a pointerdown on margins/chrome drags too, while
//     prose stays highlightable and controls stay live — see isDragSurface) —
//     drag is free, snaps to the lattice on release, clamps to
//     the viewport, and (with `persistKey`) remembers its spot per overlay. It
//     stays modal throughout: the scrim, one-at-a-time, and scroll-lock are
//     unchanged; only the single pane's placement is now user-chosen;
//   - Escape closes; body scroll is locked while mounted.
//
// The ForallMenu lives separately at z-60, so it floats CRISP above the frost
// as the sole nav affordance — that crispness is the whole point of the
// pattern and is preserved simply by Glasshouse never reaching z-60.
//
// Glasshouse owns only the chrome. URL-sync / history behaviour (the reader's
// shareable /article·/reader entries) is layered on top by the caller's store,
// not here. Mount it conditionally — it runs its scroll-lock on mount/unmount.
//
// Separation inside the pane is whitespace + the slab rules, per the sitewide
// no-thin-line rule; the 6px slab top and the elevation shadow are not lines.
//
// INVARIANT — one Glasshouse at a time. Frosted panes never stack: opening any
// Glasshouse supersedes whichever was open before. This is enforced here, in the
// primitive, so every surface participates automatically (incl. the workspace-
// local Composer / FeedComposer driven by local state, not a store). The active
// instance is tracked module-level; a newly-mounted pane closes the previous one
// via its `supersede` callback. `supersede` is a STATE-ONLY close (never
// history.back): for URL-synced overlays (reader / profile / surface) the caller
// passes `onSupersede={dismiss}`, because the newcomer already owns the top
// history entry and a history.back here would pop *its* URL, not the old pane's.
// Ephemeral overlays omit it — their onClose is already state-only.
// =============================================================================

import React, { useCallback, useEffect, useRef, useState } from "react";
import { snap } from "../../lib/workspace/grid";
import { stretchedMeasure, MEASURE_REST } from "../../lib/workspace/measure";
import { useIsMobile } from "../../hooks/useIsMobile";
import {
  useGlasshousePresence,
  useDiscCloseActive,
} from "../../stores/glasshouse";
import { useExplain } from "../../stores/explain";
import { useLightbox } from "../../stores/lightbox";
import { useBackGuard } from "../../lib/backGuard";
import { isDragSurface } from "../../lib/dragSurface";
import type { PaneRect } from "./paneRect";
import { MOBILE_BAR_H } from "./MobileWorkspace";
import { NAV_BAR_H, NAV_BAR_BAND } from "./NavBar";
import { reopenAddressedPane } from "../../lib/workspace/overlays";

// Gutter between the pane and the viewport edge. (Not a lattice value — the
// shared drag/resize lattice is GRID = 8, grid.ts.)
const MARGIN = 20;
// Floors for a resizable pane (the writers). On the 20px lattice.
const MIN_W = 320;
const MIN_H = 240;

// Feed-launched frame geometry — an INVERTED, thinner echo of the feed vessel.
// The vessel is ⊔ (8px side walls + a 32px bottom bar). The reader frame is its
// inversion ⊓: a top bar + narrow side rules, open at the bottom — all thinner
// than the vessel's own walls. Drawn as a colour overlay (not borders) so it
// never disturbs the pane's width / scroll geometry, sitting in the content's
// top + side padding gutters. Both dimensions clear the banned single-pixel range.
const FRAME_TOP = 8; // top-bar thickness (the substantial bar; reads above the rules)
const FRAME_SIDE = 4; // side-rule thickness (the reader's thinner echo)

// Top seam (`topSeam`) — the band of pane-coloured background that a flush body's
// content flows INTO, so it never collides with the pinned chrome. Opaque to
// SEAM_SOLID (the grip sits at y 14–18, so 20 clears it outright), then fading
// out by SEAM_H. Sized to stay clear of the readers' own top padding at rest
// (external 32 + the reader's pt-2 = 40; native md 40 + 8 = 48), so the seam is
// pure background until something scrolls under it.
const SEAM_SOLID = 20;
const SEAM_H = 38;
// Skip "ears": half-circle tabs that protrude from the pane's left/right edges,
// each carrying a triangular arrow — the up/down feed-skip buttons. Coloured the
// frame colour; the arrow takes the frame's contrast tone.
const EAR_R = 22; // ear radius (protrusion depth = EAR_R, height = 2·EAR_R)
const EAR_ARROW = 7; // arrow half-width / height

// Duration of the `enterFrom` morph. Long enough to read as one pane changing
// shape, short enough that it never stands between the writer and the cursor.
const ENTER_MS = 260;

// Read once per morph, not subscribed to: a single gesture's animation.
// Defensive against environments with no matchMedia (jsdom in the test suite).
function prefersReducedMotion(): boolean {
  if (typeof window === "undefined" || !window.matchMedia) return false;
  try {
    return window.matchMedia("(prefers-reduced-motion: reduce)").matches;
  } catch {
    return false;
  }
}

const clampN = (v: number, lo: number, hi: number) =>
  Math.max(lo, Math.min(hi, v));

// Whole-pane drag (the user can grab the window by any "empty" part of it, not
// just the top grip). A pointerdown on the pane starts a drag UNLESS it landed
// on something already doing its own thing: an interactive control, selectable
// text, or a native scrollbar gutter. So the margins move the window while the
// article prose stays highlightable and links/buttons stay clickable. The
// judgment lives in the shared `isDragSurface` helper (also used by the feed
// card's drag-to-another-feed).

// Persisted drag position, keyed per overlay so each surface remembers its own
// spot between appearances. Best-effort — storage can throw (private mode, quota).
const posStoreKey = (key: string) => `ah:overlay-pos:${key}`;
function readPos(key: string): { x: number; y: number } | null {
  try {
    const raw = localStorage.getItem(posStoreKey(key));
    if (!raw) return null;
    const p = JSON.parse(raw);
    if (typeof p?.x === "number" && typeof p?.y === "number") return p;
  } catch {
    /* ignore */
  }
  return null;
}
function writePos(key: string, pos: { x: number; y: number }) {
  try {
    localStorage.setItem(posStoreKey(key), JSON.stringify(pos));
  } catch {
    /* ignore */
  }
}

// Persisted pane size, for resizable overlays. Separate key from position so the
// two gestures (drag, stretch) persist independently.
const sizeStoreKey = (key: string) => `ah:overlay-size:${key}`;
function readSize(key: string): { w: number; h: number } | null {
  try {
    const raw = localStorage.getItem(sizeStoreKey(key));
    if (!raw) return null;
    const s = JSON.parse(raw);
    if (typeof s?.w === "number" && typeof s?.h === "number") return s;
  } catch {
    /* ignore */
  }
  return null;
}
function writeSize(key: string, size: { w: number; h: number }) {
  try {
    localStorage.setItem(sizeStoreKey(key), JSON.stringify(size));
  } catch {
    /* ignore */
  }
}
/** Forget a stretched size, so the pane falls back to the default width and
 *  fill/content height. A drag begun in the default view uses this: the
 *  arrangement it replaces has to go whole. */
function clearSize(key: string) {
  try {
    localStorage.removeItem(sizeStoreKey(key));
  } catch {
    /* ignore */
  }
}

// Persisted `\` toggle — whether the pane was last left in its DEFAULT view.
// Stored only while true, so the ordinary state leaves nothing behind.
const defaultStoreKey = (key: string) => `ah:overlay-default:${key}`;
function readShowDefault(key: string): boolean {
  try {
    return localStorage.getItem(defaultStoreKey(key)) === "1";
  } catch {
    return false;
  }
}
function writeShowDefault(key: string, on: boolean) {
  try {
    if (on) localStorage.setItem(defaultStoreKey(key), "1");
    else localStorage.removeItem(defaultStoreKey(key));
  } catch {
    /* ignore */
  }
}

// Placement of the pane: a draggable, grid-snapped, viewport-clamped position
// that persists per overlay.
//
// The default position is the snapped centre. Flex `justify-center` lands a
// fixed-width pane on a half-pixel left edge whenever the viewport width is odd,
// rendering the pane edges and all its interior text faintly fuzzy; computing the
// offset and snapping it to the 20px lattice kills the sub-pixel blur and puts the
// pane on the same grid as the vessels behind it.
//
// Drag is free (smooth) and snaps to the lattice on release, then persists. The
// pane stays modal — the scrim, one-at-a-time, and scroll-lock are unchanged; the
// only difference is the single pane's placement is now user-chosen and remembered.
// Vertical room (`maxHeight`) is derived from the drop position so the pane is
// always fully on-screen with a bottom gutter; content beyond that scrolls inside.
//
// Pane geometry — pure functions of the viewport, hoisted to module scope so the
// resize effect closes over nothing but `maxWidth` (genuinely exhaustive deps).
// THE CHROME INSET MOVES WITH THE CHROME. It has been a vertical reservation
// (the viewport less the fixed desktop nav ROW at its bottom), then a
// horizontal one (less the nav RAIL at its left, 2026-08-24), and is now a
// vertical one again — the viewport less the nav BAR along its TOP
// (NavBar.tsx), reserved from the near edge rather than the far one. The reason
// never changes: the chrome is z-58, above the pane (z-56), so a pane that
// ignored it would slide underneath something opaque. Applied unconditionally
// on the desktop path: a member always lands in the workspace (HomeRedirect /
// ?overlay= on /reader), so a desktop pane over a bar-less standalone page is
// only ever a transient pre-redirect frame.
//
// TOP-EDGE CHROME RESERVES DIFFERENTLY FROM BOTTOM-EDGE CHROME, and this is the
// thing to get right. A bottom row only capped the pane's HEIGHT; a top bar
// moves its ORIGIN, so the reservation is a FLOOR under the pane's y
// (`minYFor`) and every clamp passes it as the lower bound — a hard 0 there
// parks a dragged pane under the bar. The height falls out for free: the pane
// runs from wherever it sits to the window's bottom edge, which nothing
// occupies.
//
// `coverNavChrome` (the three immersive panes — the reader, the article editor
// and the note composer) is the exception, unchanged throughout: immersion
// belongs to the surfaces where one piece fills the whole of your attention —
// reading it, and writing it at either length. Such a pane covers the nav
// chrome entirely — the caller un-mounts the bar + muster while one is open
// (WorkspaceView for all three, LayoutShell for the global ComposeOverlay), so
// nothing paints over the pane except the z-60 ∀ lockup — and its full room is
// the whole viewport, edge to edge. The flag buys VERTICAL room again, as it
// did in the row era. Everything else — messages, dashboard, settings, the FEED
// composer — is a panel you dip into while the workspace is still what you are
// doing, and keeps the bar live.
const barFor = (coverNavChrome = false) => (coverNavChrome ? 0 : NAV_BAR_H);
// Width is the plain viewport again: no chrome stands along either side edge.
const widthFor = (maxWidth: number, vw: number) =>
  Math.min(maxWidth, vw - MARGIN * 2);
const minXFor = () => 0;
const maxXFor = (maxWidth: number, vw: number) =>
  Math.max(0, vw - widthFor(maxWidth, vw));
// The pane's y has a FLOOR and a ceiling that keeps at least 120px of the pane
// — its draggable top + chrome — on-screen. THE FLOOR IS THE BAR'S OPTICAL
// BAND, NOT ITS TRUE EDGE (`NAV_BAR_BAND`, 2026-09-06): a pane may come no
// closer to the bar than a vessel does. The bar's bottom edge at `NAV_BAR_H` is
// invisible by construction — band and floor are one bone — and the disc's
// off-centre placement is licensed by that. A pane dragged flush to
// `NAV_BAR_H` traced that edge with its own top, the one line the whole bar is
// built on nobody seeing; and it was also the case that kept the Explain
// pane-mode scrim at `inset: 0` (a cut at the band would have left the pane's
// top 8px undimmed), which drew the same edge for every pane-mode Explain,
// dragged or not. With the floor at the band both artefacts are gone and the
// three dimming layers cut at one line (web/CLAUDE.md › *A dimming layer must
// not draw an edge*).
const minYFor = (coverNavChrome = false) =>
  coverNavChrome ? 0 : NAV_BAR_BAND;
const maxYFor = (vh: number, coverNavChrome = false) =>
  Math.max(minYFor(coverNavChrome), vh - 120);
// The default opening y: clear of the bar with a gutter under it. In the row
// era this was a bare `MARGIN * 2` from a top edge nothing occupied.
const defaultY = (coverNavChrome = false) =>
  coverNavChrome ? MARGIN * 2 : barFor(coverNavChrome) + MARGIN;
const centreX = (maxWidth: number, vw: number) =>
  clampN(
    snap((vw - widthFor(maxWidth, vw)) / 2),
    minXFor(),
    maxXFor(maxWidth, vw),
  );

// Glasshouse only ever mounts client-side (on a user action, post-hydration), so
// measuring in the state initialiser is safe.
//
// When `resizable`, the pane also carries an explicit width/height the user sets
// via a bottom-right stretch handle (mirrors the vessel resize). Width overrides
// the centred default (anchored top-left, grows right); height switches the body
// from content-driven to a fixed box. Both snap to the lattice on release and
// persist per overlay. Either is always re-clamped to keep the pane on-screen.
function usePanePlacement(
  maxWidth: number,
  persistKey?: string,
  resizable?: boolean,
  fullScreen?: boolean,
  fillHeight?: boolean,
  coverNavChrome?: boolean,
) {
  const paneRef = useRef<HTMLDivElement | null>(null);
  // When covering the nav chrome, the pane's side/bottom gutter collapses to
  // the window edge so it can stretch to the whole window; otherwise the
  // standard MARGIN gutter. (The top gutter is `defaultY` above: a default pane
  // opens one MARGIN below the nav bar and reaches the BOTTOM edge, per the
  // request. The reader, covering the bar, opens at the old `MARGIN * 2`.)
  const edge = coverNavChrome ? 0 : MARGIN;
  // THE BOTTOM GUTTER IS SEPARATE FROM THE SIDE ONE, and a `fillHeight` pane
  // has none. "Fill" already meant "top gutter → the window bottom" in this
  // prop's own contract and in `usePanePlacement`'s header, but the height
  // subtracted a MARGIN all the same, so an immersive pane stopped 20px short
  // of the edge it claimed to reach. A pane that fills is the ⊓ vessel shape
  // (open at the bottom): it runs OFF the bottom of the window rather than
  // sitting on a shelf above it. Only the height uses this; the width clamp
  // keeps the side gutter, which is real.
  const bottomEdge = fillHeight ? 0 : edge;
  const [vp, setVp] = useState(() =>
    typeof window === "undefined"
      ? { vw: 1024, vh: 768 }
      : { vw: window.innerWidth, vh: window.innerHeight },
  );
  const [size, setSize] = useState<{ w: number; h: number } | null>(() => {
    if (typeof window === "undefined" || !persistKey || !resizable) return null;
    return readSize(persistKey);
  });
  const [pos, setPos] = useState(() => {
    if (typeof window === "undefined") return { x: 0, y: defaultY(coverNavChrome) };
    const { innerWidth: vw, innerHeight: vh } = window;
    const stored = persistKey ? readPos(persistKey) : null;
    const base = stored ?? { x: centreX(maxWidth, vw), y: defaultY(coverNavChrome) };
    return {
      x: clampN(base.x, minXFor(), maxXFor(maxWidth, vw)),
      y: clampN(base.y, minYFor(coverNavChrome), maxYFor(vh, coverNavChrome)),
    };
  });

  // `\` toggles this pane between the user's custom arrangement (the persisted
  // `pos`/`size`) and the DEFAULT placement (snapped-centre, default width,
  // fill/content height) — the pane-scoped mirror of the workspace floor's `\`
  // (which is inert while a pane is open). It is a transient, NON-DESTRUCTIVE
  // view while it is only a view: `pos`/`size` stay in state, so a second `\`
  // restores the custom arrangement verbatim. ADJUSTING THE PANE IN THE DEFAULT
  // VIEW IS WHAT MAKES IT DESTRUCTIVE, and it replaces the custom arrangement
  // WHOLE rather than editing one axis of it (see startDrag / startResize) — a
  // member who has toggled to the default is starting from there, so a drag must
  // not restore the old stretched size and a stretch must not restore the old
  // spot. THE TOGGLE IS REMEMBERED PER OVERLAY (with `persistKey`): a pane left
  // in the default view reopens in it until the member presses `\` again, and a
  // drag or stretch — which always leaves the default view — clears it too.
  const [showDefault, setShowDefaultState] = useState(() =>
    typeof window !== "undefined" && !!persistKey && readShowDefault(persistKey),
  );
  const setShowDefault = useCallback(
    (v: boolean) => {
      setShowDefaultState(v);
      if (persistKey) writeShowDefault(persistKey, v);
    },
    [persistKey],
  );
  const toggleDefault = useCallback(
    () => setShowDefault(!showDefault),
    [setShowDefault, showDefault],
  );

  // Re-clamp to the viewport on resize so a remembered spot never strands the
  // pane off-screen on a smaller window.
  useEffect(() => {
    const onResize = () => {
      const { innerWidth: vw, innerHeight: vh } = window;
      setVp({ vw, vh });
      setPos((p) => ({
        x: clampN(p.x, minXFor(), maxXFor(maxWidth, vw)),
        y: clampN(p.y, minYFor(coverNavChrome), maxYFor(vh, coverNavChrome)),
      }));
    };
    window.addEventListener("resize", onResize);
    return () => window.removeEventListener("resize", onResize);
  }, [maxWidth, coverNavChrome]);

  // Active drag/resize listener teardown. Lives in a ref so (a) the unmount
  // effect below can detach listeners if the pane closes mid-gesture (Escape,
  // supersede) — otherwise the orphaned pointerup would setState on an
  // unmounted hook and persist a position for a closed pane — and (b) a new
  // gesture can defensively clear a previous one.
  const gestureCleanupRef = useRef<(() => void) | null>(null);
  useEffect(
    () => () => {
      gestureCleanupRef.current?.();
      gestureCleanupRef.current = null;
    },
    [],
  );

  const startDrag = (e: React.PointerEvent) => {
    e.preventDefault();
    e.stopPropagation();
    gestureCleanupRef.current?.();
    const { innerWidth: vw, innerHeight: vh } = window;
    // Drag from wherever the pane is RENDERED — the default spot when a `\`
    // toggle is showing it, else the custom `pos` — so the grab point never jumps.
    const base = showDefault
      ? {
          x: clampN(centreX(maxWidth, vw), minXFor(), maxXFor(maxWidth, vw)),
          y: clampN(defaultY(coverNavChrome), minYFor(coverNavChrome), maxYFor(vh, coverNavChrome)),
        }
      : pos;
    const offX = e.clientX - base.x;
    const offY = e.clientY - base.y;
    // AN ADJUSTMENT MADE IN THE DEFAULT VIEW STARTS FROM SCRATCH THERE. The
    // gesture doesn't edit the custom arrangement, it REPLACES it: the default
    // placement plus this one edit. For a drag that means dropping the stretched
    // size along with the position, or the pane would take the new spot and then
    // snap back to a size the member has just toggled away from — the custom
    // arrangement reappearing halfway, which is exactly what `\` was pressed to
    // leave. (Resize does the mirror below: it pins the default POSITION.) The
    // floor's `\` has always worked this way — `materializeIfRegimented` stamps
    // the whole parade before applying the drop (WorkspaceView §V).
    const fromDefault = showDefault;
    // A press that never moved is not an adjustment and commits NOTHING — the
    // pane twin of the floor's `dropIsNoop` / the vessel's `unchanged` guard.
    // It matters more now that a from-default commit discards the stored size:
    // a stray click on the pane must not be what destroys it.
    let moved = false;
    // Suppress text selection while the window rides the cursor (whole-pane drag
    // can start on a margin and sweep over prose). Restored on gesture teardown.
    const prevUserSelect = document.body.style.userSelect;
    document.body.style.userSelect = "none";
    const onUp = (ev: PointerEvent) => {
      gestureCleanupRef.current?.();
      if (!moved) return;
      const dropped = {
        x: clampN(snap(ev.clientX - offX), minXFor(), maxXFor(maxWidth, vw)),
        y: clampN(snap(ev.clientY - offY), minYFor(coverNavChrome), maxYFor(vh, coverNavChrome)),
      };
      // A drag makes this the new custom arrangement — leave the default view.
      // Batched with setPos, so the pane never flashes the old custom spot.
      setShowDefault(false);
      setPos(dropped);
      if (fromDefault) setSize(null);
      if (persistKey) {
        writePos(persistKey, dropped);
        if (fromDefault) clearSize(persistKey);
      }
    };
    // The last pointer seen with the button HELD. A release outside the window
    // never delivers a pointerup, so the gesture only learns it ended from the
    // first buttonless move on re-entry — which is wherever the cursor came
    // back in, not where it let go. Committing that point is what collapsed a
    // stretched Messages pane to its 320×240 floor (re-entry near the top-left)
    // and SAVED it; the drop is the last held position instead.
    let lastHeld: PointerEvent | null = null;
    const onMove = (ev: PointerEvent) => {
      // Button released outside the window: no pointerup ever reaches us, so
      // the first buttonless move is the drop (else the pane rides the cursor
      // on re-entry until the next click).
      if ((ev.buttons & 1) === 0) {
        onUp(lastHeld ?? ev);
        return;
      }
      lastHeld = ev;
      moved = true;
      setShowDefault(false);
      // Live, not just on release: the pane keeps the default's width and
      // fill-height for the whole gesture, so nothing flashes back mid-drag.
      if (fromDefault) setSize(null);
      setPos({
        x: clampN(ev.clientX - offX, minXFor(), maxXFor(maxWidth, vw)),
        y: clampN(ev.clientY - offY, minYFor(coverNavChrome), maxYFor(vh, coverNavChrome)),
      });
    };
    window.addEventListener("pointermove", onMove);
    window.addEventListener("pointerup", onUp);
    gestureCleanupRef.current = () => {
      window.removeEventListener("pointermove", onMove);
      window.removeEventListener("pointerup", onUp);
      document.body.style.userSelect = prevUserSelect;
      gestureCleanupRef.current = null;
    };
  };

  const startResize = (e: React.PointerEvent) => {
    e.preventDefault();
    e.stopPropagation();
    gestureCleanupRef.current?.();
    const { innerWidth: vw, innerHeight: vh } = window;
    const startW = paneRef.current?.offsetWidth ?? widthFor(maxWidth, vw);
    const startH = paneRef.current?.offsetHeight ?? MIN_H;
    const { clientX: startX, clientY: startY } = e;
    // Cap against wherever the pane is RENDERED (default centre while a `\`
    // toggle shows it, else the custom `pos`) so the stretched pane keeps a
    // gutter to the right / bottom edge — both the window's now.
    const baseX = showDefault ? clampN(centreX(maxWidth, vw), minXFor(), maxXFor(maxWidth, vw)) : pos.x;
    const baseY = showDefault ? clampN(defaultY(coverNavChrome), minYFor(coverNavChrome), maxYFor(vh, coverNavChrome)) : pos.y;
    const maxW = Math.max(MIN_W, vw - baseX - edge);
    const maxH = Math.max(MIN_H, vh - baseY - edge);
    const resolve = (ev: PointerEvent) => ({
      w: snap(clampN(startW + (ev.clientX - startX), MIN_W, maxW)),
      h: snap(clampN(startH + (ev.clientY - startY), MIN_H, maxH)),
    });
    // As in the drag: a press on the grip that never moved commits nothing, so a
    // bare click can't freeze a fill-height pane to a number or pin the default
    // view as the new custom arrangement.
    let moved = false;
    const onUp = (ev: PointerEvent) => {
      gestureCleanupRef.current?.();
      if (!moved) return;
      const next = resolve(ev);
      // A resize commits a new custom arrangement; leave the default view. If the
      // pane was showing default at a non-custom position, also pin that position
      // so the committed size lines up with where the handle actually was.
      if (showDefault) setPos({ x: baseX, y: baseY });
      setShowDefault(false);
      setSize(next);
      if (persistKey) {
        if (showDefault) writePos(persistKey, { x: baseX, y: baseY });
        writeSize(persistKey, next);
      }
    };
    // As in the drag: a release outside the window commits the last HELD
    // position, never the buttonless re-entry point.
    let lastHeld: PointerEvent | null = null;
    const onMove = (ev: PointerEvent) => {
      if ((ev.buttons & 1) === 0) {
        onUp(lastHeld ?? ev);
        return;
      }
      lastHeld = ev;
      moved = true;
      if (showDefault) setPos({ x: baseX, y: baseY });
      setShowDefault(false);
      setSize(resolve(ev));
    };
    window.addEventListener("pointermove", onMove);
    window.addEventListener("pointerup", onUp);
    gestureCleanupRef.current = () => {
      window.removeEventListener("pointermove", onMove);
      window.removeEventListener("pointerup", onUp);
      gestureCleanupRef.current = null;
    };
  };

  // Effective placement: while a `\` toggle shows the default, substitute the
  // snapped-centre position and drop any custom size (so width falls back to the
  // default and height to fill/content). Non-destructive — `pos`/`size` are
  // untouched, so toggling back restores the custom arrangement verbatim.
  const ePos = showDefault
    ? {
        x: clampN(centreX(maxWidth, vp.vw), minXFor(), maxXFor(maxWidth, vp.vw)),
        y: clampN(defaultY(coverNavChrome), minYFor(coverNavChrome), maxYFor(vp.vh, coverNavChrome)),
      }
    : pos;
  const eSize = showDefault ? null : size;

  // Available on-screen height below the drop position; `--gh-h` and the pane's
  // own clamp both derive from it. The window bottom either way — the nav
  // chrome sits along the TOP edge (NavBar.tsx), and it is reserved by the
  // pane's y floor (`minYFor`), never by a second subtraction here. Reserving it
  // twice was the old `usableH`, and it cost every pane 56px it already had.
  const maxHeight = vp.vh - ePos.y - bottomEdge;
  const effW = resizable
    ? clampN(
        eSize?.w ?? widthFor(maxWidth, vp.vw),
        MIN_W,
        Math.max(MIN_W, vp.vw - ePos.x - edge),
      )
    : widthFor(maxWidth, vp.vw);
  // Height precedence: an explicit resized height wins (respect the user's
  // stretch, re-clamped on-screen); else `fillHeight` defaults the pane to the
  // full available room (top gutter → the window bottom) so a reading pane opens tall
  // and immersive; else content-driven (null). `fillHeight` is only a DEFAULT —
  // a persisted `size.h` (the user stretched smaller) always takes over.
  const effH =
    resizable && eSize?.h != null
      ? Math.min(eSize.h, maxHeight)
      : fillHeight
        ? maxHeight
        : null;
  const ghH = effH ?? maxHeight;

  // Full-screen sheet (mobile): the pane fills the viewport BELOW the persistent
  // mobile top bar (MOBILE_BAR_H) — the bar is fixed chrome at z-58 that stays in
  // place across every view, so the sheet insets under it rather than hiding
  // behind it. Placement, drag and stretch are desktop pointer affordances and
  // don't apply here.
  if (fullScreen) {
    const h = Math.max(0, vp.vh - MOBILE_BAR_H);
    return {
      paneRef,
      x: 0,
      y: MOBILE_BAR_H,
      width: vp.vw,
      height: h,
      ghH: h,
      // No stretch gesture on the sheet, so no stretched measure: the column
      // rests, and on a phone it is parent-limited long before 640 anyway.
      measure: MEASURE_REST,
      startDrag: null,
      startResize: null,
      toggleDefault: null as (() => void) | null,
    };
  }

  return {
    paneRef,
    x: ePos.x,
    y: ePos.y,
    width: effW,
    height: effH,
    ghH,
    // The prose measure a stretched pane earns, pivoting on THIS pane's own
    // default width so nothing moves at rest (lib/workspace/measure.ts). Every
    // pane publishes it, resizable or not: an unstretched pane's `effW` IS its
    // rest width, so the curve returns the rest measure and the fallback in
    // `.ah-measure` never has to be reasoned about twice.
    measure: stretchedMeasure(effW, widthFor(maxWidth, vp.vw)),
    startDrag: startDrag as ((e: React.PointerEvent) => void) | null,
    startResize: resizable ? startResize : null,
    toggleDefault: toggleDefault as (() => void) | null,
  };
}

// The currently-open Glasshouse (or null). `token` is a per-instance identity so
// the unmount cleanup only clears the slot when it still owns it (never clobbers
// a successor that already claimed it).
let activeGlasshouse: {
  token: object;
  supersede: () => void;
  rect: () => PaneRect | null;
} | null = null;

/**
 * The box the live Glasshouse pane currently occupies, or null when none is
 * open. Read by a surface that is about to open a DIFFERENT Glasshouse in place
 * of this one (the note→article handoff) and wants the newcomer to grow out of
 * it rather than cut to its own geometry — pass the result as `enterFrom`.
 *
 * It comes from the registry rather than from a caller-held ref because the
 * registry is already the primitive's own record of which single pane is live,
 * and the caller (ComposeOverlay / Composer) never holds the pane element —
 * Glasshouse does.
 */
export function activeGlasshouseRect(): PaneRect | null {
  return activeGlasshouse?.rect() ?? null;
}

/**
 * THE HAND-BACK BELONGS WHERE THE SUPERSEDE HAPPENS.
 *
 * A pane that supersedes a URL-synced one has to hand it back, and the
 * supersede is the PRIMITIVE's doing — every Glasshouse participates in the
 * one-at-a-time registry automatically, which is the whole reason that rule is
 * enforced here rather than in callers. The hand-back was wired in exactly one
 * place instead: `useCompose.close()`. Every other superseder left the address
 * naming a pane that was no longer on screen, with the pane suspended in its
 * store and Back visibly doing nothing (it pops the orphaned entry while the
 * suspended pane's popstate listener is detached). The ∀ menu opens five such
 * panes over any pane BY DESIGN, and the workspace's own composer never touches
 * the compose store at all — `setComposerOpen("note")` — so the one wired
 * superseder was also the one the menu could not reach.
 *
 * WHY IT IS DEFERRED. React runs every cleanup in a commit before any create,
 * so a handoff releases the slot and refills it within one flush: "the slot went
 * null" is not yet "nothing is open". A microtask asks again once the flush has
 * settled. The lazy-chunk case needs no extra care — the handoff rule has the
 * newcomer supersede from its own MOUNT effect, so the outgoing pane holds the
 * slot for as long as the chunk takes.
 *
 * `reopenAddressedPane` is itself guarded (the history marker must say an
 * overlay put this address there, and it declines if a pane is already up), so
 * this is safe to fire on any release.
 */
function scheduleAddressedPaneHandback(): void {
  queueMicrotask(() => {
    if (activeGlasshouse) return;
    reopenAddressedPane();
  });
}

interface GlasshouseProps {
  /** Invoked by the scrim, the close button, and Escape. */
  onClose: () => void;
  /** State-only close used when this pane is superseded by a newer Glasshouse.
   *  Defaults to onClose; URL-synced callers (reader/profile/surface) pass their
   *  store's `dismiss` so superseding never triggers a history.back. */
  onSupersede?: () => void;
  /** Max width of the pane, in px. */
  maxWidth: number;
  /** Accessible label for the pane dialog. */
  ariaLabel?: string;
  /** ONE-SHOT ENTRY BOX — the rect of the pane this one is taking the place of
   *  (`activeGlasshouseRect()`, read at the click). The pane paints its first
   *  frame at that box and then transitions to its own geometry, so a handoff
   *  between two different Glasshouse surfaces reads as ONE pane growing rather
   *  than one pane replaced by another. Affects the first frame only: drag,
   *  resize, the persisted position and every clamp are untouched, and
   *  `prefers-reduced-motion` skips straight to the destination. Desktop only —
   *  the mobile sheet is full-screen and has no box to grow from. */
  enterFrom?: PaneRect | null;
  /** Stable id for this surface; when set, the pane remembers its dragged spot
   *  (and, when resizable, its size) in localStorage between appearances. Omit to
   *  drag without persisting. */
  persistKey?: string;
  /** Add a bottom-right stretch handle so the pane can be resized (the writers).
   *  `maxWidth` then seeds the default width but no longer caps it. */
  resizable?: boolean;
  /** Default the pane to the full available height (top gutter → the window
   *  bottom, whose gutter `coverNavChrome` additionally collapses) instead of
   *  sizing to its content — for immersive reading panes. Only a default: a persisted resized height
   *  (the user stretched it smaller) still wins. No effect on the mobile sheet. */
  fillHeight?: boolean;
  /** Immersive mode — the reader's, the article editor's and the note
   *  composer's, and no other pane's: the pane may extend over the desktop nav
   *  BAR all the way to the window's top edge (its gutter collapses to the
   *  edge), so it can be stretched to the whole window. Requires the caller to
   *  also un-mount the bar + muster while open (WorkspaceView gates both on
   *  `readerOpen || editorOpen || composerOpen`; LayoutShell drops
   *  PublicNavBar for the global ComposeOverlay) — only the z-60 ∀ lockup
   *  floats above. With the chrome back along
   *  the TOP (NavBar.tsx) the flag buys VERTICAL room again: every pane already
   *  reaches both side edges and the window bottom. No effect on mobile. */
  coverNavChrome?: boolean;
  /** When this Glasshouse was launched from a specific feed (reader / profile
   *  opened off a card), the feed's WALLS colour (`palette.walls`, a
   *  `var(--ah-…)` string). The pane then frames itself with an INVERTED, thinner
   *  echo of that feed's vessel: a top bar + narrow side rules in that colour,
   *  open at the bottom — so the surface visibly belongs to the feed it came
   *  from. Omit for feed-agnostic surfaces. */
  frameColor?: string | null;
  /** Contrast tone for the skip-ear arrows on the frame (`palette.barText`).
   *  Falls back to bone when omitted. Only meaningful alongside `sideNav`. */
  frameTextColor?: string | null;
  /** Reserve a seam at the pane's top edge for a body that scrolls flush under
   *  the pinned chrome (the reader). The pane clips but doesn't pad, so prose
   *  scrolls straight under the drag grip and collides with it. This paints a
   *  short band of the pane's OWN background across the top — opaque behind the
   *  grip, fading to nothing below it — so text dissolves into the page before
   *  it reaches the furniture instead of running behind it. Invisible at rest
   *  (it is the pane colour, over the body's own top padding); it only does work
   *  once content moves under it. Desktop only — it exists for the grip, and the
   *  mobile full-screen sheet has none. */
  topSeam?: boolean;
  /** Override the ⊓ side rules' thickness. The default 4 is the reader's
   *  deliberately THINNER echo of the vessel; the profile pane passes the
   *  vessel's own `VESSEL_WALL` (8) because it is not echoing a feed there, it
   *  is being one (PROFILE-PANE-REDESIGN-ADR §9.2). A caller that widens this
   *  must widen its content inset to match, or the wall lands on the cards. */
  frameSideWidth?: number;
  /** This pane paints its OWN top band (the profile's tier-1 bar), so the ⊓
   *  frame's top STROKE would only draw a second, thinner bar over it. The side
   *  rules are unchanged — the frame becomes a slot rather than a stroke
   *  (PROFILE-PANE-REDESIGN-ADR W3). Only meaningful alongside `frameColor`. */
  frameTopSlot?: boolean;
  /** Suppress the pane's built-in floating ✕, because the body renders its own
   *  inside a coloured header band (PROFILE-PANE-REDESIGN-ADR D10: the shared ✕
   *  is `text-grey-600 hover:text-black`, styled for the white pane it has
   *  always floated over, and it is low-contrast at rest and hovers DARKER on a
   *  dark band). Licensed by the COLOURED BAND, not by the pane: the profile,
   *  reader and About panes are the three callers and there is no fourth
   *  without one — a pane with a white body has no reason to hide the shared
   *  control, and the canonical-close rule (web/CLAUDE.md) is otherwise
   *  absolute. Distinct from the disc suppression below, which takes the ✕ away
   *  ENTIRELY rather than re-parenting it. */
  hideClose?: boolean;
  /** Nominate a region of the body as a DECLARED drag handle, and suppress the
   *  grip pill in the same breath — a pane has one drag affordance, and two
   *  would be furniture arguing with itself.
   *
   *  Why the two are one prop: the grip exists because bare-chrome-only leaves
   *  a target the user has to hunt for. A caller that supplies a visible bar
   *  has answered that, and one that supplies neither must keep the grip; the
   *  half-lit third state (a declared handle AND the pill) is the one nobody
   *  wants, so it isn't expressible. The selector is handed to `isDragSurface`
   *  as its `handleSelector` — controls and links inside the region still win,
   *  because the walk hits NO_DRAG_SELECTOR first — and the caller owns the
   *  cursor (the profile bar sets `grab`/`grabbing` in globals.css §1e).
   *
   *  The profile pane is the only caller (PROFILE-PANE-REDESIGN-ADR Q5, judged
   *  on screen 2026-08-28: the grip is a light pill floating in the middle of
   *  the tier-1 band and reads as a fleck on it). Measured before removing it,
   *  because the ADR's premise for expecting it to go was WRONG: the bar is not
   *  "an isDragSurface no-op region except for the buttons" — the h1 is a block
   *  element spanning the row, so bare-chrome dragging was only the padding
   *  strips and the flex gaps. Without a declared handle the pill's removal
   *  would have left the affordance to accident. */
  dragHandleSelector?: string;
  /** Feed-skip "ears": half-circle tabs on the pane's left/right edges that step
   *  through the launching feed's articles in place (the reader's up/down skip).
   *  Rendered only when `frameColor` is set (the ears take its colour) and not
   *  on the mobile full-screen sheet. Omit for surfaces without feed navigation. */
  sideNav?: {
    onPrev: () => void;
    onNext: () => void;
    canPrev: boolean;
    canNext: boolean;
  } | null;
  /** This overlay manages its OWN browser history (it pushes a canonical URL and
   *  listens for popstate itself — the reader / profile / surface stores). Such
   *  overlays opt out of the built-in mobile back-guard, which would otherwise
   *  double-push a sentinel. Default false: the in-memory overlays (Messages,
   *  Dashboard, composers, …) rely on the guard so a mobile Back/edge-swipe
   *  closes the sheet instead of leaving the site. */
  selfHistory?: boolean;
  children: React.ReactNode;
}

export function Glasshouse({
  onClose,
  onSupersede,
  maxWidth,
  ariaLabel,
  enterFrom,
  persistKey,
  resizable,
  fillHeight,
  coverNavChrome,
  frameColor,
  frameTextColor,
  frameSideWidth = FRAME_SIDE,
  frameTopSlot,
  topSeam,
  hideClose,
  dragHandleSelector,
  sideNav,
  selfHistory,
  children,
}: GlasshouseProps) {
  // On the mobile workspace (MOBILE-LAYOUT-ADR §III) every Glasshouse is a
  // full-screen sheet: same chrome, same one-at-a-time/Escape/scroll-lock
  // semantics, but the pane fills the viewport and drag/resize (pointer-
  // spatial affordances) don't render. Presentation only — callers are
  // untouched.
  const isMobile = useIsMobile();
  // The ∀ disc standing in as this sheet's X (mobile workspace only). It is
  // declared, not inferred — see the close button below.
  const discClose = useDiscCloseActive();
  const pane = usePanePlacement(
    maxWidth,
    persistKey,
    resizable,
    isMobile,
    fillHeight,
    coverNavChrome,
  );

  // THE HANDOFF GROWS; IT DOES NOT CUT. When one Glasshouse surface opens in
  // the place of another (the note composer → the article editor), the two are
  // different components and therefore different DOM nodes: nothing about the
  // swap can be a CSS transition on its own, so a pane that simply mounts at
  // its own geometry reads as the first pane being destroyed and a second one
  // built. `enterFrom` paints the first frame at the OUTGOING pane's box and
  // moves to this pane's real geometry on the next frame, which is the whole
  // illusion — one window, growing.
  //
  // Only `left/top/width/height` transition. `--gh-h` and `--ah-measure` are
  // published at their FINAL values throughout, so the body inside is laid out
  // once, at the size it will keep, and the growing pane (overflow-hidden)
  // reveals it. Animating those too would reflow the prose on every frame — the
  // measure column would narrow and the text re-wrap, which is the one thing a
  // reader's eye cannot ignore.
  //
  // `prefers-reduced-motion` drops the MOTION, not the arrival: the pane simply
  // mounts at its destination. Read once, at mount — this is a single gesture's
  // worth of animation, not a standing behaviour to keep in sync with the query.
  const enterRect = isMobile ? null : (enterFrom ?? null);
  const [entering, setEntering] = useState(
    () => !!enterRect && !prefersReducedMotion(),
  );
  const [morphing, setMorphing] = useState(entering);
  const rafRef = useRef<number | null>(null);

  useEffect(() => {
    if (!entering) return;
    // TWO frames. The first commits the entry box; the second commits the
    // destination with the transition armed. One rAF is not enough — a style
    // change made in the same frame as the node's insertion is coalesced with
    // it, and the pane snaps to the destination having never been anywhere
    // else.
    const a = requestAnimationFrame(() => {
      rafRef.current = requestAnimationFrame(() => setEntering(false));
    });
    return () => {
      cancelAnimationFrame(a);
      if (rafRef.current != null) cancelAnimationFrame(rafRef.current);
    };
    // Mount-only: `entering` goes true→false once and never back.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // The transition comes OFF once the morph has played. Left permanently on,
  // these four properties would make every drag and every stretch lag the
  // pointer by the transition's duration.
  useEffect(() => {
    if (entering || !morphing) return;
    const t = setTimeout(() => setMorphing(false), ENTER_MS + 40);
    return () => clearTimeout(t);
  }, [entering, morphing]);

  // Mobile back-guard: on the full-screen sheet, a browser Back / OS edge-swipe
  // should close this sheet (same as the disc-X), not leave the site. URL-synced
  // overlays manage their own history (`selfHistory`) and opt out. Desktop is
  // untouched — it has explicit ✕ affordances and no edge-swipe-back.
  useBackGuard(isMobile && !selfHistory, onClose);

  // Measured on-screen pane height — used only to vertically centre the skip
  // ears on the pane (its height is content-driven unless resized, so it can't
  // be derived from props). Tracks live as content / drag / resize change it.
  const [paneH, setPaneH] = useState(0);
  useEffect(() => {
    const el = pane.paneRef.current;
    if (!el) return;
    const ro = new ResizeObserver(() => setPaneH(el.offsetHeight));
    ro.observe(el);
    setPaneH(el.offsetHeight);
    return () => ro.disconnect();
  }, [pane.paneRef]);

  // The skip ears render only when the pane is framed (they take the frame
  // colour) and not on the mobile full-screen sheet (they'd fall off-screen).
  const showEars = !!frameColor && !!sideNav && !isMobile && paneH > 0;
  const earArrowColor = frameTextColor ?? "var(--ah-bone)";

  // While an Explain program is up, the pointer-events-none chrome (the frame
  // strips, a dimmed ear) is made hit-testable so its `data-explain` tags
  // resolve under the cursor — elementsFromPoint skips pointer-events:none
  // elements. Zero live-behaviour change: Explain's scrim (z-57 in pane mode)
  // intercepts every real pointer event for exactly the same window.
  const explainActive = useExplain((s) => s.isActive);

  // Whole-pane drag: grab the window by any empty/margin part of it. Bails on
  // interactive controls, selectable text, and scrollbar gutters (see
  // isDragSurface) so prose stays highlightable and controls stay live. The
  // explicit grip stays as a discoverable affordance. Disabled on the mobile
  // full-screen sheet (startDrag is null there).
  // CLICK-OUTSIDE-TO-CLOSE MEANS THE PRESS STARTED OUTSIDE, NOT ONLY THAT IT
  // ENDED THERE. A `click` is dispatched on the nearest common ancestor of the
  // pointerdown and pointerup targets — so dragging a text selection from
  // inside the pane and releasing over the backdrop dispatches `click` on the
  // WRAPPER, whose handler then closed the pane (and, for a URL-synced overlay,
  // popped history). Selecting a quotation out of an article was enough to lose
  // the reader; the pane's own `stopPropagation` cannot help, because the event
  // never passes through the pane at all.
  //
  // The flag is set from the backdrop's own pointerdown: a press inside the
  // pane still BUBBLES to it, with `target !== currentTarget`, so it correctly
  // records "this gesture did not start on the backdrop".
  const downOnBackdropRef = useRef(false);
  const notePointerDown = (e: React.PointerEvent) => {
    downOnBackdropRef.current = e.target === e.currentTarget;
  };
  const closeOnBackdropClick = (e: React.MouseEvent) => {
    if (e.target !== e.currentTarget) return;
    if (!downOnBackdropRef.current) return;
    onClose();
  };

  const onPanePointerDown = (e: React.PointerEvent) => {
    // A gesture beats the morph: a drag begun mid-transition would otherwise
    // follow the pointer a beat late for the rest of ENTER_MS.
    if (morphing) setMorphing(false);
    if (e.button !== 0 || !pane.startDrag) return;
    const paneEl = pane.paneRef.current;
    if (!paneEl) return;
    if (
      !isDragSurface(
        e.target as Element,
        paneEl,
        e.clientX,
        e.clientY,
        dragHandleSelector,
      )
    )
      return;
    pane.startDrag(e);
  };

  // Keep the supersede handler fresh (callers pass inline closures) without
  // re-running the register-on-mount effect.
  const tokenRef = useRef<object>({});
  const supersedeRef = useRef<() => void>(() => {});
  supersedeRef.current = onSupersede ?? onClose;
  // Kept fresh for the presence registry's `close()` (the disc-X minimise on
  // mobile) — the same close the pane's own ✕ and Escape fire.
  const closeRef = useRef<() => void>(() => {});
  closeRef.current = onClose;

  // Register as the active Glasshouse on mount and supersede the prior one;
  // release the slot on unmount (only if we still hold it).
  useEffect(() => {
    const token = tokenRef.current;
    const prev = activeGlasshouse;
    activeGlasshouse = {
      token,
      supersede: () => supersedeRef.current(),
      rect: () => {
        const el = pane.paneRef.current;
        if (!el) return null;
        const r = el.getBoundingClientRect();
        return { x: r.left, y: r.top, w: r.width, h: r.height };
      },
    };
    if (prev && prev.token !== token) prev.supersede();
    // Mirror into the subscribable presence registry so the ∀ disc can act as the
    // minimise-X for this sheet (mobile). Token-guarded like the module var so a
    // superseded pane's unmount never clobbers its successor's slot.
    useGlasshousePresence.getState()._set(() => closeRef.current());
    return () => {
      if (activeGlasshouse && activeGlasshouse.token === token) {
        activeGlasshouse = null;
        useGlasshousePresence.getState()._set(null);
        // The last pane went — if the address still names a suspended one,
        // put it back (see scheduleAddressedPaneHandback).
        scheduleAddressedPaneHandback();
      }
    };
    // `paneRef` is a `useRef` object — stable for the life of the component —
    // so this stays a mount-only effect despite the dep.
  }, [pane.paneRef]);

  // Escape closes; lock body scroll while the Glasshouse is mounted.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onKey);
    const prevOverflow = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    return () => {
      window.removeEventListener("keydown", onKey);
      document.body.style.overflow = prevOverflow;
    };
  }, [onClose]);

  // `\` toggles this pane between the user's custom arrangement and the default
  // placement — the pane-scoped mirror of the workspace floor's regimented `\`
  // (which WorkspaceView leaves inert while a Glasshouse is open, guarding on the
  // presence registry, so the two never both fire). Desktop only: the mobile
  // full-screen sheet has no movable placement (toggleDefault is null there).
  // Guarded like the floor binding — no modifiers, not in an editable field, not
  // while Explain or the lightbox (z-70, above the pane) owns the keyboard.
  const toggleDefault = pane.toggleDefault;
  useEffect(() => {
    if (isMobile || !toggleDefault) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== "\\") return;
      if (e.metaKey || e.ctrlKey || e.altKey || e.shiftKey) return;
      const t = e.target as HTMLElement | null;
      if (
        t?.closest(
          'input, textarea, select, [contenteditable=""], [contenteditable="true"]',
        )
      )
        return;
      if (useExplain.getState().isActive) return;
      if (useLightbox.getState().isOpen) return;
      e.preventDefault();
      toggleDefault();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [isMobile, toggleDefault]);

  return (
    <>
      {/* Frosted scrim — click to close. `.gh-scrim` (globals.css) blurs AND
          desaturates + washes the backdrop toward the mode's neutral ground, so
          the fixed parchment pane always meets the same field whatever per-feed
          scheme is behind (GLASSHOUSE-AND-PALETTE-ADR §III.1 — separation is the
          scrim's job, identity is the pane's). z-[55] sits above the workspace
          (so it blurs) but below the ForallMenu (z-60).

          IT STARTS AT THE BAR'S OPTICAL EDGE, NOT THE VIEWPORT'S TOP, and the
          number is `NAV_BAR_BAND`, the same line both Explain scrims and the
          pane's own y floor take — the rule is *a dimming layer must not draw
          an edge the design depends on not having* (web/CLAUDE.md), and this
          is the sweep that section says had not been done. Two separate
          artefacts came off
          `inset: 0`, both of them right under the bar and both invisible in a
          diff. The bar is opaque `bone` at z-58, so its own 48px was never
          being dimmed anyway; what WAS being dimmed is the floor's 8px top
          buffer beneath it, which put the band's true bottom edge on screen —
          the same seam, and the same falsified premise, as one surface over.
          And a backdrop filter samples across its own box, so the blur dragged
          the white page ground behind the bar down over the join as a soft pale
          ramp: a coarse greyscale gradient hanging under the bar for ~14px,
          which is exactly the width of the gutter between the bar and a pane at
          its default y. Clipping the scrim to the band ends both.

          Nothing is lost by the cut — the opaque bar already ate every click
          in that strip, and this scrim sits at z-55, UNDER the pane, so it
          never dims a pane at all. (The Explain pane-mode scrim, which sits
          ABOVE the pane, once kept `inset: 0` so a pane dragged flush to the
          bar stayed dimmed to its top; the pane's y floor is now the band
          itself, so that exception is gone too.) Full viewport when
          there is no bar standing: the mobile sheet, and the three immersive
          panes — the reader, the article editor and the note composer — which
          un-mount the bar (`coverNavChrome`). */}
      <div
        className="fixed inset-x-0 bottom-0 z-[55] gh-scrim"
        style={{ top: isMobile || coverNavChrome ? 0 : NAV_BAR_BAND }}
        onPointerDown={notePointerDown}
        onClick={closeOnBackdropClick}
      />

      {/* Pane wrapper — click outside the pane closes. */}
      <div
        className="fixed inset-0 z-[56]"
        onPointerDown={notePointerDown}
        onClick={closeOnBackdropClick}
      >
        <div
          ref={pane.paneRef}
          role="dialog"
          aria-modal="true"
          aria-label={ariaLabel}
          // The surface that is on top owns a wheel over it, even when it has
          // nothing of its own to scroll — `useForwardedWheel` would otherwise
          // read "not inside the fitted column" as "in the page's margins" and
          // move the page underneath (`hooks/useForwardedWheel.ts`).
          data-overlay-surface=""
          // The Explain engine's pane-mode root (EXPLAIN-ADR, D10 reversal
          // 2026-07-15): every Glasshouse is explainable as a pane, and this
          // tag answers any interior hover a more specific `data-explain` leaf
          // doesn't. Inert outside an active pane-mode Explain program.
          data-explain="pane"
          onPointerDown={onPanePointerDown}
          className="absolute bg-glasshouse shadow-lg overflow-hidden"
          // `--gh-h` is the on-screen height available to the body — it tracks the
          // drag position (and an explicit resized height), so each body sizes its
          // own scroll region against it (`max-h-[var(--gh-h)]` / `h-[var(--gh-h)]`)
          // instead of a fixed 100vh. The pane itself clips (overflow-hidden) so the
          // pinned chrome never scrolls; the body owns the scroll. `height` is set
          // only when the pane was stretched vertically; otherwise content-driven.
          style={
            {
              // The entry box on the first frame only (`enterFrom`); the pane's
              // real geometry from the second on, with the transition armed for
              // one beat so the change of shape is seen rather than cut to.
              // `maxHeight`/`--gh-h`/`--ah-measure` stay at their final values
              // throughout — the body is laid out once and revealed, never
              // re-wrapped mid-morph.
              left: entering && enterRect ? enterRect.x : pane.x,
              top: entering && enterRect ? enterRect.y : pane.y,
              width: entering && enterRect ? enterRect.w : pane.width,
              height:
                entering && enterRect
                  ? enterRect.h
                  : (pane.height ?? undefined),
              transition: morphing
                ? `left ${ENTER_MS}ms ease-out, top ${ENTER_MS}ms ease-out, width ${ENTER_MS}ms ease-out, height ${ENTER_MS}ms ease-out`
                : undefined,
              maxHeight: pane.ghH,
              "--gh-h": `${pane.ghH}px`,
              // `--ah-measure` is the width a column of prose takes inside this
              // pane — the rest measure until the member stretches it, then a
              // decreasing share of each further pixel (lib/workspace/measure.ts).
              // Consumed by `.ah-measure` (globals.css); surfaces outside a pane
              // get the class's own fallback and are unaffected.
              "--ah-measure": `${pane.measure}px`,
            } as React.CSSProperties
          }
          onClick={(e) => e.stopPropagation()}
        >
          {/* Feed-launched frame — the inverted, thinner echo of the source
              feed's vessel (⊓: top bar + side rules, open at the bottom), in the
              feed's wall colour. A pointer-events-none colour overlay sitting in
              the content's top + side padding gutters, so it never disturbs the
              pane's width / scroll geometry. Below the chrome (z-10) so the grip
              and ✕ stay above the bar. Absent when frameColor is null. */}
          {frameColor && !isMobile && (
            <div
              aria-hidden
              className="pointer-events-none absolute inset-0 z-[5]"
            >
              {!frameTopSlot && (
                <div
                  data-explain="pane.frame"
                  className="absolute left-0 right-0 top-0"
                  style={{
                    height: FRAME_TOP,
                    background: frameColor,
                    pointerEvents: explainActive ? "auto" : undefined,
                  }}
                />
              )}
              <div
                data-explain="pane.frame"
                className="absolute bottom-0 left-0 top-0"
                style={{
                  width: frameSideWidth,
                  background: frameColor,
                  pointerEvents: explainActive ? "auto" : undefined,
                }}
              />
              <div
                data-explain="pane.frame"
                className="absolute bottom-0 right-0 top-0"
                style={{
                  width: frameSideWidth,
                  background: frameColor,
                  pointerEvents: explainActive ? "auto" : undefined,
                }}
              />
            </div>
          )}
          {/* Top seam — a band of the pane's own background across the top edge,
              solid behind the grip and fading to nothing below it. A flush body
              (the reader) scrolls its prose straight under the pinned chrome;
              this gives the text somewhere to go, dissolving it into the page
              rather than letting it clash with the furniture. z-[4]: above the
              body (static, in flow) but below the feed frame's colour bar (z-5)
              and the chrome (z-10), so it hides neither. Desktop only — gated on
              `pane.startDrag`, which is exactly "there is a grip to clear" (a
              pane that declares its own handle has no grip, so it would want no
              seam either; no caller does both, and the profile pane — the one
              handle-declaring caller — passes neither). */}
          {topSeam && pane.startDrag && (
            <div
              aria-hidden
              className="pointer-events-none absolute left-0 right-0 top-0 z-[4]"
              style={{
                height: SEAM_H,
                background: `linear-gradient(to bottom, var(--ah-glasshouse) 0px, var(--ah-glasshouse) ${SEAM_SOLID}px, transparent ${SEAM_H}px)`,
              }}
            />
          )}

          {/* Drag handle — a grip pill, top-centre, pinned over the content.
              4px tall — a grip glyph, not a thin rule. Discoverable affordance
              for the whole-pane drag (the pane body drags too via
              onPanePointerDown). Absent on the mobile full-screen sheet, and on
              a pane that declares its own handle (`dragHandleSelector`). */}
          {pane.startDrag && !dragHandleSelector && (
            <div
              onPointerDown={pane.startDrag}
              role="button"
              aria-label="Drag to move"
              title="Drag to move"
              className="absolute left-1/2 top-3.5 z-10 h-1 w-9 -translate-x-1/2 rounded-full bg-grey-300 hover:bg-grey-600"
              style={{ cursor: "grab", touchAction: "none" }}
            />
          )}

          {/* Close — floats top-right over the pane content. Suppressed for a
              body that renders its own ✕ against a ground it was coloured for
              (the profile pane's tier 1 — see `hideClose`), and on the mobile
              workspace, where the ∀ disc has already flipped to this sheet's X
              and a second one is furniture arguing with itself. That second
              gate is a DECLARATION by the disc, never `isMobile` — this pane
              opens on routes the disc does not reach (see
              stores/glasshouse.ts::useDiscCloseActive). */}
          {!hideClose && !discClose && (
            <button
              type="button"
              onClick={onClose}
              aria-label="Close"
              className="absolute right-4 top-4 z-10 text-grey-600 hover:text-black text-lg leading-none"
              style={{ background: "none", border: "none", cursor: "pointer" }}
            >
              ✕
            </button>
          )}

          {children}

          {/* Stretch handle — bottom-right corner, a 2px L-glyph (not a thin
              rule). Mirrors the vessel resize. Only on resizable panes. */}
          {pane.startResize && (
            <div
              role="button"
              aria-label="Resize"
              title="Drag to resize"
              data-explain="pane.resize"
              onPointerDown={pane.startResize}
              className="absolute z-10 text-grey-600"
              style={{
                right: 6,
                bottom: 4,
                width: 16,
                height: 16,
                cursor: "nwse-resize",
                touchAction: "none",
              }}
            >
              <span
                className="absolute block"
                style={{
                  right: 3,
                  bottom: 3,
                  width: 8,
                  height: 8,
                  borderRight: "2px solid currentColor",
                  borderBottom: "2px solid currentColor",
                  opacity: 0.6,
                }}
              />
            </div>
          )}
        </div>

        {/* Skip ears — half-circle tabs appended to the pane's left/right edges,
            each a triangular arrow that steps through the launching feed's
            articles in place. Siblings of the pane (not children), so they
            protrude past its overflow-hidden clip. Left = previous article (◀,
            up the feed); right = next article (▶, down the feed). The colour is
            the frame colour; a step that's unavailable dims its ear. */}
        {showEars && sideNav && (
          <>
            <button
              type="button"
              aria-label="Previous article"
              title="Previous article"
              data-explain="pane.ear.prev"
              disabled={!sideNav.canPrev}
              onClick={(e) => {
                e.stopPropagation();
                sideNav.onPrev();
              }}
              className="absolute z-10 flex items-center justify-center focus-ring"
              style={{
                left: pane.x - EAR_R,
                top: pane.y + paneH / 2 - EAR_R,
                width: EAR_R,
                height: EAR_R * 2,
                borderRadius: `${EAR_R}px 0 0 ${EAR_R}px`,
                background: frameColor ?? undefined,
                border: "none",
                cursor: sideNav.canPrev ? "pointer" : "default",
                opacity: sideNav.canPrev ? 1 : 0.3,
                // A dimmed ear passes clicks through to the wrapper (close);
                // during Explain it stays hit-testable so its label resolves.
                pointerEvents:
                  sideNav.canPrev || explainActive ? "auto" : "none",
              }}
            >
              <span
                aria-hidden
                style={{
                  width: 0,
                  height: 0,
                  borderTop: `${EAR_ARROW}px solid transparent`,
                  borderBottom: `${EAR_ARROW}px solid transparent`,
                  borderRight: `${EAR_ARROW}px solid ${earArrowColor}`,
                }}
              />
            </button>
            <button
              type="button"
              aria-label="Next article"
              title="Next article"
              data-explain="pane.ear.next"
              disabled={!sideNav.canNext}
              onClick={(e) => {
                e.stopPropagation();
                sideNav.onNext();
              }}
              className="absolute z-10 flex items-center justify-center focus-ring"
              style={{
                left: pane.x + pane.width,
                top: pane.y + paneH / 2 - EAR_R,
                width: EAR_R,
                height: EAR_R * 2,
                borderRadius: `0 ${EAR_R}px ${EAR_R}px 0`,
                background: frameColor ?? undefined,
                border: "none",
                cursor: sideNav.canNext ? "pointer" : "default",
                opacity: sideNav.canNext ? 1 : 0.3,
                pointerEvents:
                  sideNav.canNext || explainActive ? "auto" : "none",
              }}
            >
              <span
                aria-hidden
                style={{
                  width: 0,
                  height: 0,
                  borderTop: `${EAR_ARROW}px solid transparent`,
                  borderBottom: `${EAR_ARROW}px solid transparent`,
                  borderLeft: `${EAR_ARROW}px solid ${earArrowColor}`,
                }}
              />
            </button>
          </>
        )}
      </div>
    </>
  );
}
