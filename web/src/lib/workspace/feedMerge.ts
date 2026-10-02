// =============================================================================
// mergeFirstPage — a refreshed page one, joined onto what the reader already
// has loaded (WORKSPACE-QUEUE-ADR §VI.5, B7).
//
// The floor's refresh REPLACES a feed's items with page one: the paged-down
// tail is thrown away and the list starts again. The queue refreshes a feed the
// reader may be half-way down, and a feed ahead of them whose preview they have
// already read, so it MERGES: `page ++ (loaded \ page)`, deduped by `Post.id`.
//
// A splice is only honest where the two halves provably TOUCH, and there are
// two ways they may not:
//
//   · NO CONTACT. Page one shares no post with what was loaded and is a full
//     page, so more arrived than one page holds and there is a run between
//     page one's oldest and the old head that nobody fetched. Splicing would
//     leave a hole the cursor never revisits. The tail is discarded and page
//     one taken alone ("20+ new · feed reloaded").
//   · A BACKDATED ARRIVAL. A window post whose `publishedAt` falls inside the
//     loaded range — at or below page one's oldest, at or above the tail's
//     oldest — but that is not in the merged list. It landed mid-timeline, in
//     the gap between page one and the tail even though they overlap; it is
//     counted in the badge and could never be rendered, so nobody could pass
//     it. The tail is discarded too ("feed reloaded").
//
// Discarding the tail loses the reader's paged position, which is honest; it
// costs no count, because counts come from the window, never from the list.
//
// Page one is AUTHORITATIVE for the range it covers. The tail is what was
// loaded BELOW the deepest post the two share, so a post that was loaded above
// that point and is no longer in page one (deleted, muted, cut) goes, rather
// than being carried along out of timeline order. A page one shorter than a
// full page is the whole feed, so it is taken as it stands.
// =============================================================================

/** The page size every page-one fetch asks for, so "a full page" is the
 *  client's own claim rather than a reading of the gateway's default. */
export const FEED_PAGE_SIZE = 20;

export interface MergeItem {
  id: string;
  /** Unix seconds — `Post.publishedAt`, and the window's own unit. */
  publishedAt: number;
}

export type MergeOutcome =
  /** Nothing was loaded before: page one taken as it is. */
  | { kind: "first"; newCount: number }
  /** Page one joined onto the tail (or, short, was the whole feed). */
  | { kind: "spliced"; newCount: number }
  /** The tail was discarded and page one taken alone — or, `failed`, the
   *  feed had failed to load and had nothing buffered, so the queue's reveal
   *  read page one afresh (never this module; `queueReveal.ts`). */
  | { kind: "reloaded"; reason: "no-contact" | "backdated" | "failed"; newCount: number };

export interface MergeResult<T> {
  items: T[];
  /** Keep the cursor the tail was paged with; otherwise take page one's. */
  keepCursor: boolean;
  outcome: MergeOutcome;
}

export function mergeFirstPage<T extends MergeItem>(
  loaded: readonly T[],
  page: readonly T[],
  opts: { pageSize: number; window?: readonly MergeItem[] },
): MergeResult<T> {
  const pageIds = new Set(page.map((p) => p.id));
  const loadedIds = new Set(loaded.map((l) => l.id));
  // Only choosing between "N new" and the empty-pull rule; the figure a badge
  // shows is the window's (§VI.5).
  const newCount = page.reduce((n, p) => n + (loadedIds.has(p.id) ? 0 : 1), 0);
  const alone = (outcome: MergeOutcome): MergeResult<T> => ({
    items: [...page],
    keepCursor: false,
    outcome,
  });

  if (loaded.length === 0) return alone({ kind: "first", newCount });
  // Short: the page IS the feed, down to its end.
  if (page.length < opts.pageSize) return alone({ kind: "spliced", newCount });

  let contact = -1;
  for (let i = loaded.length - 1; i >= 0; i--) {
    if (pageIds.has(loaded[i].id)) {
      contact = i;
      break;
    }
  }
  if (contact < 0) return alone({ kind: "reloaded", reason: "no-contact", newCount });

  const tail = loaded.slice(contact + 1).filter((l) => !pageIds.has(l.id));
  const items = [...page, ...tail];

  if (opts.window && tail.length > 0 && page.length > 0) {
    const hi = Math.min(...page.map((p) => p.publishedAt));
    const lo = Math.min(...tail.map((t) => t.publishedAt));
    const have = new Set(items.map((i) => i.id));
    const gap = opts.window.some(
      (w) => w.publishedAt <= hi && w.publishedAt >= lo && !have.has(w.id),
    );
    if (gap) return alone({ kind: "reloaded", reason: "backdated", newCount });
  }

  return { items, keepCursor: tail.length > 0, outcome: { kind: "spliced", newCount } };
}
