import { useEffect, type RefObject } from 'react'

// =============================================================================
// useForwardedWheel — hand a wheel that landed anywhere on a FITTED page to the
// one element on it that scrolls.
//
// THE FITTED CHASSIS EATS ITS OWN GESTURE. `/` is a pinned `100dvh` shell
// (`overflow: hidden`) and every PublicShell page is `.ah-public-fit`; in both,
// the document does not scroll and the card column inside the vessel does. So a
// wheel over the bone floor beside the vessel, or over the nav bar's band, or
// over the centring gap above a short form, did nothing at all — which reads as
// a dead page rather than as a fitted one. The visitor's cursor is very often
// exactly there, because the vessel is at most 720px wide on a monitor three
// times that.
//
// A WHEEL ALREADY INSIDE THE COLUMN IS LEFT ALONE. The browser does momentum,
// overscroll and scroll chaining better than we can, and adding our delta on top
// of its own would double every notch.
//
// AND A PAGE THAT GENUINELY SCROLLS IS LEFT ALONE TOO — the guard that makes
// this safe to mount on the public chassis rather than only on `/`. Below 480px
// of viewport height `.ah-public-fit` ABANDONS the fit (see PublicShell): the
// remainder would be too little to hold a card, so it becomes `min-height` and
// the page scrolls normally. Forwarding there would scroll the document AND the
// vessel from one gesture, since this listener is passive and prevents nothing.
// So it asks the document first and stands down if the document can move. `/`
// never can, so the same rule serves both chassis.
//
// PASSIVE, DELIBERATELY. There is no document scroll to prevent, so there is
// nothing to preventDefault, and the listener must not cost the browser its fast
// path on the one gesture these pages live by.
//
// `deltaMode` IS NOT ALWAYS PIXELS. It is 0 for trackpads and most mice, but a
// Firefox mouse reports 1 (lines) and a page-scroll gesture 2 — and a raw
// `deltaY` of 3 would move the column three pixels and read as broken. Line
// height is approximated at 16px, which is what every other implementation of
// this does; a page is the column's own height.
// =============================================================================

/** Approximate px per line for `deltaMode === 1`. */
const LINE_HEIGHT_PX = 16

export function useForwardedWheel(ref: RefObject<HTMLElement | null>) {
  useEffect(() => {
    function onWheel(e: WheelEvent) {
      const el = ref.current
      if (!el) return

      const target = e.target as Node | null
      if (target && el.contains(target)) return

      // A WHEEL OVER AN OVERLAY IS THE OVERLAY'S, EVEN WHEN THE OVERLAY IS NOT
      // SCROLLABLE. "Not inside the column" was taken to mean "in the page's
      // margins", which is true on a bare fitted page and false the moment
      // anything floats over it: a scroll over a Glasshouse scrim, or over a
      // lightbox showing a picture bigger than the window, moved the column
      // UNDERNEATH — so dismissing the overlay revealed a page that had
      // silently travelled. The surface that is on top owns the gesture.
      if (
        target instanceof Element &&
        target.closest(".gh-scrim, [data-lightbox], [data-overlay-surface]")
      ) {
        return
      }

      // The document can move: this is the short-viewport fallback, not a
      // fitted page, and the browser's own scroll is the right answer.
      const doc = document.scrollingElement
      if (doc && doc.scrollHeight > doc.clientHeight + 1) return

      const scale =
        e.deltaMode === 1
          ? LINE_HEIGHT_PX
          : e.deltaMode === 2
            ? el.clientHeight
            : 1
      el.scrollTop += e.deltaY * scale
    }

    window.addEventListener('wheel', onWheel, { passive: true })
    return () => window.removeEventListener('wheel', onWheel)
  }, [ref])
}
