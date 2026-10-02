// =============================================================================
// overlayHistory — the ONE history entry the URL-synced overlays share.
//
// Three overlays push a canonical URL so they are shareable and Back closes
// them: the reader (`/article/<dTag>` · `/read/<postId>`), the profile
// (`/<username>` · `/author/<id>`) and the surface (`/source/<id>` ·
// `/tag/<name>` · `/pub/<slug>`). Only ONE is ever open — `Glasshouse`'s
// module-level registry supersedes the incumbent — so between them they must
// own exactly ONE history entry, which `close()` pops.
//
// EACH STORE USED TO TRACK THAT WITH A PRIVATE `didPush` BOOLEAN, AND A PRIVATE
// BOOLEAN CANNOT SEE THE OTHER TWO. Opening a surface from the reader (the
// reader bar's source link, or a card's provenance line while a reader is up)
// therefore pushed a SECOND entry: the newcomer's own `didPush` was false, so
// it pushed rather than replaced, while the superseded reader's `dismiss()`
// cleared its flag WITHOUT popping — on the documented reasoning that "the
// newcomer already owns the top entry", which was exactly the thing that
// wasn't true. One `close()` then popped one of the two, landing the user on
// the orphaned `/read/<postId>` with no overlay open. Since a raw `pushState`
// syncs `usePathname` WITHOUT re-rendering the route, the workspace stayed
// mounted with its top bar while `useLayoutMode` read that URL as `canvas` and
// LayoutShell mounted the public nav row underneath it — two navigations on
// screen at once, and a floor shifted by the row's reserved band.
//
// THE OWNER IS NOW THE ENTRY ITSELF. `history.state` carries one shared marker,
// so "is an overlay entry already on top?" is answered by the browser rather
// than by three flags that can disagree. That also fixes, for free, the case a
// shared flag gets WRONG: a real <Link> inside an overlay router-navigates and
// pushes an unmarked entry, so the next overlay open correctly PUSHES over that
// page instead of replacing (clobbering) it.
//
// NEXT MERGES ITS OWN KEYS INTO A PUSH AND NOT INTO A REPLACE, which this
// comment had wrong in both directions until it was measured (2026-09-16): a
// raw `pushState({mine:true})` comes back carrying `mine`, `__NA` and
// `__PRIVATE_NEXTJS_INTERNALS_TREE`, while a `replaceState` of a bare object
// leaves the entry with `[]`. An entry stripped of the internals tree is one
// the app router cannot reconcile on the way back, so it answers with a full
// document navigation — every in-memory surface on the page gone, and nothing
// anywhere saying why. So the marker is MERGED into whatever is already on the
// entry rather than replacing it; the tree stays correct across the write,
// because the document has not navigated.
// =============================================================================

/** The shared marker. Deliberately NOT per-overlay: the point is that any of
 *  the three recognises an entry pushed by any other. */
const OVERLAY_ENTRY = "allhausOverlay";

/** True when the CURRENT history entry is one an overlay pushed. */
export function overlayEntryIsCurrent(): boolean {
  if (typeof window === "undefined") return false;
  try {
    const state = window.history.state as Record<string, unknown> | null;
    return state?.[OVERLAY_ENTRY] === true;
  } catch {
    return false;
  }
}

/**
 * Put `targetUrl` in the address bar as THE overlay entry: replace if one is
 * already on top (a second overlay opening over the first, or the same overlay
 * re-targeting — a skip-ear step, a byline inside a profile), push if not.
 *
 * Never pushes twice, so `close()`'s single `history.back()` always lands on
 * the surface the user actually came from.
 */
export function claimOverlayEntry(targetUrl: string): void {
  if (typeof window === "undefined") return;
  try {
    if (overlayEntryIsCurrent()) {
      window.history.replaceState(
        { ...window.history.state, [OVERLAY_ENTRY]: true },
        "",
        targetUrl,
      );
    } else {
      window.history.pushState({ [OVERLAY_ENTRY]: true }, "", targetUrl);
    }
  } catch {
    /* a history quota / opaque-origin failure leaves the overlay un-addressed,
       which is a degraded but working pane — never a thrown open(). */
  }
}

/**
 * Pop the overlay entry if the current one IS the overlay's. Returns true when
 * a `popstate` is now in flight, so the caller leaves finalising its state to
 * its own popstate listener (the one path shared with the browser's Back).
 * Returns false when there is nothing to pop and the caller must clear itself.
 */
export function popOverlayEntry(): boolean {
  if (!overlayEntryIsCurrent()) return false;
  window.history.back();
  return true;
}
