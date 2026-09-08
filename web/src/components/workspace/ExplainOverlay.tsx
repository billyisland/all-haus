"use client";

import React, {
  useCallback,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
} from "react";
import {
  useExplain,
  type Annotation,
  type HoverTarget,
} from "../../stores/explain";
import { useExplainRegistry } from "./ExplainProvider";
import { NAV_BAR_H, NAV_BAR_BAND } from "./NavBar";
import { GRID } from "../../lib/workspace/grid";
import {
  type ExplainKind,
  explainCardCopy,
  explainCopy,
} from "../../lib/explain/registry";
import { prefersReducedMotion } from "../../lib/workspace/motion";
import { useGlasshousePresence } from "../../stores/glasshouse";

// =============================================================================
// ExplainOverlay — the visible engine layer (EXPLAIN-ADR §5, D1, D9, D11, D12;
// 2026-07-15 post-live rework).
//
// The two programs render differently:
//   - Explain is a pure HOVER annotator: one bubble, rendered AT THE CURSOR
//     (a tooltip that follows the pointer), describing whatever is under it.
//     No pinned sequence bubble, no leader — the element-anchored placement
//     scattered bubbles across the screen and the perpetually-dimmed pinned
//     bubble read as half-triggered noise (2026-07-15 live review).
//   - First-run (launched from the welcome sheet's last step; only its D6
//     AUTO-entry is dormant) keeps the pinned stepping bubble: element-anchored
//     placement (right → left → below → above), the 2px crimson leader with a
//     4px dot at the target end, live `getBoundingClientRect` measurement
//     re-run on a ResizeObserver (floor container + the pinned target's own
//     vessel scroll container, D11), drag suspension (D11 seam), and a
//     reduced-motion path. Hover is SUPPRESSED during first-run — the tour is
//     the fixed sequence, and stray cursor bubbles over it are noise.
//
// D1 — the surface is inert for CLICKS while active: the scrim is a single
// full-viewport div that intercepts all pointer events, so nothing under it can
// be activated. Wheel scroll is NOT frozen (D1 amendment, 2026-07-16): the
// scrim forwards it to the scrollable under the cursor — pane bodies and
// vessel interiors stay readable mid-Explain — and re-resolves the hover
// after. First-run keeps the fully frozen surface (its pinned bubbles anchor
// to element rects; D11 has no scroll re-measure).
//   - pointermove → coordinate hit-test → live hover (D4).
//   - any click → dismiss (§6, 2026-07-15 form: click-pin is deleted — the
//     hover bubble is already at the cursor, so a pin adds nothing). First-run
//     ignores clicks entirely (stepper/arrows/Done only).
// Hit-test sources (D1): (a) `[data-explain]` tagged leaves via elementsFromPoint
// → closest, and (b) the registration Map's live root rects (floor / vessel)
// by element identity. The disc + About button sit ABOVE the scrim (z-60) and
// report their own hover to the store instead.
//
// PANE mode (D10 reversal, 2026-07-15 second session): when the program's
// surface is "pane", the open Glasshouse is the annotated subject — the scrim
// rises to z-57 and the cursor bubble to z-59 (above the pane's z-55/56 bands
// and the nav row's 58, under the ForallMenu's z-60), hit-testing resolves only
// `[data-explain]` tags inside the pane root, focus/ARIA freezing targets the
// pane instead of the vessels, and the pane closing (Esc, popstate) closes
// Explain with it.
// =============================================================================

// Marks the overlay's own DOM so hit-testing looks straight through it.
const CHROME_ATTR = "data-explain-chrome";

const BUBBLE_WIDTH = 300; // fixed width → predictable placement; height adapts
// Target edge → bubble gap, and the length of the crimson leader that spans it.
// WAS 14 (2026-09-04): the bubbles read as cramped against the things they
// explain — the leader too short to register as a line, so the bubble looked
// stuck to its subject rather than pointing at it. Now 3·GRID, which also puts
// it back on the lattice everything else in the workspace lives on; 14 was the
// outlier. Widening this makes a side less likely to `fit` and flip, which is
// the thing to check if a beat starts choosing a different side.
const GAP = 3 * GRID;
const MARGIN = 10; // viewport margin the bubble keeps clear
const ENTER_MS = 200; // opacity / leader-draw enter duration
const CURSOR_GAP_X = 18; // cursor → hover-bubble offset (flips to keep on-screen)
const CURSOR_GAP_Y = 22;

interface ResolvedTarget extends HoverTarget {
  el: HTMLElement;
}

export function ExplainOverlay() {
  const registry = useExplainRegistry();
  const isActive = useExplain((s) => s.isActive);
  const annotations = useExplain((s) => s.annotations);
  const index = useExplain((s) => s.index);
  const hover = useExplain((s) => s.hover);
  const dragging = useExplain((s) => s.draggingFeedId != null);
  const programKind = useExplain((s) => s.program?.kind);
  const programSurface = useExplain((s) => s.program?.surface);
  const setHover = useExplain((s) => s.setHover);
  const next = useExplain((s) => s.next);
  const prev = useExplain((s) => s.prev);
  const close = useExplain((s) => s.close);

  const isFirstRun = programKind === "firstrun";
  // PANE mode (D10 reversal, 2026-07-15 second session): the program annotates
  // the open Glasshouse, so the scrim/bubble bands rise above the pane and the
  // nav row (z-57/59, still under the ForallMenu at z-60) and hit-testing
  // resolves only tags inside the pane. First-run is always floor-surfaced.
  const paneMode = programSurface === "pane";
  const reduced = prefersReducedMotion();

  // Bumped by the ResizeObserver / window-resize so bubbles re-measure their
  // live target rect (D11). The floor is frozen (D1), so there is no scroll
  // trigger — only reflow (vessel add/remove/resize, async interior growth).
  const [measureTick, setMeasureTick] = useState(0);

  // Live cursor position for the Explain hover bubble (the bubble renders AT
  // the pointer, 2026-07-15). Tracked document-wide, capture phase, so it stays
  // fresh over the z-60 chrome (disc / About button) the scrim never sees.
  const [cursor, setCursor] = useState<{ x: number; y: number } | null>(null);
  useEffect(() => {
    if (!isActive) return;
    const onMove = (e: PointerEvent) =>
      setCursor({ x: e.clientX, y: e.clientY });
    document.addEventListener("pointermove", onMove, true);
    return () => {
      document.removeEventListener("pointermove", onMove, true);
      setCursor(null);
    };
  }, [isActive]);

  // Resolve the pointer to the most specific explainable target under it.
  // elementsFromPoint returns deepest-painted first, so a tagged leaf (a
  // descendant of its vessel root) is always found before the root — giving
  // leaf > vessel > floor precedence for free.
  const hitTest = useCallback(
    (x: number, y: number): ResolvedTarget | null => {
      if (typeof document === "undefined") return null;
      // PANE mode: the open Glasshouse is the annotated surface. Only tags
      // inside the pane root resolve — elementsFromPoint sees straight through
      // the gh-scrim to the frozen floor beneath, and a vessel label answering
      // a hover beside the pane would annotate something the user cannot even
      // see. Off-pane hovers resolve to nothing (the pane is the subject).
      if (paneMode) {
        const paneRoot = document.querySelector<HTMLElement>(
          '[data-explain="pane"]',
        );
        if (!paneRoot) return null;
        // Scope to the pane's z-56 wrapper, not the pane root alone: the skip
        // ears (C1) are SIBLINGS of the pane — they render outside its
        // overflow-hidden clip — but share the wrapper. Only explicit
        // [data-explain] tags match, and the floor's vessel/card tags live
        // outside the wrapper, so the wider scope cannot leak an annotation
        // for something hidden under the frost.
        const scope = paneRoot.parentElement ?? paneRoot;
        const stack = document.elementsFromPoint(x, y) as HTMLElement[];
        for (const el of stack) {
          if (el.closest(`[${CHROME_ATTR}]`)) continue;
          const tagged = el.closest<HTMLElement>("[data-explain]");
          if (tagged && scope.contains(tagged)) {
            const kind = tagged.getAttribute("data-explain") as ExplainKind;
            const param =
              tagged.getAttribute("data-explain-param") ?? undefined;
            return { kind, param, el: tagged };
          }
        }
        return null;
      }
      const roots = registry?.snapshot() ?? [];
      const vessels = roots.filter((r) => r.kind === "vessel");
      const stack = document.elementsFromPoint(x, y) as HTMLElement[];
      for (const el of stack) {
        // Skip our own scrim / bubbles — look through them to the floor.
        if (el.closest(`[${CHROME_ATTR}]`)) continue;
        const tagged = el.closest<HTMLElement>("[data-explain]");
        if (tagged) {
          const kind = tagged.getAttribute("data-explain") as ExplainKind;
          // vessel.* leaves belong to a vessel; card.* leaves carry no key.
          const key = kind.startsWith("vessel.")
            ? vessels.find((v) => v.ref.current?.contains(tagged))?.key
            : undefined;
          const param = tagged.getAttribute("data-explain-param") ?? undefined;
          return { kind, key, param, el: tagged };
        }
        // A registered root (floor / vessel / disc) — identity match.
        const root = roots.find((r) => r.ref.current === el);
        if (root) {
          return {
            kind: root.kind,
            key: root.kind === "vessel" ? root.key : undefined,
            el,
          };
        }
      }
      return null;
    },
    [registry, paneMode],
  );

  // Resolve an annotation's live DOM element for measurement (D11). Roots come
  // from the registry Map; leaves are queried, vessel.* scoped to their vessel.
  const elementFor = useCallback(
    (t: HoverTarget): HTMLElement | null => {
      if (typeof document === "undefined") return null;
      const roots = registry?.snapshot() ?? [];
      if (t.kind === "floor" || t.kind === "disc") {
        return roots.find((r) => r.kind === t.kind)?.ref.current ?? null;
      }
      if (t.kind === "vessel") {
        return (
          roots.find((r) => r.kind === "vessel" && r.key === t.key)?.ref
            .current ?? null
        );
      }
      if (t.kind.startsWith("vessel.") && t.key) {
        const v = roots.find((r) => r.kind === "vessel" && r.key === t.key)?.ref
          .current;
        return (
          v?.querySelector<HTMLElement>(`[data-explain="${t.kind}"]`) ?? null
        );
      }
      // Card kinds carry no key: the representative sequential annotation (D5)
      // anchors to the topmost such leaf in the lowest-sort_rank vessel that has
      // it (DOM order within a vessel is top-to-bottom). A pinned hover-only
      // card would carry a key, but non-representative cards aren't measured by
      // instance here — the pin path mints them without a distinct anchor, so
      // any live leaf of the kind is the correct target.
      if (t.kind.startsWith("card")) {
        const vessels = roots
          .filter((r) => r.kind === "vessel")
          .sort((a, b) => (a.order ?? 0) - (b.order ?? 0));
        for (const v of vessels) {
          const el = v.ref.current?.querySelector<HTMLElement>(
            `[data-explain="${t.kind}"]`,
          );
          if (el) return el;
        }
        return null;
      }
      return document.querySelector<HTMLElement>(`[data-explain="${t.kind}"]`);
    },
    [registry],
  );

  const handlePointerMove = useCallback(
    (e: React.PointerEvent) => {
      if (useExplain.getState().draggingFeedId) return; // suppress hover mid-drag
      const hit = hitTest(e.clientX, e.clientY);
      const cur = useExplain.getState().hover;
      const next: HoverTarget | null = hit
        ? { kind: hit.kind, key: hit.key, param: hit.param }
        : null;
      const changed =
        (cur?.kind ?? null) !== (next?.kind ?? null) ||
        (cur?.key ?? undefined) !== (next?.key ?? undefined) ||
        (cur?.param ?? undefined) !== (next?.param ?? undefined);
      if (changed) setHover(next);
    },
    [hitTest, setHover],
  );

  const handleClick = useCallback(() => {
    // First-run is the fixed six-beat sequence, driven only by Next/Back/
    // arrows and finished by Done/Esc — a stray click must not dismiss a tour
    // the user is mid-way through (2026-07-15 audit).
    if (useExplain.getState().program?.kind === "firstrun") return;
    // Explain: ANY click on the scrim dismisses (§6, 2026-07-15 form). Click-
    // pin is deleted — the hover bubble already sits at the cursor, so pinning
    // added nothing but a second, half-dimmed bubble. The disc + About button
    // live above the scrim and keep their own click jobs.
    close();
  }, [close]);

  // Scroll forwarding (D1 amendment, 2026-07-16): the surface is frozen for
  // clicks but LIVE for scroll. A wheel over the scrim scrolls whatever
  // scrollable sits under the cursor — a pane body, a Messages column, a
  // vessel interior — then re-resolves the hover in place, since what sits
  // under the unmoved pointer has changed. First-run keeps the fully frozen
  // surface: its pinned bubbles anchor to element rects, and D11 deliberately
  // has no scroll re-measure trigger for them.
  const handleWheel = useCallback(
    (e: React.WheelEvent) => {
      if (useExplain.getState().program?.kind === "firstrun") return;
      // Normalise deltaMode (Firefox reports lines / pages, not pixels).
      const scale =
        e.deltaMode === 1 ? 16 : e.deltaMode === 2 ? window.innerHeight : 1;
      const dy = e.deltaY * scale;
      const dx = e.deltaX * scale;
      const stack = document.elementsFromPoint(
        e.clientX,
        e.clientY,
      ) as HTMLElement[];
      // Deepest painted element under the cursor that isn't Explain chrome,
      // then the nearest ancestor that can actually scroll in the gesture's
      // axis — the same element the wheel would have reached with no scrim.
      const start = stack.find((el) => !el.closest(`[${CHROME_ATTR}]`));
      let node: HTMLElement | null = start ?? null;
      while (node) {
        const s = getComputedStyle(node);
        const scrollsY =
          /(auto|scroll)/.test(s.overflowY) &&
          node.scrollHeight > node.clientHeight;
        const scrollsX =
          /(auto|scroll)/.test(s.overflowX) &&
          node.scrollWidth > node.clientWidth;
        if ((dy !== 0 && scrollsY) || (dx !== 0 && scrollsX)) {
          node.scrollBy({
            top: scrollsY ? dy : 0,
            left: scrollsX ? dx : 0,
          });
          break;
        }
        node = node.parentElement;
      }
      // The pointer hasn't moved but its target may have: refresh the hover so
      // the caption tracks what scrolled into place.
      const hit = hitTest(e.clientX, e.clientY);
      setHover(hit ? { kind: hit.kind, key: hit.key, param: hit.param } : null);
    },
    [hitTest, setHover],
  );

  // Copy for a live hover target, folding the two per-instance forks: the
  // vessel provenance fork (D7, fromStarter off the vessel's registration
  // params) and the card flavour fork (2026-07-16, the flavour off the card's
  // data-explain-param — a Bluesky post reads differently from an RSS item).
  const copyForHover = useCallback(
    (t: HoverTarget): string => {
      if (t.kind === "vessel") {
        const roots = registry?.snapshot() ?? [];
        const v = roots.find((r) => r.kind === "vessel" && r.key === t.key);
        return explainCopy("vessel", !!v?.params?.fromStarter);
      }
      if (t.kind === "card") return explainCardCopy(t.param);
      return explainCopy(t.kind);
    },
    [registry],
  );

  // The pinned channel renders only for the first-run tour (2026-07-15):
  // Explain is hover-only, so its resolved sequence is never walked.
  const pinned: Annotation | null = isFirstRun
    ? (annotations[index] ?? null)
    : null;
  const pinnedEl = pinned ? elementFor(pinned) : null;

  // D11 re-measure: observe the floor container (vessel add/remove/resize) and,
  // while a target is pinned, that target's own vessel scroll container (async
  // ingestion can reflow the interior under the pinned card, a shift the floor
  // observer misses). No `scroll` trigger — the floor is frozen (D1). First-run
  // only: the Explain hover bubble is cursor-positioned, nothing to re-measure.
  useEffect(() => {
    if (!isActive || !isFirstRun || typeof ResizeObserver === "undefined")
      return;
    const bump = () => setMeasureTick((t) => t + 1);
    const ro = new ResizeObserver(bump);
    const floor = registry
      ?.snapshot()
      .find((r) => r.kind === "floor")?.ref.current;
    if (floor) ro.observe(floor);
    const vesselScroll = pinnedEl?.closest<HTMLElement>("[data-vessel-scroll]");
    if (vesselScroll) {
      ro.observe(vesselScroll);
      // A height-set vessel's scroll box is a fixed frame whose own size
      // never changes when the interior reflows — the growth happens on the
      // scrolled CONTENT — so observe the content wrapper too, else the
      // pinned bubble drifts off a target that async ingestion pushed down.
      const content = vesselScroll.firstElementChild;
      if (content) ro.observe(content);
    }
    window.addEventListener("resize", bump);
    return () => {
      ro.disconnect();
      window.removeEventListener("resize", bump);
    };
  }, [isActive, isFirstRun, registry, pinnedEl]);

  // D1 for the KEYBOARD: the scrim freezes the pointer by stacking alone, but
  // Tab could still walk focus into the frozen floor and Enter would activate
  // what a click cannot reach. Real `inert` on the floor is not usable here —
  // the spec makes an inert subtree hit-test as pointer-events:none, so
  // document.elementsFromPoint would stop seeing the vessels and the hover
  // hit-test above would go blind (and the floor CONTAINS this overlay's own
  // chrome plus the z-60 disc layer, so a blanket attribute is wrong anyway).
  // Instead: (a) any focus landing outside the Explain chrome set — the
  // bubbles, the disc/About layer (`.forall-trigger`), or an open Glasshouse
  // pane (the About pane owns its own focus) — bounces to the program's
  // primary control (the first-run stepper button, else the ∀ disc, the way
  // out); (b) the vessel roots are aria-hidden for the same window so
  // assistive tech cannot read or activate the frozen content the pointer
  // cannot reach.
  useEffect(() => {
    if (!isActive || typeof document === "undefined") return;
    // The frozen content set: the vessel roots on the floor, or — pane mode —
    // the open Glasshouse pane itself (it is the annotated subject, frozen
    // exactly like a vessel; without this, Tab walks into the pane and Enter
    // activates what the pointer cannot reach).
    const frozenEls = paneMode
      ? [document.querySelector<HTMLElement>('[data-explain="pane"]')].filter(
          (el): el is HTMLElement => !!el,
        )
      : (registry?.snapshot() ?? [])
          .filter((r) => r.kind === "vessel")
          .map((r) => r.ref.current)
          .filter((el): el is HTMLElement => !!el);
    for (const el of frozenEls) el.setAttribute("aria-hidden", "true");

    const allowed = (t: EventTarget | null): boolean => {
      // Floor mode: an open Glasshouse is the About pane opened FROM Explain —
      // live, and it owns its own focus. Pane mode: the open Glasshouse is the
      // frozen subject, so focus there is NOT allowed.
      if (!paneMode && useGlasshousePresence.getState().isOpen) return true;
      return (
        t instanceof Element &&
        !!(t.closest(`[${CHROME_ATTR}]`) || t.closest(".forall-trigger"))
      );
    };
    const bounce = () => {
      const primary =
        document.querySelector<HTMLElement>("[data-explain-primary]") ??
        registry?.snapshot().find((r) => r.kind === "disc")?.ref.current;
      primary?.focus();
    };
    if (!allowed(document.activeElement)) bounce();
    const onFocusIn = (e: FocusEvent) => {
      if (!allowed(e.target)) bounce();
    };
    document.addEventListener("focusin", onFocusIn, true);
    return () => {
      document.removeEventListener("focusin", onFocusIn, true);
      for (const el of frozenEls) el.removeAttribute("aria-hidden");
    };
  }, [isActive, registry, paneMode]);

  // Pane mode: the explained pane closing (Esc consumed by the pane, a
  // popstate, any store-side close) takes Explain down with it — the program's
  // subject is gone, and falling back to annotating the floor mid-frost would
  // be a silent surface swap. Decided with the D10 reversal (2026-07-15).
  useEffect(() => {
    if (!isActive || !paneMode) return;
    if (!useGlasshousePresence.getState().isOpen) {
      close();
      return;
    }
    return useGlasshousePresence.subscribe((s) => {
      if (!s.isOpen) close();
    });
  }, [isActive, paneMode, close]);

  // Esc precedence (D12): open Glasshouse → Explain → ForallMenu dropdown. One
  // capture-phase handler early-returns while a Glasshouse is open — floor
  // mode: the About pane consumes Esc (its own handler, Glasshouse.tsx); pane
  // mode: the explained pane consumes it and the presence subscription above
  // then closes Explain too. Otherwise closes Explain and stops propagation so
  // the ForallMenu dropdown's Esc never also fires.
  useEffect(() => {
    if (!isActive) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        if (useGlasshousePresence.getState().isOpen) return;
        e.stopPropagation();
        close();
        return;
      }
      // First-run arrow stepping (the sequence's free-floating beats can't be
      // clicked to advance). Ignored while typing in a field, and while the
      // About pane is open — the tour is hidden under the Glasshouse frost,
      // so arrows must not step it blind.
      if (useExplain.getState().program?.kind !== "firstrun") return;
      if (useGlasshousePresence.getState().isOpen) return;
      const el = document.activeElement;
      if (el && /^(INPUT|TEXTAREA|SELECT)$/.test(el.tagName)) return;
      if (e.key === "ArrowRight") {
        e.preventDefault();
        useExplain.getState().next();
      } else if (e.key === "ArrowLeft") {
        e.preventDefault();
        useExplain.getState().prev();
      }
    };
    document.addEventListener("keydown", onKey, true);
    return () => document.removeEventListener("keydown", onKey, true);
  }, [isActive, close]);

  if (!isActive) return null;

  // Explain's cursor bubble: whatever the pointer is over, described in place.
  // Suppressed during first-run (the tour IS the sequence) and mid-drag (D11).
  const hoverAnn: Annotation | null =
    !isFirstRun && hover && !dragging && cursor
      ? { kind: hover.kind, key: hover.key, copy: copyForHover(hover) }
      : null;

  return (
    <>
      {/* Scrim — flat wash ≤0.18 alpha, no backdrop-filter (D9): the surface
          stays legible behind its own labels. Catches every pointer event so
          the annotated surface is frozen for CLICKS (D1); wheel scroll is
          forwarded to the scrollable under the cursor (D1 amendment,
          2026-07-16). Floor mode sits at z-50 (under any Glasshouse); pane
          mode rises to z-57 — above the pane (z-56) it annotates, still under
          the nav row (z-58) and the ForallMenu (z-60). Pointer leaving the viewport clears the hover
          so no stale bubble lingers.

          IN BOTH MODES IT STARTS AT THE BAR'S OPTICAL EDGE, NOT THE
          VIEWPORT'S TOP — `NAV_BAR_BAND` (floor mode since 2026-09-04, pane
          mode since 2026-09-06), and the number is `NAV_BAR_H + GRID` rather
          than `NAV_BAR_H`. The nav bar is opaque `bone` at z-58, so it already
          paints over the scrim for its own 48px; what an `inset: 0` scrim
          dims is the FLOOR'S OWN TOP BUFFER beneath it — the 8px margin
          `layoutColumns` starts every column past. Bone above, dimmed bone
          below, and the seam lands at 48.

          THAT SEAM DRAWS A LINE THE WHOLE BAR IS BUILT ON NOT EXISTING.
          `NavBar`'s geometry is deliberate and derived: the disc is NOT centred
          in the band — it sits at `INSET` with its bottom flush to the band's
          bottom edge, so the floor's buffer supplies the matching gap below and
          the two optical gaps come out 8 and 8. That construction is licensed
          by one stated premise — the band's bottom edge is invisible, because
          `FLOOR` and the bar's ground are both `var(--ah-bone)`. A scrim at
          `inset: 0` falsifies it, and the first thing anyone sees in Explain is
          a 48px band with a 40px disc jammed against its bottom. The bar is not
          wrong; its correctness was conditional on an invisibility this
          component was removing.

          So the undimmed strip is 0..56 — exactly the bar the eye already
          reads, since 56 is the first vessel's top. Nothing moves in the
          workspace's normal state; a centred disc and a taller band were both
          considered and are worse (the floor's GRID lands in the lower gap
          whatever the band does, so they buy 8-above/16-below — the thing
          reversed on 2026-08-25).

          PANE MODE KEPT `inset: 0` FOR TWO DAYS, AND THAT WAS THE BREAK. The
          reasoning was that a pane's minimum y was `NAV_BAR_H`, so a pane
          dragged flush to the bar would have had its top 8px undimmed by a
          scrim cut at the band. True — but the cost was paid on EVERY
          pane-mode Explain, dragged or not: this layer sits UNDER the bar
          (z-57 < 58) and over the frost (z-55, itself cut at the band), so
          `inset: 0` here dimmed the 8px strip between the two and nothing else
          — a third tone between the bar's bone and the frost, i.e. the bar's
          true edge at 48 AND the frost's at 56, measured 240 → 206 → 200 down a
          column beside the pane. The exception was removed at its root rather
          than here: the pane's y floor is now the band itself
          (`Glasshouse.minYFor`), so no pane can occupy the strip and there is
          nothing above 56 for this scrim to leave undimmed. One line, three
          dimming layers, no cases.

          The cost is that a click on bare bar ground no longer dismisses.
          Its occupants live above the scrim and keep their own click jobs
          anyway, so this only affects the empty stretch between them — and
          beat 4 points AT the bar, so freezing it under a dismiss target was
          never quite right. */}
      <div
        {...{ [CHROME_ATTR]: "" }}
        onPointerMove={handlePointerMove}
        onPointerLeave={() => setHover(null)}
        onWheel={handleWheel}
        onClick={handleClick}
        style={{
          position: "fixed",
          left: 0,
          right: 0,
          bottom: 0,
          top: NAV_BAR_BAND,
          zIndex: paneMode ? 57 : 50,
          background: "rgb(var(--ah-true-black-rgb) / 0.14)",
          cursor: "default",
        }}
      />
      {/* First-run pinned bubble — suspended (hidden) while a vessel is
          dragged (D11). */}
      {pinned && !dragging && (
        <Bubble
          key={`pin:${pinned.kind}:${pinned.key ?? ""}`}
          annotation={pinned}
          el={pinnedEl}
          reduced={reduced}
          measureTick={measureTick}
          stepper={{
            index,
            total: annotations.length,
            done: !!pinned.done,
            onPrev: prev,
            onNext: next,
            onDone: close,
          }}
        />
      )}
      {/* One persistent cursor bubble (not keyed per target) so sweeping the
          pointer across the floor swaps its copy in place instead of re-fading
          a fresh bubble per element (the "faint half-triggered" flicker). */}
      {hoverAnn && cursor && (
        <CursorBubble
          copy={hoverAnn.copy}
          x={cursor.x}
          y={cursor.y}
          reduced={reduced}
          // Pane mode rises to 59 — above the pane it annotates (56), its own
          // raised scrim (57) and the nav bar (58, WORKSPACE-COLUMN-LAYOUT-ADR
          // §VI), still under the ForallMenu at 60. It was 58 until the nav
          // chrome arrived and tied it. Floor mode stays at 53, deliberately
          // BELOW the Glasshouse band: the About pane opened from Explain is
          // meant to frost the tour over (see the arrow-stepping guard above),
          // which a bump above the band would break.
          zIndex={paneMode ? 59 : 53}
          // …AND THAT IS WHY THE FLOOR-MODE BUBBLE IS FENCED OFF THE BAR
          // GEOMETRICALLY RATHER THAN BY z. The bar's three Explain targets —
          // the ∀ disc, the About pill and the muster — all sit inside the bar's
          // band at the top edge, so a cursor bubble raised by one of them opens
          // level with them and the opaque z-58 bar paints over its near edge. There
          // is no z that fixes it: the bubble would have to clear 58 while
          // staying under the Glasshouse scrim at 55, and no such number
          // exists (*Stacking order*). So the bubble is simply not allowed into
          // the bar's band — which is also what it means: a FLOOR-mode
          // annotation belongs on the floor. Pane mode needs no fence, being
          // above the bar already; mobile has no desktop bar, and floor mode is
          // desktop-only (the menu's Explain row is), so one branch covers it.
          // (It was a `minLeft` for the day the chrome ran up the left margin;
          // the fence turns with the chrome, and the reasoning does not.)
          minTop={paneMode ? MARGIN : NAV_BAR_H + MARGIN}
        />
      )}
    </>
  );
}

// -----------------------------------------------------------------------------
// Bubble — the first-run pinned bubble. Measures the live target rect, places
// itself in the side with most free room (right → left → below → above, clamped
// to the viewport), and draws a 2px crimson leader from the target edge midpoint
// to the bubble edge with a 4px dot at the target end (D11). A free-float
// annotation (floor beats, or a target whose element has deregistered) centres
// over the floor with no leader (D8).
// -----------------------------------------------------------------------------

type Side = "right" | "left" | "below" | "above";

interface Placement {
  left: number;
  top: number;
  bw: number;
  bh: number;
  side: Side | null; // null → free-float, no leader
}

function clamp(v: number, lo: number, hi: number): number {
  return Math.max(lo, Math.min(v, hi));
}

// The D11 clipped-target clauses: clip the target's rect to its vessel scroll
// box and the viewport, so a partially clipped target anchors to its visible
// remainder (the leader points at the clip edge, never at a phantom midpoint
// outside the vessel), and a fully clipped one returns null — rendered exactly
// like an absent target (free-float, no leader).
function visibleTargetRect(el: HTMLElement): DOMRect | null {
  const r = el.getBoundingClientRect();
  let { left, top, right, bottom } = r;
  const clip = el.closest<HTMLElement>("[data-vessel-scroll]");
  if (clip) {
    const c = clip.getBoundingClientRect();
    left = Math.max(left, c.left);
    top = Math.max(top, c.top);
    right = Math.min(right, c.right);
    bottom = Math.min(bottom, c.bottom);
  }
  left = Math.max(left, 0);
  top = Math.max(top, 0);
  right = Math.min(right, window.innerWidth);
  bottom = Math.min(bottom, window.innerHeight);
  if (right <= left || bottom <= top) return null;
  return new DOMRect(left, top, right - left, bottom - top);
}

// The pinned bubble is fenced off the nav bar exactly as the cursor bubble is
// (see the `minTop` call site above): floor-mode chrome is z-53 and the bar is
// z-58, so every top bound here is `TOP_FENCE`, not MARGIN. This was a
// no-op-shaped detail while the chrome sat along the bottom and then up the left
// margin — a `right` pick cleared both — and it is load-bearing now: the ∀ disc
// sits INSIDE the band, so a bubble raised by it and centred on it would be
// clamped to y=MARGIN and paint everything above the band's edge underneath it.
const TOP_FENCE = NAV_BAR_H + MARGIN;

function placeBubble(rect: DOMRect | null, size: { w: number; h: number }): Placement {
  const vw = window.innerWidth;
  const vh = window.innerHeight;
  const bw = size.w || BUBBLE_WIDTH;
  const bh = size.h || 120;

  if (!rect) {
    // Free-float: centred horizontally, upper-middle of the floor (D8).
    return {
      left: clamp(vw / 2 - bw / 2, MARGIN, vw - bw - MARGIN),
      top: clamp(vh * 0.4 - bh / 2, TOP_FENCE, Math.max(TOP_FENCE, vh - bh - MARGIN)),
      bw,
      bh,
      side: null,
    };
  }

  const sideTop = clamp(
    rect.top + rect.height / 2 - bh / 2,
    TOP_FENCE,
    Math.max(TOP_FENCE, vh - bh - MARGIN),
  );
  const stackLeft = clamp(
    rect.left + rect.width / 2 - bw / 2,
    MARGIN,
    Math.max(MARGIN, vw - bw - MARGIN),
  );

  const candidates: { side: Side; free: number; fits: boolean; left: number; top: number }[] = [
    {
      side: "right",
      free: vw - rect.right - GAP,
      fits: vw - rect.right - GAP >= bw + MARGIN,
      left: rect.right + GAP,
      top: sideTop,
    },
    {
      side: "left",
      free: rect.left - GAP,
      fits: rect.left - GAP >= bw + MARGIN,
      left: rect.left - GAP - bw,
      top: sideTop,
    },
    {
      side: "below",
      free: vh - rect.bottom - GAP,
      fits: vh - rect.bottom - GAP >= bh + MARGIN,
      left: stackLeft,
      top: rect.bottom + GAP,
    },
    {
      side: "above",
      free: rect.top - GAP,
      // Against TOP_FENCE, not MARGIN: room "above" that is under the bar is
      // not room.
      fits: rect.top - GAP >= bh + TOP_FENCE,
      left: stackLeft,
      top: rect.top - GAP - bh,
    },
  ];

  const pick =
    candidates.find((c) => c.fits) ??
    candidates.reduce((a, b) => (b.free > a.free ? b : a));

  return {
    left: clamp(pick.left, MARGIN, Math.max(MARGIN, vw - bw - MARGIN)),
    top: clamp(pick.top, TOP_FENCE, Math.max(TOP_FENCE, vh - bh - MARGIN)),
    bw,
    bh,
    side: pick.side,
  };
}

// Leader endpoints: from the target's facing-edge midpoint to the bubble's
// near-edge midpoint. The dot sits at the target end (x1, y1).
//
// THE LEADER MAY CROSS THE BAR; THE BUBBLE MAY NOT. This is live, not
// hypothetical: only the D6 AUTO-entry is dormant, and the tour itself is
// reached every first session from the welcome sheet's last step
// (`FirstRunLauncher`, WorkspaceView). Beat 4 is the only beat anchored on bar
// chrome — the ∀ disc, at the top-left — and with `placeBubble` fenced at
// TOP_FENCE its body lands below the bar whichever side wins (driven on screen
// 2026-09-01: beats 3 and 4 both clamp to exactly TOP_FENCE, at 1600/1280/1100/
// 800 wide, with no bubble intersecting anything painted above it). The
// LEADER still crosses: the stub from the disc down to the bar's inner edge
// paints under z-58. That is the same trade the bottom row and the left rail
// each made, and is left as it was — a leader is a 2px line to a target the
// reader can see, not the copy they have to read.
function leaderPoints(
  side: Side,
  rect: DOMRect,
  p: Placement,
): { x1: number; y1: number; x2: number; y2: number } {
  const tcx = rect.left + rect.width / 2;
  const tcy = rect.top + rect.height / 2;
  switch (side) {
    case "right":
      return { x1: rect.right, y1: tcy, x2: p.left, y2: p.top + p.bh / 2 };
    case "left":
      return { x1: rect.left, y1: tcy, x2: p.left + p.bw, y2: p.top + p.bh / 2 };
    case "below":
      return { x1: tcx, y1: rect.bottom, x2: p.left + p.bw / 2, y2: p.top };
    case "above":
      return { x1: tcx, y1: rect.top, x2: p.left + p.bw / 2, y2: p.top + p.bh };
  }
}

// The first-run stepping controls carried in the pinned bubble (§6, D12). The
// free-floating floor beats can't be clicked to advance, so the sequence needs
// explicit Back / Next, and beat 6 needs the "done" affordance.
interface Stepper {
  index: number;
  total: number;
  done: boolean;
  onPrev: () => void;
  onNext: () => void;
  onDone: () => void;
}

function Bubble({
  annotation,
  el,
  reduced,
  stepper,
}: {
  annotation: Annotation;
  el: HTMLElement | null;
  reduced: boolean;
  // The first-run stepping footer (§6).
  stepper: Stepper;
  // Re-render trigger: the overlay bumps it on reflow so the target rect below
  // is re-read. Not consumed directly — its identity change forces this render.
  measureTick: number;
}) {
  const bubbleRef = useRef<HTMLDivElement>(null);
  const [size, setSize] = useState<{ w: number; h: number }>({
    w: BUBBLE_WIDTH,
    h: 120,
  });
  const [shown, setShown] = useState(false);

  // Measure own box each render; converges (only sets on change) so no loop.
  useLayoutEffect(() => {
    const node = bubbleRef.current;
    if (!node) return;
    const r = node.getBoundingClientRect();
    setSize((prev) =>
      prev.w === r.width && prev.h === r.height
        ? prev
        : { w: r.width, h: r.height },
    );
  });

  useEffect(() => {
    const id = requestAnimationFrame(() => setShown(true));
    return () => cancelAnimationFrame(id);
  }, []);

  // SR/keyboard surface: focus follows each beat onto the primary stepper
  // button, so keyboard users step the tour with Enter and screen readers
  // hear the beat's copy through the live region below. Depends on the
  // annotation (not a mount effect): beats 5 and 6 share a kind/key, so the
  // bubble is NOT remounted between them.
  const primaryRef = useRef<HTMLButtonElement>(null);
  useEffect(() => {
    primaryRef.current?.focus();
  }, [annotation]);

  // Live rect, re-read every render (the overlay re-renders on reflow, D11),
  // clipped to the vessel scroll box + viewport (fully clipped → free-float).
  const rect =
    annotation.alwaysFloat || !el ? null : visibleTargetRect(el);
  const place = placeBubble(rect, size);

  const copy = annotation.copy || `[${annotation.kind}]`;
  const opacity = shown ? 1 : 0;

  const leader =
    rect && place.side ? leaderPoints(place.side, rect, place) : null;
  const leaderLen = leader
    ? Math.hypot(leader.x2 - leader.x1, leader.y2 - leader.y1)
    : 0;
  // Reduced motion: static leader (offset 0), opacity-only enter. Otherwise the
  // leader draws from the target toward the bubble.
  const leaderOffset = reduced ? 0 : shown ? 0 : leaderLen;

  return (
    <>
      {leader && (
        <svg
          {...{ [CHROME_ATTR]: "" }}
          width="100%"
          height="100%"
          style={{
            position: "fixed",
            inset: 0,
            zIndex: 51,
            pointerEvents: "none",
            overflow: "visible",
            opacity,
            transition: reduced ? undefined : `opacity ${ENTER_MS}ms ease-out`,
          }}
        >
          <line
            x1={leader.x1}
            y1={leader.y1}
            x2={leader.x2}
            y2={leader.y2}
            strokeWidth={2}
            strokeDasharray={leaderLen}
            strokeDashoffset={leaderOffset}
            style={{
              stroke: "var(--ah-crimson)",
              transition: reduced
                ? undefined
                : `stroke-dashoffset ${ENTER_MS}ms ease-out`,
            }}
          />
          <circle
            cx={leader.x1}
            cy={leader.y1}
            r={2}
            style={{ fill: "var(--ah-crimson)" }}
          />
        </svg>
      )}
      <div
        {...{ [CHROME_ATTR]: "" }}
        ref={bubbleRef}
        role="dialog"
        aria-label={`Welcome tour, step ${stepper.index + 1} of ${stepper.total}`}
        className="bg-glasshouse text-black shadow-lg whitespace-pre-line text-ui-sm"
        style={{
          position: "fixed",
          left: place.left,
          top: place.top,
          width: BUBBLE_WIDTH,
          zIndex: 52,
          padding: "14px 16px",
          borderRadius: 10,
          pointerEvents: "none",
          opacity,
          transition: reduced ? undefined : `opacity ${ENTER_MS}ms ease-out`,
        }}
      >
        <div aria-live="polite">{copy}</div>
        {stepper && (
          // pointerEvents:auto so the controls are clickable through the
          // otherwise inert bubble; whitespace (marginTop, never a rule)
          // separates them from the copy.
          <div
            style={{
              pointerEvents: "auto",
              display: "flex",
              alignItems: "center",
              justifyContent: "space-between",
              gap: 12,
              marginTop: 16,
            }}
          >
            <span className="label-ui text-grey-400">
              {stepper.index + 1} / {stepper.total}
            </span>
            <div style={{ display: "flex", alignItems: "center", gap: 18 }}>
              {stepper.index > 0 && (
                <button
                  type="button"
                  className="btn-text-muted"
                  onClick={stepper.onPrev}
                >
                  Back
                </button>
              )}
              {stepper.done ? (
                <button
                  type="button"
                  ref={primaryRef}
                  data-explain-primary=""
                  className="btn-text"
                  onClick={stepper.onDone}
                >
                  Done
                </button>
              ) : (
                <button
                  type="button"
                  ref={primaryRef}
                  data-explain-primary=""
                  className="btn-text"
                  onClick={stepper.onNext}
                >
                  Next
                </button>
              )}
            </div>
          </div>
        )}
      </div>
    </>
  );
}

// -----------------------------------------------------------------------------
// CursorBubble — the Explain hover bubble (2026-07-15 rework). A tooltip that
// rides the pointer: offset below-right of the cursor, flipping above/left when
// it would leave the viewport, clamped to MARGIN. One persistent instance whose
// copy swaps in place as the hover target changes — it fades in once when hover
// first resolves, never per target. No leader: the cursor is already on the
// thing being described.
// -----------------------------------------------------------------------------

function CursorBubble({
  copy,
  x,
  y,
  reduced,
  zIndex,
  minTop,
}: {
  copy: string;
  x: number;
  y: number;
  reduced: boolean;
  // z-53 over the floor; z-59 in pane mode (above the pane's z-56, the raised
  // z-57 scrim and the nav bar's z-58, under the ForallMenu at z-60).
  zIndex: number;
  // Topmost y the bubble may take. In floor mode this fences it off the opaque
  // nav bar, which outranks it in z and would clip its near edge — see the
  // call site for why the fix cannot be a z-index.
  minTop: number;
}) {
  const bubbleRef = useRef<HTMLDivElement>(null);
  const [size, setSize] = useState<{ w: number; h: number }>({
    w: BUBBLE_WIDTH,
    h: 80,
  });
  const [shown, setShown] = useState(false);

  // Measure own box each render (copy changes height); converges, so no loop.
  useLayoutEffect(() => {
    const node = bubbleRef.current;
    if (!node) return;
    const r = node.getBoundingClientRect();
    setSize((prev) =>
      prev.w === r.width && prev.h === r.height
        ? prev
        : { w: r.width, h: r.height },
    );
  });

  useEffect(() => {
    const id = requestAnimationFrame(() => setShown(true));
    return () => cancelAnimationFrame(id);
  }, []);

  const vw = window.innerWidth;
  const vh = window.innerHeight;
  let left = x + CURSOR_GAP_X;
  if (left + size.w > vw - MARGIN) left = x - CURSOR_GAP_X - size.w;
  let top = y + CURSOR_GAP_Y;
  if (top + size.h > vh - MARGIN) top = y - CURSOR_GAP_Y - size.h;
  // `minTop` is the lower bound, not MARGIN: the flip above can also drive the
  // bubble up (a target near the bottom edge), so fencing it in one place — the
  // final clamp — covers both routes into the bar's band. `Math.max` keeps the
  // range non-empty on a viewport too short to honour both bounds.
  left = clamp(left, MARGIN, Math.max(MARGIN, vw - size.w - MARGIN));
  top = clamp(top, minTop, Math.max(minTop, vh - size.h - MARGIN));

  return (
    <div
      {...{ [CHROME_ATTR]: "" }}
      ref={bubbleRef}
      // A polite live region: the copy swaps in place as the hover target
      // changes, so assistive tech hears each label without focus moving.
      role="status"
      className="bg-glasshouse text-black shadow-lg whitespace-pre-line text-ui-sm"
      style={{
        position: "fixed",
        left,
        top,
        width: BUBBLE_WIDTH,
        zIndex,
        padding: "14px 16px",
        borderRadius: 10,
        pointerEvents: "none",
        opacity: shown ? 1 : 0,
        transition: reduced ? undefined : `opacity ${ENTER_MS}ms ease-out`,
      }}
    >
      {copy}
    </div>
  );
}
