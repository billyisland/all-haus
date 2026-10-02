import { useEffect, type RefObject } from 'react'
import { useLightbox } from '../stores/lightbox'

// =============================================================================
// useBodyImageLightbox — every picture in a rendered article BODY opens in the
// lightbox, by mouse and by keyboard (walkthrough A6).
//
// A card's picture has always enlarged (`EnlargeableImage`); the same picture
// inside the article it belongs to did not, because a body is sanitised HTML
// injected with `dangerouslySetInnerHTML` and there is no component per image
// to wrap. So the container takes ONE delegated handler and the images are
// post-processed after each render of the HTML: `tabindex=0 role=button` (and a
// name where the picture has no alt — an aria-label would REPLACE a real alt,
// not add to it), so Enter/Space reach the same act a click does.
//
// Two images are left alone. One inside a link is the link's — the writer made
// it an affordance toward somewhere else, and hijacking its click would break
// it ("an action whose product is a link is ONE button"). And a click that ends
// a live SELECTION is the selection's: the native reader shares its body ref
// with `QuoteSelector`, whose popup a drag that happens to finish on a picture
// must not trade for a full-screen image.
// =============================================================================

const MARK = 'data-enlargeable'

function imageTarget(root: HTMLElement, t: EventTarget | null): HTMLImageElement | null {
  if (!(t instanceof HTMLImageElement)) return null
  if (!root.contains(t) || t.closest('a')) return null
  return t
}

function open(img: HTMLImageElement) {
  useLightbox.getState().open(img.currentSrc || img.src, img.alt)
}

/** `html` is whatever the container was last rendered from: a change re-marks
 *  the new images. */
export function useBodyImageLightbox(
  ref: RefObject<HTMLElement | null>,
  html: string | null | undefined,
) {
  useEffect(() => {
    const root = ref.current
    if (!root) return

    for (const img of Array.from(root.querySelectorAll('img'))) {
      if (img.closest('a')) continue
      img.setAttribute(MARK, '')
      img.tabIndex = 0
      img.setAttribute('role', 'button')
      if (!img.alt) img.setAttribute('aria-label', 'View picture')
    }

    const onClick = (e: MouseEvent) => {
      const img = imageTarget(root, e.target)
      if (!img) return
      const sel = window.getSelection()
      if (sel && !sel.isCollapsed && sel.toString().trim()) return
      e.preventDefault()
      open(img)
    }
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key !== 'Enter' && e.key !== ' ') return
      const img = imageTarget(root, e.target)
      if (!img) return
      // Space would otherwise scroll the page under the lightbox, and a pane's
      // own key handlers are not the addressee of this press.
      e.preventDefault()
      e.stopPropagation()
      open(img)
    }
    root.addEventListener('click', onClick)
    root.addEventListener('keydown', onKeyDown)
    return () => {
      root.removeEventListener('click', onClick)
      root.removeEventListener('keydown', onKeyDown)
    }
  }, [ref, html])
}
