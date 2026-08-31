"use client";

// =============================================================================
// AnchoredPopover — the one home for a menu that hangs off a control INSIDE a
// clipping surface.
//
// The problem it exists for: a `position: absolute` dropdown is clipped by the
// nearest ancestor that hides overflow, and inside a Glasshouse there are two —
// the pane itself (`overflow-hidden`, which is what gives it its edge) and the
// body's own scroll region. It is also trapped in that ancestor's stacking
// context, so the pane's ⊓ frame (z-5) paints over it however high its own
// z-index goes. The profile's "Following ▾" menu met all three: it opened
// rightwards from a right-aligned button, ran 92px past the pane's right edge,
// and was sliced off mid-word by the wall.
//
// So the menu leaves the pane. It portals to `document.body` and positions
// itself `fixed` against the anchor's measured rect, which is what
// `web/CLAUDE.md` already claimed of these menus ("floating material is the
// outermost layer") and what `AuthorModal` already does one surface over.
//
// THE LAYER IS 57, AND THE NUMBER IS LOAD-BEARING: above the Glasshouse pane
// (56) so the frame cannot paint over it, below the mobile top bar (58) and the
// ∀ menu (60), which stay the outermost chrome. See Glasshouse's header for the
// register.
//
// It re-measures on scroll and resize rather than assuming: the anchor sits in
// a sticky bar inside a scroller, and the host pane is draggable.
// =============================================================================

import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  type ReactNode,
  type RefObject,
} from "react";
import { createPortal } from "react-dom";
import { useEscapeShield } from "../../hooks/useEscapeShield";

/** Gap between the anchor and the panel. */
const OFFSET = 4;
/** Keep the panel this far off the viewport edges when clamping. */
const VIEWPORT_MARGIN = 8;

export function AnchoredPopover({
  anchorRef,
  open,
  onDismiss,
  align = "end",
  width,
  className = "",
  children,
}: {
  /** The control the panel hangs off. Also the outside-click exemption, so a
   *  second click on the trigger toggles rather than dismiss-then-reopen. */
  anchorRef: RefObject<HTMLElement | null>;
  open: boolean;
  /** Escape, outside pointerdown, or a scroll that takes the anchor away. */
  onDismiss: () => void;
  /** Which edge the panel aligns to. `end` (the default) opens LEFTWARDS from
   *  the anchor's right edge, which is what a control at the right end of a bar
   *  wants; `start` opens rightwards. Either way the result is clamped into the
   *  viewport, so alignment is a preference and never a guarantee. */
  align?: "start" | "end";
  width: number;
  className?: string;
  children: ReactNode;
}) {
  const panelRef = useRef<HTMLDivElement | null>(null);
  const [pos, setPos] = useState<{
    left: number;
    top: number;
    maxHeight: number;
  } | null>(null);

  const measure = useCallback(() => {
    const anchor = anchorRef.current;
    if (!anchor) return;
    const a = anchor.getBoundingClientRect();
    // scrollHeight, NOT offsetHeight: the panel may already be carrying a
    // maxHeight from the previous pass, and deciding off the CAPPED height
    // would make the decision depend on its own last output — it would settle
    // wherever it first landed and never re-flip. scrollHeight is the content's
    // natural height either way.
    const wanted = panelRef.current?.scrollHeight ?? 0;

    let left = align === "end" ? a.right - width : a.left;
    left = Math.min(
      Math.max(VIEWPORT_MARGIN, left),
      Math.max(VIEWPORT_MARGIN, window.innerWidth - width - VIEWPORT_MARGIN),
    );

    // Below by preference, above when it fits there and not below, and — when
    // it fits NEITHER — on the roomier side with the panel CAPPED so it scrolls
    // inside itself. That last branch is not an edge case: the follow picker
    // lists one row per feed, so a member with enough feeds overflows at any
    // window height, and a short window overflows with any number of them.
    // Running off the bottom of the screen is the same failure as running off
    // the side, and clamping the position alone cannot fix it.
    const roomBelow = window.innerHeight - a.bottom - OFFSET - VIEWPORT_MARGIN;
    const roomAbove = a.top - OFFSET - VIEWPORT_MARGIN;
    const goBelow = wanted <= roomBelow || roomBelow >= roomAbove;
    const maxHeight = Math.max(0, goBelow ? roomBelow : roomAbove);
    const top = goBelow
      ? a.bottom + OFFSET
      : Math.max(VIEWPORT_MARGIN, a.top - OFFSET - Math.min(wanted, maxHeight));

    setPos({ left, top, maxHeight });
  }, [anchorRef, align, width]);

  // Layout effect so the first paint is already in place — measured after the
  // panel is in the DOM, since the flip needs its height.
  useLayoutEffect(() => {
    if (!open) {
      setPos(null);
      return;
    }
    measure();
  }, [open, measure, children]);

  useEffect(() => {
    if (!open) return;
    const onScroll = () => measure();
    window.addEventListener("resize", measure);
    // Capture, so a scroll in ANY ancestor scroller reaches us (scroll does not
    // bubble). The anchor rides a sticky bar, so it usually will not have
    // moved — re-measuring anyway costs one rect read and is the difference
    // between a menu that tracks its control and one that detaches.
    window.addEventListener("scroll", onScroll, true);
    return () => {
      window.removeEventListener("resize", measure);
      window.removeEventListener("scroll", onScroll, true);
    };
  }, [open, measure]);

  // Escape via the shared shield, so it closes this menu and not the host
  // Glasshouse under it (web/CLAUDE.md › Escape on a popover over a Glasshouse).
  useEscapeShield(open, onDismiss);

  // Outside pointerdown. The panel is no longer a DOM descendant of the anchor,
  // so a `wrapRef.contains` test would fire on every click INSIDE the menu —
  // both nodes have to be exempt.
  useEffect(() => {
    if (!open) return;
    function onPointerDown(e: PointerEvent) {
      const t = e.target as Node;
      if (panelRef.current?.contains(t)) return;
      if (anchorRef.current?.contains(t)) return;
      onDismiss();
    }
    document.addEventListener("pointerdown", onPointerDown);
    return () => document.removeEventListener("pointerdown", onPointerDown);
  }, [open, onDismiss, anchorRef]);

  if (!open || typeof document === "undefined") return null;

  return createPortal(
    <div
      ref={panelRef}
      className={`bg-glasshouse shadow-lg ${className}`}
      style={{
        position: "fixed",
        left: pos?.left ?? 0,
        top: pos?.top ?? 0,
        width,
        maxHeight: pos?.maxHeight,
        overflowY: "auto",
        zIndex: 57,
        // Invisible until measured, rather than painting one frame at 0,0 and
        // jumping. It is measured in a layout effect, so this is a single
        // pre-paint frame, not a flash.
        visibility: pos ? "visible" : "hidden",
      }}
    >
      {children}
    </div>,
    document.body,
  );
}
