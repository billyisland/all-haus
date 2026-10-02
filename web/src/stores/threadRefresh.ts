import { create } from "zustand";

// =============================================================================
// useThreadRefresh — one tick, every open conversation.
//
// A published reply changes every thread that contains it, and the surfaces
// showing those threads have no other way to find out. `WorkspaceView` had a
// tick for this and its own comment called it "a single global tick" — it was
// local React state, passed to the `PostThread`s that surface renders and to no
// others. So a reply published from the PROFILE pane (the notification's
// pinned conversation, a profile's Posts or Replies log), from `/author`,
// `/source` or `/tag`, left the conversation it was written into unchanged:
// the reader replied to a mention and their own reply was not in the thread.
//
// Worse than stale-until-remount, because `usePostThread` keeps a 60-second
// module cache: closing the pane and opening it again inside that window
// served the same thread back WITHOUT the reply. So the bump invalidates the
// cache as well as advancing the tick — a counter alone would have left the
// remount path quietly wrong, which is the harder half to notice.
//
// Bumped in ONE place, `lib/replies.ts::publishReply`, which every compose
// surface goes through: a callback wired per-surface is how the first version
// came to cover one surface out of four.
//
// AND THE TICK SAYS WHICH CONVERSATION, because "global" was doing two jobs
// and only one of them was wanted. A bare counter reset EVERY mounted
// conversation on every reply: `usePostThread` dropped the cache, dispatched
// `init-start` — pool wiped, `focalId` null — and re-ingested with
// `root: true`. So a conversation the reader had re-rooted inside lost the
// re-root and snapped back to its root; `PostThread` flashed "Loading…"; and
// its autoScroll effect fired `scrollIntoView` again, which scrolls every
// scrollable ancestor including the floor viewport. Reply to a pinned thread
// in the profile pane and a vessel behind the scrim panned to a conversation
// nobody was looking at.
//
// So the tick carries the reply's target and a thread refetches only when its
// POOL contains that post — and refetches IN PLACE, folding the new reply in
// with `merge` (which deliberately leaves root, focal and loading alone)
// rather than starting over. The cache invalidation stays global and
// unaddressed: it is cheap, and a cached thread that does contain the reply is
// wrong wherever it is served from.
// =============================================================================

import { invalidateThreadCache } from "../hooks/usePostThread";

interface ThreadRefreshState {
  tick: number;
  /** The Nostr event id of the post the reply was made ON — what says WHICH
   *  conversation changed. See the addressing note above. */
  targetEventId: string | null;
  bump: (targetEventId: string) => void;
}

export const useThreadRefresh = create<ThreadRefreshState>((set) => ({
  tick: 0,
  targetEventId: null,
  bump: (targetEventId) => {
    invalidateThreadCache();
    set((s) => ({ tick: s.tick + 1, targetEventId }));
  },
}));
