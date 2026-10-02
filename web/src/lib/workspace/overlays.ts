// =============================================================================
// Workspace overlay deep-link dispatcher.
//
// As routes retire into workspace Glasshouse overlays (dashboard, messages,
// notifications, …), they all funnel through the same address shape:
//   /reader?overlay=<name>[&…seed params]
// This module is the single place that maps that shape to the matching overlay
// store's open(). Two entry points:
//   - openOverlayFromParams: used by WorkspaceView on mount (params read from
//     window.location) to open the requested overlay seeded from the query.
//   - routeToOverlay: used by in-workspace navigations (e.g. notification rows)
//     so a link to /reader?overlay=… opens the overlay in place instead of a
//     no-op router.push to the same /reader pathname. Returns true when it
//     handled the href, so the caller can skip its own router.push.
//
// PARAM_KEYS is the full set of query keys the overlays consume — WorkspaceView
// strips these after opening so the workspace URL stays clean.
// =============================================================================

import { commentIdFromAnchor } from "../post/reply-anchor";
import { useDashboardOverlay } from "../../stores/dashboardOverlay";
import { useMessagesOverlay } from "../../stores/messagesOverlay";
import { useLedgerOverlay } from "../../stores/ledgerOverlay";
import { useSettingsOverlay } from "../../stores/settingsOverlay";
import { useLibraryOverlay, type LibraryTab } from "../../stores/libraryOverlay";
import { useEditorOverlay } from "../../stores/editorOverlay";
import { useReader } from "../../stores/reader";
import { useProfile } from "../../stores/profileOverlay";
import { openSurfaceHref, useSurfaceOverlay } from "../../stores/surfaceOverlay";
import { useWorkspaceSurface } from "../../stores/workspaceSurface";
import { overlayEntryIsCurrent } from "../overlayHistory";

export const OVERLAY_PARAM_KEYS = [
  "overlay",
  "tab",
  "context",
  "conversation",
  "linked",
  "follows",
  // Stripe Connect onboarding breadcrumbs, forwarded by the /settings shim.
  // Listed here so they are stripped from the workspace URL like every other
  // seed param, rather than lingering after the overlay opens.
  "onboarding",
  "refresh",
  "draft",
  "edit",
  "pub",
  // The three URL-backed *pane* overlays (reader/profile/surface) carry their
  // target here when a standalone page reloads into the workspace (see
  // standalone pages). Unlike the ?overlay= panels above, these overlays
  // push their own canonical URL on open — so WorkspaceView strips the workspace
  // URL to /reader *before* opening them, letting that canonical URL land on a
  // clean /reader base entry (so Back/close returns to the workspace).
  "article",
  "read",
  "user",
  "author",
  "surface",
] as const;

/** Open the overlay named by `params.overlay`, seeded from the query. Returns
 *  true if an overlay was opened. */
export function openOverlayFromParams(params: URLSearchParams): boolean {
  switch (params.get("overlay")) {
    case "dashboard":
      useDashboardOverlay.getState().open({
        tab: params.get("tab"),
        context: params.get("context"),
      });
      return true;
    case "messages":
      useMessagesOverlay
        .getState()
        .open({ conversationId: params.get("conversation") });
      return true;
    case "notifications":
      // Notifications folded into the merged Messages inbox. The retired
      // /notifications route + notification deep links land on the same surface.
      useMessagesOverlay.getState().open({ conversationId: null });
      return true;
    case "ledger":
      useLedgerOverlay.getState().open();
      return true;
    case "settings":
      useSettingsOverlay.getState().open({
        linked: params.get("linked"),
        follows: params.get("follows"),
      });
      return true;
    case "library":
      useLibraryOverlay
        .getState()
        .open({ tab: params.get("tab") as LibraryTab | null });
      return true;
    case "editor":
      useEditorOverlay.getState().open({
        draftId: params.get("draft"),
        editEventId: params.get("edit"),
        publicationSlug: params.get("pub"),
      });
      return true;
    // The three URL-backed pane overlays, reopened when their standalone page
    // reloads into the workspace (?overlay= on /reader). Native targets open
    // directly; the external reader resolves its origin URL from the postId.
    case "reader": {
      const article = params.get("article");
      const read = params.get("read");
      if (article) {
        useReader.getState().openNative(article);
        return true;
      }
      if (read) {
        void useReader.getState().openExternalById(read);
        return true;
      }
      return false;
    }
    case "profile": {
      const user = params.get("user");
      const author = params.get("author");
      // The view a retired address named (`/following`, `/social`,
      // `/network?tab=followers`). A pane ignores the ambient workspace `?tab`
      // — the address belongs to the workspace, not to the profile — so
      // without this seed those three redirect to the profile FRONT DOOR and
      // drop the thing the link was about. Unknown values fall to the default
      // view, exactly as an unknown `?tab=` does on the standalone page.
      const tab = params.get("tab");
      // `me` is the one spelling here that is not a username. The retired
      // /network shim is a SERVER redirect and reads no session, so it can
      // only name the MEMBER; `openSelf` resolves it against the auth store
      // (and waits, if the session has not landed yet). Nothing else mints a
      // `user=` seed, so the sentinel is unambiguous where it is produced —
      // and it never survives into a shareable address, because the overlay
      // pushes the real /<username> the moment it opens.
      if (user === "me") return useProfile.getState().openSelf({ tab });
      if (user) {
        useProfile.getState().openNative(user, { tab });
        return true;
      }
      if (author) {
        useProfile.getState().openExternal(author);
        return true;
      }
      return false;
    }
    case "surface": {
      // `surface` carries the canonical path (/source/:id · /tag/:name · /pub/:slug
      // [+ sub-view]); openSurfaceHref re-derives the target and opens it.
      const href = params.get("surface");
      return href ? openSurfaceHref(href) : false;
    }
    default:
      return false;
  }
}

// The overlays whose component is mounted by `WorkspaceView` and nowhere else.
// Off the workspace, `open()` on one of their stores sets state no renderer is
// listening to — so `routeToOverlay` must decline the href and let the caller
// navigate to /reader, where the mount-time dispatcher opens it for real.
//
// This is not hypothetical tidying; both halves of it had shipped. The profile
// pane's Message button called `router.push("/reader?overlay=messages&…")` from
// a surface that is USUALLY already on /reader, where a push to the pathname
// you are on is a no-op and the mount effect never re-runs — so the button
// opened nothing, ever. Its sibling "Edit profile" had the mirror-image hole:
// it asked `routeToOverlay` first, which answered `true` on a standalone
// /:username page where SettingsOverlay is not mounted, and so swallowed the
// push that would have worked. One gate closes both, and closes them for the
// next caller too.
//
// The discriminator is the workspace's own mount flag, never the URL: a
// URL-synced pane overlay claims its address with a raw `pushState`, so while
// the reader is open over the workspace the URL reads /article/… and the
// workspace is very much still mounted (stores/workspaceSurface.ts).
//
// Everything NOT listed here is mounted globally by `LayoutShell` (profile,
// surface, editor) and works from either register, so it stays claimable.
const WORKSPACE_ONLY_OVERLAYS = new Set([
  "dashboard",
  "messages",
  "notifications",
  "ledger",
  "settings",
  "library",
  "reader",
]);

/** If `href` targets a workspace overlay (/reader?overlay=…), open it in
 *  place and return true; otherwise return false so the caller navigates. */
export function routeToOverlay(href: string): boolean {
  // A READING ROUTE IS AN OVERLAY TOO, and claiming it here is what stops a
  // workspace-reachable surface pushing one. `/article/:dTag` and
  // `/read/:postId` have no `?overlay=` to parse, so they fell straight
  // through to the caller's `router.push` — a full navigation out of the
  // workspace, which is the escape ban's own example. The notification rows
  // are where it was still live: `new_reply`, `new_mention`, `new_quote`,
  // `pub_*` and `tribute_*` all carry an article slug.
  //
  // Gated on the same mount flag as the eight workspace-only overlays, for
  // the same reason — `ReaderOverlay` is mounted by `WorkspaceView` alone, so
  // off the workspace the push IS the right answer and must still happen.
  const reading = /^\/(article|read)\/([^/?#]+)/.exec(href);
  if (reading) {
    if (!useWorkspaceSurface.getState().mounted) return false;
    const id = decodeURIComponent(reading[2]);
    // A notification about a comment carries `#reply-<comment id>`: the pane
    // has no hash of its own, so the errand rides the open instead.
    if (reading[1] === "article")
      useReader
        .getState()
        .openNative(id, { focusCommentId: commentIdFromAnchor(href) });
    else void useReader.getState().openExternalById(id);
    return true;
  }

  const qIndex = href.indexOf("?");
  if (qIndex === -1) return false;
  if (!href.startsWith("/reader")) return false;
  // Drop any #hash before parsing the query.
  const query = href.slice(qIndex + 1).split("#")[0];
  const params = new URLSearchParams(query);
  const name = params.get("overlay") ?? "";
  if (
    WORKSPACE_ONLY_OVERLAYS.has(name) &&
    !useWorkspaceSurface.getState().mounted
  ) {
    return false;
  }
  return openOverlayFromParams(params);
}

// =============================================================================
// THE ADDRESS BAR IS A CLAIM, AND A PANE THAT SUPERSEDED A URL-SYNCED ONE HAS
// TO HAND IT BACK.
//
// The three URL-synced panes (reader, profile, surface) push a canonical URL,
// and a pane opened OVER one of them — the composer, above all — supersedes it
// without touching that URL. Close the composer and the address still reads
// `/celiaspencer` while the reader is looking at the workspace: the site says
// they are on a profile and shows them something else. Reported the long way
// round — reply to a mention from the pinned conversation and the conversation
// you were reading is simply gone, along with the reply you just wrote.
//
// So: when a pane closes and the address still carries an overlay's own claim,
// reopen what it names. The `overlayEntryIsCurrent()` guard is what makes the
// last branch safe — a bare `/<segment>` is only read as a username because
// the marker says an overlay put it there, which is exactly the check the
// greedy `profileTargetFromHref` cannot make for itself.
// =============================================================================

/** Reopen whatever the current address names, if it names a URL-synced pane
 *  and none is open. Returns true if one was opened. */
export function reopenAddressedPane(): boolean {
  if (typeof window === "undefined") return false;
  if (!overlayEntryIsCurrent()) return false;
  // One at a time: if a pane is already up, the address belongs to it.
  if (
    useProfile.getState().isOpen ||
    useReader.getState().isOpen ||
    useSurfaceOverlay.getState().isOpen
  ) {
    return false;
  }

  // A SUSPENDED PANE IS RESUMED, NOT REBUILT. Opening fresh from the address
  // alone throws away everything the pane was carrying — which conversation it
  // was opened ON, the feed colourway it was wearing — so the reader is handed
  // back the person's front door instead of the thread they were writing into.
  if (useProfile.getState().resume()) return true;

  const path = window.location.pathname;
  const seg = path.split("/").filter(Boolean);
  if (seg.length === 0) return false;

  if (seg[0] === "author" && seg[1]) {
    useProfile.getState().openExternal(decodeURIComponent(seg[1]));
    return true;
  }
  if (seg[0] === "article" && seg[1]) {
    useReader.getState().openNative(decodeURIComponent(seg[1]));
    return true;
  }
  if (seg[0] === "read" && seg[1]) {
    void useReader.getState().openExternalById(decodeURIComponent(seg[1]));
    return true;
  }
  if (["source", "tag", "pub"].includes(seg[0]) && seg[1]) {
    return openSurfaceHref(path);
  }
  // A single bare segment under an overlay marker is a username — see above —
  // with one exclusion that costs a line and closes the only bare segment that
  // certainly is not one. The workspace never claims an overlay entry, so
  // `/reader` should not reach here at all; it is excluded anyway because the
  // branch is one edit away from being reached and the failure would be a
  // profile pane for a member called "reader".
  if (seg.length === 1 && seg[0] !== "reader") {
    useProfile.getState().openNative(decodeURIComponent(seg[0]));
    return true;
  }
  return false;
}
