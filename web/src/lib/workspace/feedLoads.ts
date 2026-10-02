// =============================================================================
// Page-one loads, sequenced per feed (`.claude/rules/web-workspace.md` › *Per-
// feed loads are SEQUENCED*; WORKSPACE-QUEUE-ADR §VI.5, B7).
//
// Two things write a feed's items and cursor — a page-one load and load-more.
// Every page-one load is a GESTURE (a pull, the queue's edge pull, the
// wordmark, a publish, a source added): the reader asked for this read. It
// always runs, and CLAIMS the feed's sequence, so anything older still in
// flight discards its answer instead of merging it (`loadPageOne` →
// "superseded"). The queue once read ahead of the reader as well (an
// APPROACH); it no longer does — nothing is fetched that the reader did not
// pull (the operator, 2026-09-26).
//
// Load-more READS the current token rather than claiming one: a page appended
// to the sequence it was read from is still that sequence.
// =============================================================================

export interface FeedLoads {
  /** Start a page-one read: a new token for the feed, which supersedes every
   *  older one. */
  claim(feedId: string): number;
  /** The feed's newest token (0 before any claim). */
  current(feedId: string): number;
  isCurrent(feedId: string, gen: number): boolean;
}

export function createFeedLoads(): FeedLoads {
  const gen = new Map<string, number>();
  return {
    claim(feedId) {
      const g = (gen.get(feedId) ?? 0) + 1;
      gen.set(feedId, g);
      return g;
    },
    current: (feedId) => gen.get(feedId) ?? 0,
    isCurrent: (feedId, g) => (gen.get(feedId) ?? 0) === g,
  };
}

export type PageOneResult<R> =
  | { status: "applied"; value: R }
  | { status: "superseded" }
  | { status: "failed"; error: unknown };

/**
 * One page-one read: claim, fetch, check the claim is still the feed's newest,
 * and only then `apply`. A read overtaken at
 * any point before `apply` is "superseded" and has written nothing.
 */
export async function loadPageOne<P, R>(
  loads: FeedLoads,
  feedId: string,
  fetch: () => Promise<P>,
  apply: (page: P) => R,
): Promise<PageOneResult<R>> {
  const g = loads.claim(feedId);
  try {
    const page = await fetch();
    if (!loads.isCurrent(feedId, g)) return { status: "superseded" };
    return { status: "applied", value: apply(page) };
  } catch (error) {
    if (!loads.isCurrent(feedId, g)) return { status: "superseded" };
    return { status: "failed", error };
  }
}
