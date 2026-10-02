// The queue mode's model (WORKSPACE-QUEUE-ADR §V). Pure: no React, no DOM, no
// store, and no counts of its own — the caller hands in fresh FeedFacts on
// every operation that needs them, so a count can never go stale in here.
//
// The queue is one left-to-right sequence of keys (the visible feed ids) with
// exactly one FOCAL key. Left of
// focal are LINES (feeds passed); right of focal are the feeds AHEAD.
//
// Three rules carry the design, and every operation below is written to them:
//
//   1. SORTING IS NOT LIVE. Only `arrival`, `refreshed`, `refreshedEmpty` and
//      `reconcile` sort; stepping, settling, hiding and restoring never do.
//      Reading never moves a feed.
//   2. EVERY SORT IS A RECONCILE. All four triggers run through `resort`, which
//      first makes the keys agree with the facts it was handed (drop deleted
//      and hidden ids, append unknown visible ones) — so a sort
//      never reads a fact it was not given, and the invariants hold after it
//      whatever the caller's facts did in the meantime.
//   3. A DWELL IS A FACT ABOUT ONE STAY (invariant 7). `settled` holds only
//      keys at or left of focal; a feed leaves it whenever it goes ahead.
//      Without that, a feed dwelt on once, brought back by an arrival and
//      then walked past would stay buried as a line with new posts in it.
//
// One sanctioned departure from the letter of §V, recorded in its as-built
// note: an empty queue (no visible feeds) has `focal: null`.
//
// HIDDEN FEEDS ARE NOT IN THE QUEUE (§VII.4 as amended 2026-09-26). The tray
// was a key — always last, walked to like a feed — until the operator made
// each hidden feed a bar after the last entry that restores on a click and
// that no swipe or walk ever lands on. So nothing here knows a hidden feed
// exists beyond dropping it from the keys.

/** A visible feed's id. */
export type QueueKey = string;

export interface QueueState {
  /** Left → right. */
  readonly keys: readonly QueueKey[];
  /** An element of `keys` — or null iff `keys` is empty. Always an id, never an index. */
  readonly focal: QueueKey | null;
  /** Dwelt on while focal, during the current stay at or left of focal. */
  readonly settled: ReadonlySet<string>;
}

/** Supplied by the caller, never stored in QueueState. */
export interface FeedFacts {
  id: string;
  sortRank: number;
  hidden: boolean;
  newCount: number;
  unreadCount: number;
}

export type Facts = ReadonlyMap<string, FeedFacts>;

export function factsOf(feeds: Iterable<FeedFacts>): Facts {
  const m = new Map<string, FeedFacts>();
  for (const f of feeds) m.set(f.id, f);
  return m;
}

/** 0: has new · 1: unread, nothing new · 2: nothing unread. */
export function tier(f: FeedFacts): 0 | 1 | 2 {
  return f.newCount > 0 ? 0 : f.unreadCount > 0 ? 1 : 2;
}

/** Tier, then sortRank, then id — a TOTAL order, so a sort's result does not
 *  depend on the order it was handed its input in. */
export function cmp(a: FeedFacts, b: FeedFacts): number {
  return (
    tier(a) - tier(b) ||
    a.sortRank - b.sortRank ||
    (a.id < b.id ? -1 : a.id > b.id ? 1 : 0)
  );
}

function isVisibleFeed(k: QueueKey, facts: Facts): boolean {
  const f = facts.get(k);
  return f !== undefined && !f.hidden;
}

function sortIds(ids: readonly string[], facts: Facts): string[] {
  return ids
    .map((k) => facts.get(k) as FeedFacts)
    .sort(cmp)
    .map((f) => f.id);
}

/** The key now at `idx`, clamped. */
function pickAt(keys: readonly QueueKey[], idx: number): QueueKey | null {
  if (keys.length === 0) return null;
  return keys[Math.min(Math.max(idx, 0), keys.length - 1)];
}

/** Invariant 7: settled ⊆ the feed keys at or left of focal. */
function trimSettled(s: QueueState): QueueState {
  if (s.settled.size === 0) return s;
  const p = s.keys.indexOf(s.focal as QueueKey); // −1 for a null focal: nothing is behind
  const behind = new Set(s.keys.slice(0, p + 1));
  const settled = new Set([...s.settled].filter((k) => behind.has(k)));
  return settled.size === s.settled.size ? s : { ...s, settled };
}

/** The one sort. Reconciles the keys with `facts`, then rejoins every skipped
 *  line with anything unread, then sorts the feeds ahead by `cmp`. */
function resort(s: QueueState, facts: Facts): QueueState {
  const oldIdx = s.focal === null ? 0 : s.keys.indexOf(s.focal);
  const known = new Set(s.keys);
  const kept = s.keys.filter((k) => isVisibleFeed(k, facts));
  const fresh = [...facts.values()]
    .filter((f) => !f.hidden && !known.has(f.id))
    .map((f) => f.id);

  let focal = s.focal;
  if (focal === null || !isVisibleFeed(focal, facts)) {
    focal = pickAt([...kept, ...fresh], oldIdx);
  }
  if (focal === null) return { keys: [], focal: null, settled: new Set() };

  const all = [...kept, ...fresh];
  const p = all.indexOf(focal);
  const behind = all.slice(0, p);
  const back = behind.filter(
    (k) => !s.settled.has(k) && tier(facts.get(k) as FeedFacts) < 2,
  );
  const lines = behind.filter((k) => !back.includes(k));
  const ahead = sortIds([...all.slice(p + 1), ...back], facts);
  return trimSettled({
    keys: [...lines, focal, ...ahead],
    focal,
    settled: s.settled,
  });
}

// ── Operations (§V.3) ────────────────────────────────────────────────────────

/** A fresh sort with focal at the head, no lines, nothing settled (§V.6). */
export function init(facts: Facts): QueueState {
  return resort({ keys: [], focal: null, settled: new Set() }, facts);
}

/** One step. `step(−1)` puts the old focal at the FRONT of ahead, whatever its
 *  tier — moving back must feel spatial (§V.4) — and out of `settled`. */
export function step(s: QueueState, dir: 1 | -1): QueueState {
  if (s.focal === null) return s;
  const next = s.keys[s.keys.indexOf(s.focal) + dir];
  if (next === undefined) return s;
  return trimSettled({ ...s, focal: next });
}

/** The focal feed met dwell. A settle for anything but the focal feed is a
 *  timer that outlived its stay, and is ignored. */
export function settle(s: QueueState, feedId: string): QueueState {
  if (feedId !== s.focal || s.settled.has(feedId)) return s;
  return { ...s, settled: new Set([...s.settled, feedId]) };
}

/** New posts were revealed on `feedId`, which is not focal (reached through
 *  `refreshed`). A line leaves the lines (and `settled`) and joins the feeds
 *  ahead; then the sort. */
export function arrival(s: QueueState, feedId: string, facts: Facts): QueueState {
  if (feedId === s.focal) return resort(s, facts);
  const i = s.keys.indexOf(feedId);
  if (i < 0) return s; // hidden or unknown
  const p = s.keys.indexOf(s.focal as QueueKey);
  let keys = s.keys;
  if (i < p) keys = [...keys.slice(0, i), ...keys.slice(i + 1, p + 1), feedId, ...keys.slice(p + 1)];
  return resort({ ...s, keys }, facts); // its trim drops the feed from `settled`
}

/** A reveal on `feedId` found new posts. On a feed ahead — or when focal has
 *  moved on before the deferred sort ran — that is an arrival on a feed that
 *  is not focal. */
export function refreshed(s: QueueState, feedId: string, facts: Facts): QueueState {
  return feedId === s.focal ? resort(s, facts) : arrival(s, feedId, facts);
}

/** The reader's pull on `feedId` found nothing. Sort first; then, only if the
 *  feed is focal AND finished (tier 2), focus the key after it if that is a
 *  feed. A tier-1 feed stays (the mouth says "N unread below"); with nothing
 *  ahead, it stays. The view reads which happened off `focal`. */
export function refreshedEmpty(s: QueueState, feedId: string, facts: Facts): QueueState {
  const sorted = resort(s, facts);
  if (feedId !== sorted.focal) return sorted;
  if (tier(facts.get(feedId) as FeedFacts) < 2) return sorted;
  const next = sorted.keys[sorted.keys.indexOf(feedId) + 1];
  return next !== undefined ? { ...sorted, focal: next } : sorted;
}

/** `feedId` was hidden. It leaves the keys (and `settled`). If it was focal,
 *  focus passes to the key now at its old index, clamped. No sort. */
export function hide(s: QueueState, feedId: string): QueueState {
  const i = s.keys.indexOf(feedId);
  if (i < 0) return s;
  const keys = s.keys.filter((k) => k !== feedId);
  const focal = s.focal === feedId ? pickAt(keys, i) : s.focal;
  return trimSettled({ keys, focal, settled: s.settled });
}

/** `feedId` was restored (its facts already say visible). No sort: into an
 *  empty queue it becomes focal; otherwise it goes to the first index right of
 *  focal whose feed it sorts before, or last. The other feeds ahead do not
 *  move (§V.4), and focal stays where the reader is. */
export function restore(s: QueueState, feedId: string, facts: Facts): QueueState {
  const f = facts.get(feedId);
  if (f === undefined || f.hidden || s.keys.includes(feedId)) return s;
  const feeds = s.keys;
  if (s.focal === null) {
    return { keys: [feedId], focal: feedId, settled: s.settled };
  }
  const p = feeds.indexOf(s.focal);
  let at = feeds.length;
  for (let j = p + 1; j < feeds.length; j++) {
    const g = facts.get(feeds[j]);
    if (g !== undefined && cmp(f, g) < 0) {
      at = j;
      break;
    }
  }
  return {
    keys: [...feeds.slice(0, at), feedId, ...feeds.slice(at)],
    focal: s.focal,
    settled: s.settled,
  };
}

/** The feed set changed underneath (created, deleted, hidden or restored
 *  elsewhere). Drop what is gone, append what is new, and if
 *  focal was dropped take the key now at its old index; then the sort. */
export function reconcile(s: QueueState, facts: Facts): QueueState {
  return resort(s, facts);
}

// ── The feed set, as the host changes it (§VII.11) ──────────────────────────

/** The last hide or restore the queue applied, and the states either side of
 *  it — what a refused PATCH takes back. */
export interface Toggle {
  readonly feedId: string;
  /** What the feed became. */
  readonly hidden: boolean;
  readonly before: QueueState;
  readonly after: QueueState;
}

/** Two states that say the same thing (a state is rebuilt, never mutated, so
 *  identity is too strict). */
export function sameQueue(a: QueueState, b: QueueState): boolean {
  return (
    a.focal === b.focal &&
    a.keys.length === b.keys.length &&
    a.keys.every((k, i) => k === b.keys[i]) &&
    a.settled.size === b.settled.size &&
    [...a.settled].every((k) => b.settled.has(k))
  );
}

/** The host's feed set moved from `prev` to `next` (id → hidden). A feed going
 *  hidden is `hide`, going visible is `restore`, created or deleted is
 *  `reconcile` — so the focal bar's ×, a hidden bar's click, a change made in
 *  FeedComposer and an optimistic revert all take this one path.
 *
 *  A REVERT PUTS THE READER BACK. When the one change is the inverse of the
 *  `last` toggle and nothing has moved the queue since (`s` is still what
 *  that toggle produced), the queue returns to the state before it, exactly:
 *  a refused hide leaves the feed focal where it was — where the inverse
 *  operation alone would leave focal on its neighbour with the feed ahead. If
 *  anything moved in between, the inverse operation is the honest answer.
 *
 *  Returns the toggle this change made, for the next call; `last` is read,
 *  never written, so a caller may run this inside a state updater. */
export function feedSetChanged(
  s: QueueState,
  prev: ReadonlyMap<string, boolean>,
  next: ReadonlyMap<string, boolean>,
  facts: Facts,
  last: Toggle | null,
): { state: QueueState; toggle: Toggle | null } {
  let structural = false;
  const flips: [string, boolean][] = [];
  for (const [id, hidden] of next) {
    const was = prev.get(id);
    if (was === undefined) structural = true;
    else if (was !== hidden) flips.push([id, hidden]);
  }
  for (const id of prev.keys()) if (!next.has(id)) structural = true;

  if (!structural && flips.length === 1) {
    const [id, hidden] = flips[0];
    if (
      last !== null &&
      last.feedId === id &&
      last.hidden !== hidden &&
      sameQueue(s, last.after)
    ) {
      return { state: last.before, toggle: null };
    }
    const after = hidden ? hide(s, id) : restore(s, id, facts);
    return { state: after, toggle: { feedId: id, hidden, before: s, after } };
  }

  let out = s;
  for (const [id, hidden] of flips) {
    out = hidden ? hide(out, id) : restore(out, id, facts);
  }
  return { state: structural ? reconcile(out, facts) : out, toggle: null };
}

// ── Invariants (§V.2) ────────────────────────────────────────────────────────

/** Every invariant `s` violates against `facts`, as sentences; empty when
 *  legal. Invariant 2 (the tray) is retired, its number kept so the ADR's
 *  numbering still reads. Invariants 4 and 5 are claims about the state right after a sort,
 *  so they are checked only when `afterSort`. Invariant 6 is relational (a
 *  claim about an operation, not a state) and lives in the tests. */
export function queueViolations(
  s: QueueState,
  facts: Facts,
  afterSort: boolean,
): string[] {
  const out: string[] = [];
  const feeds = s.keys;
  const visible = [...facts.values()].filter((f) => !f.hidden).map((f) => f.id);

  // 1. Each visible feed exactly once; no hidden or unknown id.
  if (new Set(feeds).size !== feeds.length) out.push("1: a feed appears twice");
  for (const id of visible) if (!feeds.includes(id)) out.push(`1: visible ${id} missing`);
  for (const k of feeds) if (!isVisibleFeed(k, facts)) out.push(`1: ${k} is hidden or unknown`);

  // 3. focal ∈ keys; null only for an empty queue.
  if (s.focal === null ? s.keys.length > 0 : !s.keys.includes(s.focal)) {
    out.push(`3: focal ${String(s.focal)} not in keys`);
  }

  const p = s.focal === null ? -1 : s.keys.indexOf(s.focal);

  // 7. settled ⊆ the feed keys at or left of focal.
  for (const k of s.settled) {
    const i = s.keys.indexOf(k);
    if (i < 0 || i > p) out.push(`7: ${k} settled but not at or left of focal`);
  }

  if (afterSort && s.focal !== null) {
    // 4. The feeds ahead are in `cmp` order.
    const ahead = s.keys.slice(p + 1);
    for (let j = 1; j < ahead.length; j++) {
      const a = facts.get(ahead[j - 1]);
      const b = facts.get(ahead[j]);
      if (a && b && cmp(a, b) > 0) out.push(`4: ${a.id} before ${b.id}`);
    }
    // 5. No skipped line with anything unread.
    for (const k of s.keys.slice(0, p)) {
      const f = facts.get(k);
      if (f && !s.settled.has(k) && tier(f) < 2) out.push(`5: skipped line ${k} has unread`);
    }
  }
  return out;
}
