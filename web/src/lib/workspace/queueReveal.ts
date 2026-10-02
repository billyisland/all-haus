// What a queue pull does with each feed's buffered page one (WORKSPACE-QUEUE-
// ADR §VI.5, *fetched on a timer, shown on a gesture*). `WorkspaceView`'s
// `revealQueueFeeds` is the effectful half; this is the decision, so it can be
// tested without mounting the host.
//
// A buffered page is SHOWN when the feed is not mid-replace and no page-one
// read has been claimed since the page's own read started (`gen`) — a replace
// would otherwise have the posts it took away merged back in. A feed that
// failed to load is shown a buffered page too: `mergeFirstPage` merges onto an
// empty list, and the pull is the reader's way back from COULDN'T LOAD FEED.
// Where such a feed has nothing buffered, it is RELOADED instead, since a pull
// that says "Nothing new" over an error would leave it there for good.
//
// A LOADING feed keeps its buffer: the replace in flight may yet be overtaken
// by it, and it is the page-one token, not this call, that decides.

export type RevealStatus = "loading" | "ready" | "error";

export interface Buffered<P> {
  gen: number;
  page: P;
}

export interface RevealPlan<P> {
  /** Pages to merge in now. */
  show: Map<string, P>;
  /** Failed feeds with nothing to show: read page one afresh (a replace). */
  reload: string[];
  /** Buffer entries spent — shown, or stale for good. */
  drop: string[];
  /** Feeds to read into the buffer for next time. */
  poke: string[];
}

export function planReveal<P>(
  feedIds: readonly string[],
  buffer: ReadonlyMap<string, Buffered<P>>,
  status: (feedId: string) => RevealStatus | undefined,
  currentGen: (feedId: string) => number,
): RevealPlan<P> {
  const plan: RevealPlan<P> = { show: new Map(), reload: [], drop: [], poke: [] };
  for (const id of feedIds) {
    const st = status(id);
    const b = buffer.get(id);
    if (st === undefined || st === "loading") {
      plan.poke.push(id);
      continue;
    }
    // A page older than the last replace can never be shown.
    if (b) plan.drop.push(id);
    if (b && b.gen === currentGen(id)) {
      plan.show.set(id, b.page);
      plan.poke.push(id);
    } else if (st === "error") {
      // The reload reads page one itself; a poke beside it would read it twice.
      plan.reload.push(id);
    } else plan.poke.push(id);
  }
  return plan;
}
