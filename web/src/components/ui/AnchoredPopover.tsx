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
//
// IT PORTALS, SO IT HAS TO MANAGE FOCUS ITSELF. This is the one cost of leaving
// the pane, and it is easy to miss because everything else about the panel looks
// right. An `absolute` panel sat NEXT IN DOM ORDER after its trigger, so Tab from
// the trigger walked straight into it and the browser did the work. Portalled to
// `document.body` the panel is elsewhere in the document entirely: Tab from the
// trigger goes to the next control in the BAR, and a keyboard reader who opens
// the report form cannot reach the form. So the panel takes a `role`, focus MOVES
// into it on open, and focus RETURNS to the trigger on dismiss — the last of
// those being the part that is invisible when you test with a mouse, and the part
// that decides whether Escape leaves you where you were or at the top of the
// document.
//
// The role is the CALLER'S to state, because only the caller knows what it built:
// `ReportButton` opens a form (`dialog`, and a dialog needs a name, hence
// `ariaLabel`), `ShareButton` opens a list of actions (`menu`). It defaults to
// `dialog` — the safer of the two, since `menu` makes a screen reader promise
// arrow-key navigation this primitive does not implement.
//
// GROUND AND LIFT ARE ONE DECISION, taken by the `over` prop — see its doc
// comment. A popover over a READING SURFACE cannot be glasshouse: that token
// and `white` are the same value in light mode, so the panel is white on white
// and reads as pale nothing however good its shadow.
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
/** First stop for focus when the panel opens. */
const FOCUSABLE =
  'a[href],button:not([disabled]),input:not([disabled]):not([type="hidden"]),select:not([disabled]),textarea:not([disabled]),[tabindex]:not([tabindex="-1"])';

export function AnchoredPopover({
  anchorRef,
  open,
  onDismiss,
  align = "end",
  width,
  over = "scrim",
  role = "dialog",
  ariaLabel,
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
  /**
   * WHAT THIS POPOVER IS FLOATING OVER. One prop, because ground and lift are
   * one decision (web/CLAUDE.md › *Floating material*), and answering half of
   * it is what leaves a panel looking like a hole in the page.
   *
   * `scrim` (default) — over a frosted scrim, the bone floor, anything with a
   * colour step already between the panel and its ground. `bg-glasshouse`, the
   * top of the elevation ladder, and `shadow-lg` to finish a separation the
   * step has already made.
   *
   * `paper` — over a READING SURFACE. `--ah-white` and `--ah-glasshouse` are
   * BOTH 255 in light mode, so there is no step to make and no rung above
   * glasshouse to climb to: a glasshouse panel there is white-on-white and
   * reads as pale nothing however good its shadow. So the panel goes DOWN the
   * ladder instead, to `grey-100` — the registry's own soft panel fill — and
   * takes `.ah-lift` (the house's lifted-paper figure) rather than `shadow-lg`.
   *
   * `grey-100` is the one token that works in both directions, which is why it
   * and not `glasshouse-well` or `bone`: light `#F2F1ED` sits below white, and
   * dark `42 41 37` sits ABOVE the reading surface's `30 29 26` — a bigger step
   * than glasshouse's own 35. The two tokens that read correctly in light
   * (`glasshouse-well` 26, `bone` 20) both invert to DARKER than the surface,
   * which paints the panel as a hole.
   *
   * It is a prop and not a `className` because neither half can be overridden
   * from outside: two background utilities of equal specificity are settled by
   * stylesheet order rather than class order, and `.ah-lift` sits in
   * `@layer components` where the `shadow-lg` utility beats it outright.
   */
  over?: "scrim" | "paper";
  /**
   * What the panel IS, for a screen reader. `dialog` (the default) suits a form
   * or a panel of controls; `menu` suits a list of actions — but only say `menu`
   * if arrow-key navigation is genuinely there, since the role promises it.
   * Whatever the trigger's `aria-haspopup` says, this should agree with it.
   */
  role?: "dialog" | "menu";
  /** The accessible name. A `dialog` without one is announced as just "dialog". */
  ariaLabel?: string;
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

  // FOCUS IN ON OPEN, FOCUS BACK ON CLOSE.
  //
  // In: the first focusable thing in the panel, or the panel itself (it carries
  // `tabIndex={-1}` for exactly this) when there is nothing to focus — a report
  // receipt is prose with no control in it, and leaving focus behind on the
  // trigger there would announce nothing at all.
  //
  // Back: to whatever had focus when the panel opened, which is the trigger in
  // every current caller but is captured rather than assumed. It is skipped when
  // focus has already MOVED somewhere else of the user's own accord — dragging
  // focus back from wherever they went would be worse than doing nothing — and
  // guarded on the node still being in the document, since a popover can outlive
  // a trigger that re-rendered under it.
  //
  // IT KEYS ON `pos`, NOT ON `open`, AND THAT IS THE WHOLE OF IT WORKING. The
  // panel renders `visibility: hidden` until it has been measured (one pre-paint
  // frame, so it never paints at 0,0 and jumps) — and a `visibility: hidden`
  // element CANNOT TAKE FOCUS. Keyed on `open` alone this ran against the hidden
  // frame, every `.focus()` was a no-op, and the panel came up with focus still
  // on the trigger: a change that looks right in the code, ships the role and the
  // label correctly, and does nothing at all. Found by driving it, which is the
  // only way it could have been found. `measured` is a boolean rather than `pos`
  // itself so a scroll — which mints a new `pos` object every frame — does not
  // re-run it and yank focus back.
  const restoreRef = useRef<HTMLElement | null>(null);
  const measured = pos !== null;
  useEffect(() => {
    if (!open || !measured) return;
    restoreRef.current = (document.activeElement as HTMLElement) ?? null;
    const panel = panelRef.current;
    if (!panel) return;
    const first = panel.querySelector<HTMLElement>(FOCUSABLE);
    (first ?? panel).focus({ preventScroll: true });
    return () => {
      const back = restoreRef.current;
      restoreRef.current = null;
      if (!back || !back.isConnected) return;
      const active = document.activeElement;
      if (active && active !== document.body && !panel.contains(active)) return;
      back.focus({ preventScroll: true });
    };
  }, [open, measured]);

  // Escape via the shared shield, so it closes this menu and not the host
  // Glasshouse under it (`.claude/rules/web-overlays.md` › Escape on a popover
  // over a Glasshouse).
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
      role={role}
      aria-label={ariaLabel}
      tabIndex={-1}
      className={`${over === "paper" ? "bg-grey-100 ah-lift" : "bg-glasshouse shadow-lg"} focus:outline-none ${className}`}
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
