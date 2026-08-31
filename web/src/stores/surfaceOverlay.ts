import { create } from "zustand";
import type { FeedScheme } from "../components/workspace/tokens";
import { claimOverlayEntry, popOverlayEntry } from "../lib/overlayHistory";

// =============================================================================
// useSurfaceOverlay — the unified non-profile content-surface overlay.
//
// One overlay, three surface kinds, backed by a real URL (the profile/reader
// model, see stores/profileOverlay.ts):
//   - source      → /source/<id>     (external feed surface; SourceSurface)
//   - tag         → /tag/<name>      (tag browser; TagBrowser)
//   - publication → /pub/<slug>      (publication homepage; PublicationPanel)
//
// The publication kind carries a `view` (home/about/masthead/archive/subscribe)
// so the publication's sub-routes (/pub/<slug>/{about,masthead,archive,subscribe})
// all render inside the same overlay instead of escaping the workspace full-page; the
// store pushes the matching real URL for each, and PublicationPanel renders the
// sub-view + an in-overlay nav to switch between them. Articles never get a
// surface view — a pub article row opens the reader overlay (useReader).
//
// Opening pushes the surface's real URL into history so the overlay is
// shareable and the browser Back button closes it; close() pops that entry.
// Direct visits to those URLs still render the same surfaces full-page. Mounted
// globally (LayoutShell) so a source/tag/publication link anywhere (e.g. the
// FeedComposer source rows) opens it without escaping the workspace to the
// black topbar.
// =============================================================================

/** Publication sub-views; each maps to a /pub/<slug>[/<view>] URL.
 *
 *  `subscribe` is not one of the four nav sections — it is the leaf off the
 *  masthead's action row, and it is here because without it a workspace member
 *  had no path to a publication's subscription terms at all. */
export type PubView =
  | "home"
  | "about"
  | "masthead"
  | "archive"
  | "subscribe";

/** The nav's four sections; `subscribe` is reached from the action row. */
const PUB_SUB_VIEWS: PubView[] = ["about", "masthead", "archive", "subscribe"];

export type SurfaceTarget =
  | { kind: "source"; id: string }
  | { kind: "tag"; name: string }
  | { kind: "publication"; slug: string; view: PubView };

/** The canonical full-page URL for a surface target. */
export function surfaceUrl(target: SurfaceTarget): string {
  switch (target.kind) {
    case "source":
      return `/source/${encodeURIComponent(target.id)}`;
    case "tag":
      return `/tag/${encodeURIComponent(target.name)}`;
    case "publication": {
      const base = `/pub/${encodeURIComponent(target.slug)}`;
      return target.view === "home" ? base : `${base}/${target.view}`;
    }
  }
}

/** The surface's stable base path (ignoring a publication's sub-view). */
function surfaceBaseUrl(target: SurfaceTarget): string {
  if (target.kind === "publication")
    return `/pub/${encodeURIComponent(target.slug)}`;
  return surfaceUrl(target);
}

// True while `pathname` is still within the surface. Used by SurfaceOverlay to
// distinguish "a link navigated away → dismiss" from "the publication switched
// sub-view (home↔about↔masthead↔archive) → stay open" — the latter changes the
// pushed URL in lockstep with `target`, so an exact-URL check would falsely
// dismiss on the transient lag between replaceState and usePathname catching up.
export function surfacePathMatches(
  target: SurfaceTarget,
  pathname: string,
): boolean {
  const base = decodeURIComponent(surfaceBaseUrl(target));
  const current = decodeURIComponent(pathname);
  return current === base || current.startsWith(`${base}/`);
}

interface SurfaceState {
  isOpen: boolean;
  target: SurfaceTarget | null;
  /** The launching feed's COLOURWAY, or null off a feed-agnostic surface — the
   *  same field, for the same reason, as `useProfile.frameScheme`: the pane
   *  re-derives its whole palette from it (`profilePalette`), so a source
   *  opened off a green feed wears that feed's ⊓ rather than the house's ink
   *  one. Null still draws the ⊓, in ink; a surface pane with NO frame was the
   *  one pane in the house with no shape (PROFILE-PANE-REDESIGN-ADR D2 as
   *  amended). */
  frameScheme: FeedScheme | null;

  open: (target: SurfaceTarget, frameScheme?: FeedScheme | null) => void;
  openSource: (id: string, frameScheme?: FeedScheme | null) => void;
  openTag: (name: string, frameScheme?: FeedScheme | null) => void;
  openPublication: (
    slug: string,
    view?: PubView,
    frameScheme?: FeedScheme | null,
  ) => void;

  close: () => void;
  /** Clear overlay state without touching history — for when a link inside the
   *  overlay navigates the router away (the navigation owns the history entry). */
  dismiss: () => void;
  /** Internal — invoked by the overlay's popstate listener. */
  _handlePop: () => void;
}

export const useSurfaceOverlay = create<SurfaceState>((set, get) => ({
  isOpen: false,
  target: null,
  frameScheme: null,

  open: (target, frameScheme) => {
    claimOverlayEntry(surfaceUrl(target));
    set({ isOpen: true, target, frameScheme: frameScheme ?? null });
  },

  openSource: (id, frameScheme) =>
    get().open({ kind: "source", id }, frameScheme),
  openTag: (name, frameScheme) =>
    get().open({ kind: "tag", name: name.replace(/^#/, "") }, frameScheme),
  openPublication: (slug, view = "home", frameScheme) =>
    get().open({ kind: "publication", slug, view }, frameScheme),

  close: () => {
    // Pop the shared overlay entry; the popstate listener (_handlePop)
    // finalises state and restores the prior URL — one path for both Back and
    // the close button.
    if (popOverlayEntry()) return;
    set({ isOpen: false, target: null, frameScheme: null });
  },

  dismiss: () => {
    if (get().isOpen)
      set({ isOpen: false, target: null, frameScheme: null });
  },

  _handlePop: () => {
    if (get().isOpen)
      set({ isOpen: false, target: null, frameScheme: null });
  },
}));

// ---------------------------------------------------------------------------
// openSurfaceHref — the FeedComposer/byline counterpart to ProfileLink's
// openProfileHref. Classifies a non-profile in-app href into a surface target
// and opens the overlay in place; returns true if it handled the href (so the
// caller preventDefault's the link), false for anything that isn't one of the
// three surfaces (the caller lets the link navigate normally).
// ---------------------------------------------------------------------------
export function openSurfaceHref(
  href: string,
  frameScheme?: FeedScheme | null,
): boolean {
  const source = href.match(/^\/source\/([^/?#]+)/);
  if (source) {
    useSurfaceOverlay
      .getState()
      .openSource(decodeURIComponent(source[1]), frameScheme);
    return true;
  }
  const tag = href.match(/^\/tag\/([^/?#]+)/);
  if (tag) {
    useSurfaceOverlay
      .getState()
      .openTag(decodeURIComponent(tag[1]), frameScheme);
    return true;
  }
  // /pub/:slug and its named sub-routes (about · masthead · archive ·
  // subscribe) open the publication overlay on the matching view. A deeper
  // /pub/:slug/:article (anything else) is an article d-tag, not a surface —
  // left to the caller's reader-overlay path, so we don't claim it here.
  const pub = href.match(/^\/pub\/([^/?#]+)(?:\/([^/?#]+))?\/?(?:[?#]|$)/);
  if (pub) {
    const slug = decodeURIComponent(pub[1]);
    const sub = pub[2] as PubView | undefined;
    if (!sub) {
      useSurfaceOverlay.getState().openPublication(slug, "home", frameScheme);
      return true;
    }
    if (PUB_SUB_VIEWS.includes(sub)) {
      useSurfaceOverlay.getState().openPublication(slug, sub, frameScheme);
      return true;
    }
  }
  return false;
}
