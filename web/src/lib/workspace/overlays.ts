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

import { useDashboardOverlay } from "../../stores/dashboardOverlay";
import { useMessagesOverlay } from "../../stores/messagesOverlay";
import { useLedgerOverlay } from "../../stores/ledgerOverlay";
import { useSettingsOverlay } from "../../stores/settingsOverlay";
import { useLibraryOverlay, type LibraryTab } from "../../stores/libraryOverlay";
import { useNetworkOverlay, type NetworkTab } from "../../stores/networkOverlay";
import { useEditorOverlay } from "../../stores/editorOverlay";
import { useReader } from "../../stores/reader";
import { useProfile } from "../../stores/profileOverlay";
import { openSurfaceHref } from "../../stores/surfaceOverlay";

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
  // WorkspacePaneRedirect). Unlike the ?overlay= panels above, these overlays
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
    case "network":
      useNetworkOverlay
        .getState()
        .open({ tab: params.get("tab") as NetworkTab | null });
      return true;
    case "editor":
      useEditorOverlay.getState().open({
        draftId: params.get("draft"),
        editEventId: params.get("edit"),
        publicationSlug: params.get("pub"),
      });
      return true;
    // The three URL-backed pane overlays, reopened when their standalone page
    // reloads into the workspace (WorkspacePaneRedirect). Native targets open
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
      if (user) {
        useProfile.getState().openNative(user);
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

/** If `href` targets a workspace overlay (/reader?overlay=…), open it in
 *  place and return true; otherwise return false so the caller navigates. */
export function routeToOverlay(href: string): boolean {
  const qIndex = href.indexOf("?");
  if (qIndex === -1) return false;
  if (!href.startsWith("/reader")) return false;
  // Drop any #hash before parsing the query.
  const query = href.slice(qIndex + 1).split("#")[0];
  return openOverlayFromParams(new URLSearchParams(query));
}
