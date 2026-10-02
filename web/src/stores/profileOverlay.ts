import { create } from "zustand";
import type { FeedScheme } from "../components/workspace/tokens";
import type { PaneRect } from "../components/workspace/paneRect";
import { claimOverlayEntry, popOverlayEntry } from "../lib/overlayHistory";
import { useAuth } from "./auth";
import { useMessagesOverlay } from "./messagesOverlay";
import { useUnreadCounts } from "./unread";

// =============================================================================
// useProfile — the unified profile-overlay store.
//
// One overlay, two profile kinds, backed by a real URL (the reader-pane model,
// see stores/reader.ts):
//   - native   → /<username>          (the WriterActivity profile; NativeProfilePanel)
//   - external → /author/<authorId>   (tier-A/B constructed profile; AuthorProfileView)
//
// Opening pushes the profile's real URL into history so the overlay is
// shareable and the browser Back button closes it; close() pops that entry.
// Direct visits to those URLs render the same profiles full-page. Mounted
// globally (LayoutShell) so any byline / profile link sitewide opens it without
// leaving the current surface.
// =============================================================================

export type ProfileTarget =
  | { kind: "native"; username: string }
  | { kind: "external"; authorId: string };

/** A conversation to open the profile ON, rather than opening it at its front
 *  door: the post_id to expand and the view that post lives in. */
export interface ProfileFocus {
  postId: string;
  view: "posts" | "replies";
}

/** Options every profile open shares. An object rather than a fourth
 *  positional: three was already one too many, and the next thing a caller
 *  needs to say about an open should not change the shape again. */
export interface ProfileOpenOptions {
  frameScheme?: FeedScheme | null;
  enterFrom?: PaneRect | null;
  focus?: ProfileFocus | null;
  returnTo?: "messages" | null;
  /** WHICH VIEW TO OPEN ON — the `?tab=` vocabulary `WriterActivity` already
   *  reads on the standalone page. A pane ignores the ambient URL tab (the
   *  workspace's address is not the pane's), so a retired address that named a
   *  view — `/following`, `/social`, `/network?tab=following` — has no way to
   *  say which one without this: it would redirect to the profile FRONT DOOR
   *  and silently drop the thing the link was about. Unknown values fall to
   *  the default view, exactly as an unknown `?tab=` does. */
  tab?: string | null;
}

interface ProfileState {
  isOpen: boolean;
  target: ProfileTarget | null;
  /** When opened from a feed card byline, that feed's COLOURWAY — the pane
   *  re-derives its WHOLE palette from it (bar, interior, cards and the ⊓ frame
   *  alike), rather than taking a single framing colour. Null when opened from
   *  a feed-agnostic surface, where the pane falls back to the global content
   *  palette. */
  frameScheme: FeedScheme | null;

  /** ONE-SHOT ENTRY BOX — the rect of the Glasshouse this profile is opening in
   *  the place of, so the pane GROWS out of it rather than cutting to its own
   *  geometry (the handoff rule). Null when nothing was open, which is every
   *  open from the bare floor, and the pane then simply arrives. Cleared with
   *  the rest of the target, so a later open cannot inherit a stale box. */
  enterFrom: PaneRect | null;

  /** The conversation the pane was opened ON, if any — see `ProfileFocus`. */
  focus: ProfileFocus | null;

  /** The view the pane opens on, when the caller named one — see
   *  `ProfileOpenOptions.tab`. Outranked by `focus`, which is an errand. */
  tab: string | null;

  /** The surface to put back when this pane closes, if it still has anything
   *  to say. Set by the notifications inbox, which is superseded rather than
   *  closed on the way in (the handoff rule), so without this a reader working
   *  through a list of notifications loses the list on the first one. */
  returnTo: "messages" | null;

  /** Open a native writer profile by username. */
  openNative: (username: string, opts?: ProfileOpenOptions) => void;
  /** Open a tier-A/B external author profile by author id. */
  openExternal: (authorId: string, opts?: ProfileOpenOptions) => void;
  /** Open the SIGNED-IN MEMBER'S OWN profile — the ForallMenu's Profile row
   *  and the retired /network shim. Neither can name a username: the row would
   *  have to thread one through the menu's props, and the shim is a server
   *  redirect that reads no session. Returns false when there is no member, so
   *  a caller renders no control rather than a dead one. */
  openSelf: (opts?: ProfileOpenOptions) => boolean;
  /** The pane reports the view it is ON, so a resume can put the reader back
   *  there. A resumed pane is a REMOUNT (`ProfileOverlay` renders null while
   *  closed), so every piece of view state inside it is gone unless the store
   *  is holding it — a reader who switched to REPLIES, expanded a conversation
   *  and replied from it came back on the errand's original view. */
  setTab: (tab: string | null) => void;

  close: () => void;
  /** Put a superseded pane back, with everything it was carrying — see
   *  `dismiss`. False when there is nothing to resume or the address has moved
   *  on, which is the caller's cue to open fresh or do nothing. */
  resume: () => boolean;
  /** Clear overlay state without touching history — for when the ROUTE leaves
   *  our target, whether by the browser's Back or by a link inside the pane
   *  (the navigation owns the history entry). Restores the inbox only when it
   *  lands back on the workspace. */
  dismiss: () => void;
  /** Internal — invoked by the overlay's popstate listener. */
  _handlePop: () => void;
}

/** The workspace's own address — where a restored inbox can actually render
 *  (`/workspace` is a redirect shim and never the landed path). */
const WORKSPACE_PATH = "/reader";

/** The canonical address of a target — what this pane claims while it is up. */
function addressOf(target: ProfileTarget): string {
  return target.kind === "native"
    ? `/${target.username}`
    : `/author/${target.authorId}`;
}

/** Is the address bar still this pane's own? True while it has been SUPERSEDED
 *  (a composer over it claims no URL) and false once the route has actually
 *  left — which is the one question that tells a handover from a departure. */
function addressStillNames(target: ProfileTarget | null): boolean {
  if (!target || typeof window === "undefined") return false;
  return decodeURIComponent(window.location.pathname) === addressOf(target);
}

const CLEARED = {
  isOpen: false,
  target: null,
  frameScheme: null,
  enterFrom: null,
  focus: null,
  tab: null,
  returnTo: null,
} as const;

function openFields(opts?: ProfileOpenOptions) {
  return {
    frameScheme: opts?.frameScheme ?? null,
    enterFrom: opts?.enterFrom ?? null,
    focus: opts?.focus ?? null,
    tab: opts?.tab ?? null,
    returnTo: opts?.returnTo ?? null,
  };
}

/**
 * Put back the surface this pane was opened from, IF IT STILL HAS SOMETHING TO
 * SAY. A reader working down a list of notifications should find the list still
 * there after each one; a reader who has just read the last of them should find
 * the workspace, not an empty inbox they have to dismiss. So the condition is
 * the unread COUNT, read at the moment of return rather than remembered from
 * the way in — clicking a row marks it read, so the count that matters is the
 * one after that.
 */
function restore(returnTo: "messages" | null): void {
  if (returnTo !== "messages") return;
  // BACK ONTO THE WORKSPACE, NOT AWAY FROM IT. `dismiss()` also fires when a
  // link INSIDE the pane router-navigates somewhere else, and the inbox is
  // mounted by `WorkspaceView` alone — so restoring on a departure would set
  // state nothing is rendering, and then spring the pane open unasked the next
  // time the reader came back to /reader. The destination is the only thing
  // that tells the two apart, and it is right there in the address bar.
  if (typeof window === "undefined") return;
  if (window.location.pathname !== WORKSPACE_PATH) return;
  if (useUnreadCounts.getState().notificationCount <= 0) return;
  useMessagesOverlay.getState().open({ conversationId: null });
}

export const useProfile = create<ProfileState>((set, get) => ({
  isOpen: false,
  target: null,
  frameScheme: null,
  enterFrom: null,
  focus: null,
  tab: null,
  returnTo: null,

  openNative: (username, opts) => {
    const clean = username.replace(/^@/, "");
    claimOverlayEntry(`/${clean}`);
    set({
      isOpen: true,
      target: { kind: "native", username: clean },
      ...openFields(opts),
    });
  },

  openExternal: (authorId, opts) => {
    claimOverlayEntry(`/author/${encodeURIComponent(authorId)}`);
    set({
      isOpen: true,
      target: { kind: "external", authorId },
      ...openFields(opts),
    });
  },

  openSelf: (opts) => {
    const { user, loading } = useAuth.getState();
    if (user?.username) {
      get().openNative(user.username, opts);
      return true;
    }
    // Settled and anonymous — there is no profile to open, and saying so is
    // the caller's cue to navigate instead of swallowing the click.
    if (!loading) return false;
    // NOT SETTLED YET. The workspace's deep-link dispatcher runs in a mount
    // effect, and the session is an httpOnly cookie that only fetchMe() can
    // see — so a /network arrival regularly asks for "me" a round-trip before
    // the answer exists. Open on the first settled state and UNSUBSCRIBE
    // THERE: a listener left behind would fire an unasked-for pane on some
    // later login. `true` is the honest answer to the only question the
    // callers ask — "is this href handled here, or should I navigate?".
    const unsub = useAuth.subscribe((s) => {
      if (s.loading) return;
      unsub();
      if (s.user?.username) get().openNative(s.user.username, opts);
    });
    return true;
  },

  close: () => {
    // Pop the shared overlay entry; the popstate listener (_handlePop)
    // finalises state and restores the prior URL — one path for both Back and
    // the close button.
    if (popOverlayEntry()) return;
    const { returnTo } = get();
    set(CLEARED);
    restore(returnTo);
  },

  // THE ROUTE LEFT OUR TARGET, or another pane took this one's place. All
  // three are told apart inside `restore` by ONE question — where is the
  // address bar now — and that one question turns out to answer all of them:
  // Back lands on the workspace and should give the inbox back; a link inside
  // the pane lands anywhere else and should not; and a SUPERSEDE happens while
  // the address is still this profile's own `/<username>`, because the pane
  // exists nowhere else, so it is refused by the same line.
  //
  // A separate `supersede` exit was written here first, on the reasoning that
  // one function serving three rules is how the wrong one gets applied. It was
  // taken back out because no test could tell it from this one: the state it
  // guarded against — a supersede while standing on /reader — is not reachable.
  // A guard nothing can distinguish from its absence is not a guard, and
  // leaving it in would have been a comment claiming protection it never gave.
  //
  // This is the exit Back actually takes, which was worth measuring rather
  // than assuming: `_handlePop` is the popstate listener and reads like the
  // Back path, but Next's own listener is registered first, so its re-render
  // runs this effect before our listener is reached and `_handlePop` then
  // finds the pane already closed. Both exits therefore restore, and neither
  // may assume it is the one that ran.
  dismiss: () => {
    if (!get().isOpen) return;
    const { target, returnTo } = get();
    // SUPERSEDED, NOT LEFT. A composer opening over this pane takes the screen
    // and claims no URL of its own, so the address still reads `/<username>` —
    // and the pane's whole identity (which profile, which conversation it was
    // opened ON, what to put back afterwards) has to survive that, or handing
    // it back returns the reader to the person's front door rather than to the
    // thread they were writing into. Driven: the pane came back on ARTICLES
    // with the pinned conversation gone.
    if (addressStillNames(target)) {
      // `enterFrom` IS A ONE-SHOT AND IT HAS ALREADY BEEN SPENT. It is the box
      // the pane GREW OUT OF on the way in — the inbox it superseded — and a
      // resume is not that arrival: the pane is coming back to a screen with
      // nothing in the place it grew from, so replaying the morph animates it
      // out of a rectangle the reader cannot see. Dropped here rather than in
      // `resume`, because a pane that is suspended has already used it.
      set({ isOpen: false, enterFrom: null });
      return;
    }
    set(CLEARED);
    restore(returnTo);
  },

  setTab: (tab) => set({ tab }),

  resume: () => {
    const { isOpen, target } = get();
    if (isOpen || !target || !addressStillNames(target)) return false;
    // `tab` carries the view the reader had SWITCHED TO, kept current by the
    // pane itself (`setTab`), so a resume lands them where they were rather
    // than on the errand's view again — the pane is a remount, so the view is
    // lost unless the store is holding it.
    set({ isOpen: true });
    return true;
  },

  _handlePop: () => {
    if (!get().isOpen) return;
    const { returnTo } = get();
    set(CLEARED);
    restore(returnTo);
  },
}));
