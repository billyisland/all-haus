"use client";

import { useCallback, useEffect, useState } from "react";
import { workspaceFeeds, type WorkspaceFeed } from "../lib/api";
import {
  isFeedFollowable,
  matchFeedSource,
  feedFollowAddInput,
  type FeedFollowTarget,
} from "../lib/follow/feed-follow";
import { apiErrorMessage } from "../lib/api/client";
import { invalidateAuthorCardCache } from "./useAuthorCard";
import { useFollows, useFollowState } from "../stores/follows";

// =============================================================================
// useFeedFollow — the one home for "follow this author/source into a feed".
//
// CLAUDE.md's invariant is that following is FEED-DERIVED: you follow someone
// by putting them in one of your feeds. Since the reach retirement (migration
// 177, §9.16) that is true of NATIVE writers too — the `follows` graph row on
// its own has no feed consequence, so a Follow that writes only the graph row
// is a button whose effect the reader cannot find. On a surface with feed
// context the context decides (the card hover panel inside a vessel writes the
// `account` source into THAT feed). On a FEED-LESS surface nothing decides, so
// the reader is asked — and this hook is the mechanism both pickers run on.
//
// One gesture, one meaning, either side of the native/external seam — and the
// GRAPH ROW IS NOT THIS FILE'S BUSINESS. A native follow is made by putting
// somebody in a feed, so `POST /workspace/feeds/:id/sources` writes the
// `follows` row in the same transaction as the source and `DELETE` drops it
// when the last feed lets go. This hook ticks feeds and reports what the route
// says came of it (`following` on both responses), which is what keeps the
// two composer paths — where you TYPE a member's name rather than press
// Follow — meaning the same thing as the button without a third copy of the
// rule. It wrote the graph itself for one afternoon; that left the write
// split across four client call sites and the composer paths still silent.
//
// MEMBERSHIP IS RESOLVED OVER EVERY FEED, HIDDEN ONES INCLUDED, and the menu
// lists them all. `hidden` is feed character, not deletion: a source sitting in
// a hidden feed is still ingested and still followed. Resolving over visible
// feeds alone would make "in ≥1 feed" lie, and — now that the last feed leaving
// unfollows — would drop a graph follow while a hidden feed still carried the
// source. The external picker filtered `hidden` out before this hook existed.
//
// STRANDED FOLLOWS. A native follow made before the convergence is a `follows`
// row with no `account` source anywhere (dev: 325 of 325 on 2026-09-18), so it
// reads "Following" with nothing ticked and no tick to remove. That state is a
// legacy population, not a shape this hook can produce, and `strandedFollow`
// is its only exit until the backfill is decided (CONSOLIDATED-TODO §9.16's
// open question — materialise, grandfather or drop).
// =============================================================================

// The pure half — the target type, the followable protocols, the membership
// match and the add payload — lives in `lib/follow/feed-follow.ts`, shared with
// modernhaus (which re-runs this sequence on the server and cannot import a
// client file). Re-exported here for the callers and tests that reach it
// through the hook.
export {
  FOLLOWABLE_PROTOCOLS,
  isFeedFollowable,
  matchFeedSource,
  feedFollowAddInput,
  type FeedFollowTarget,
  type ExternalProtocol,
} from "../lib/follow/feed-follow";

/**
 * REPORT WHAT THE ROUTE DID WITH THE GRAPH ROW. One home, because four
 * surfaces now need it and two of them did not have it (§0ab item 6).
 *
 * `POST`/`DELETE /workspace/feeds/:id/sources` answer `following` for an
 * account source — the state AFTER the write, read off `follows` rather than
 * inferred from whether a source survived, which are different facts for any
 * source the member was HANDED. This is a REPORT, never a write: `setLocal`
 * issues no request, and nothing in the browser may create a follow (pinned by
 * `web/tests/follow-feed-frontier.test.ts`).
 *
 * The undefined check is load-bearing in both directions. `following` is absent
 * for every non-account source, where the question does not arise — writing
 * `false` there would clear a real follow off an unrelated writer's label.
 */
export function reportFollowState(
  accountId: string | null | undefined,
  following: boolean | undefined,
): void {
  if (!accountId || following === undefined) return;
  useFollows.getState().setLocal(accountId, following);
}

/**
 * Stop following, everywhere at once — the graph row AND every `account` /
 * external source the viewer's feeds hold for this target.
 *
 * The picker's unfollow is "untick the last feed", which reaches the same
 * state a tick at a time. A list that offers a bare *Unfollow* (the profile's
 * Following view) has no feed in hand and must not leave the sources standing:
 * a writer removed from the graph but still sourced in three feeds keeps
 * arriving, which is the complaint this whole convergence answers, inverted.
 *
 * Sources first, graph last: a half-completed unfollow should leave a follow
 * you can still see, not a feed full of somebody you no longer follow. The
 * route drops a CHOSEN follow's graph row itself when its last source goes, in
 * the same transaction; the closing `unfollow` is for a follow with no source
 * to remove (the legacy exit), and is idempotent where the route got there
 * first.
 *
 * A PARTIAL OUTCOME IS NOT A TOTAL ONE. One feed's removal failing must not
 * abort the others — and must not vanish either: the writer would go on
 * arriving in that feed after a press that reported success. So the loop runs
 * to the end and the shortfall is COUNTED: `skipped` is the number of feeds
 * whose removal failed (or whose sources could not be read), and
 * `feedsUnreadable` says the feed list itself never arrived, in which case no
 * feed was touched and the count means nothing. The graph row is dropped
 * either way. The caller says the shortfall out loud.
 */
export async function unfollowEverywhere(
  target: FeedFollowTarget,
): Promise<{ skipped: number; feedsUnreadable: boolean }> {
  let skipped = 0;
  let feedsUnreadable = false;
  try {
    const { feeds } = await workspaceFeeds.list();
    await Promise.all(
      feeds.map(async (f) => {
        try {
          const { sources } = await workspaceFeeds.listSources(f.id);
          const rowId = matchFeedSource(sources, target);
          if (rowId) await workspaceFeeds.removeSource(f.id, rowId);
        } catch {
          skipped += 1;
        }
      }),
    );
  } catch {
    feedsUnreadable = true;
  }
  if (target.type === "user") {
    await useFollows.getState().unfollow(target.id);
  }
  invalidateAuthorCardCache();
  return { skipped, feedsUnreadable };
}

export interface FeedFollowState {
  /** False ⇒ no follow gesture exists for this target at all. */
  followable: boolean;
  /** The trigger's label: native reads the shared graph store, external reads
   *  "in ≥1 feed" (falling back to the server snapshot until resolved). */
  following: boolean;
  /** The viewer's feeds in `sortRank` order, hidden included. Null until the
   *  first open resolves them; `[]` is a real answer (no feeds yet). */
  feeds: WorkspaceFeed[] | null;
  /** feedId → the `feed_sources` row id, or null when the feed doesn't hold
   *  the target. Null until resolved. */
  membership: Record<string, string | null> | null;
  busyFeeds: Set<string>;
  /** The feed list could not be read — an outage, never "no feeds yet". */
  loadFailed: boolean;
  /** The last failed act's sentence, or null. Every act here is a press, and
   *  a press that fails says so (walkthrough A9/A16's class). */
  error: string | null;
  /** Native, resolved, followed in the graph and in NO feed — the legacy state
   *  with no tick to remove. Drives the one-off Unfollow escape hatch. */
  strandedFollow: boolean;
  toggleFeed: (feedId: string) => Promise<void>;
  /** Create a feed and put the target in it. Returns false on failure so the
   *  caller can keep its input open. */
  createAndFollow: (name: string) => Promise<boolean>;
  /** The stranded exit: drop the graph row alone. */
  dropStrandedFollow: () => Promise<void>;
}

/**
 * @param open  Resolution is lazy and deliberate — pass the picker's own open
 *              state, and the fan-out runs once on first open.
 */
export function useFeedFollow(
  target: FeedFollowTarget,
  open: boolean,
): FeedFollowState {
  const native = target.type === "user";

  // Native follow state is the shared store, so a toggle here re-renders every
  // other mounted follow affordance for this writer. Priming is native-only:
  // an external target's `id` is an author/source id, and seeding it into the
  // native set would make a stranger's id read as a followed writer.
  const graphFollowing = useFollowState(
    native ? target.id : "",
    native ? target.isFollowing : undefined,
  );

  const [feeds, setFeeds] = useState<WorkspaceFeed[] | null>(null);
  const [membership, setMembership] = useState<Record<
    string,
    string | null
  > | null>(null);
  const [busyFeeds, setBusyFeeds] = useState<Set<string>>(new Set());
  const [loadFailed, setLoadFailed] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const followable = isFeedFollowable(target);

  // A source's own id is what membership keys on, so a change of target must
  // discard a resolution belonging to the previous one.
  const targetKey = `${target.type}:${target.id}:${target.sourceId ?? ""}`;
  useEffect(() => {
    setFeeds(null);
    setMembership(null);
    setLoadFailed(false);
    setError(null);
  }, [targetKey]);

  useEffect(() => {
    if (!open || !followable || feeds !== null) return;
    let cancelled = false;
    void workspaceFeeds
      .list()
      .then(async ({ feeds }) => {
        // Hidden feeds stay IN — see the header. Only the order is applied.
        const all = [...feeds].sort((a, b) => a.sortRank - b.sortRank);
        const entries = await Promise.all(
          all.map(async (f) => {
            try {
              const { sources } = await workspaceFeeds.listSources(f.id);
              return [f.id, matchFeedSource(sources, target)] as const;
            } catch {
              return [f.id, null] as const;
            }
          }),
        );
        if (cancelled) return;
        setFeeds(all);
        setMembership(Object.fromEntries(entries));
      })
      .catch(() => {
        // `[]` would render "No feeds yet." — a claim about the member that
        // nothing checked. The outage is its own state.
        if (!cancelled) {
          setFeeds([]);
          setLoadFailed(true);
        }
      });
    return () => {
      cancelled = true;
    };
    // `target` is read inside but keyed by `targetKey`, which the reset effect
    // above already watches — listing it would re-run on every card re-render.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, followable, feeds, targetKey]);

  const setBusy = (feedId: string, on: boolean) =>
    setBusyFeeds((prev) => {
      const next = new Set(prev);
      if (on) next.add(feedId);
      else next.delete(feedId);
      return next;
    });

  const inSomeFeed = membership
    ? Object.values(membership).some(Boolean)
    : null;

  const following = native
    ? graphFollowing
    : (inSomeFeed ?? target.isFollowing);

  const strandedFollow = native && graphFollowing && inSomeFeed === false;

  const toggleFeed = useCallback(
    async (feedId: string) => {
      if (busyFeeds.has(feedId)) return;
      const existing = membership?.[feedId];
      setBusy(feedId, true);
      setError(null);
      try {
        if (existing) {
          const res = await workspaceFeeds.removeSource(feedId, existing);
          setMembership((m) => ({ ...(m ?? {}), [feedId]: null }));
          // The ROUTE decides whether the follow survived — it drops it when
          // the LAST feed lets go, counted across every feed the owner has.
          // Reported rather than computed here: this hook knows the feeds it
          // resolved, the server knows the rest.
          reportFollowState(native ? target.id : null, res.following);
        } else {
          const input = feedFollowAddInput(target);
          if (!input) return;
          const res = await workspaceFeeds.addSource(feedId, input);
          setMembership((m) => ({ ...(m ?? {}), [feedId]: res.source.id }));
          reportFollowState(native ? target.id : null, res.following);
        }
        invalidateAuthorCardCache();
      } catch (err) {
        // Membership is left as it was — and SAID, since the route's refusals
        // (a dead source, a blocked account) are sentences worth reading.
        setError(
          apiErrorMessage(err) ??
            (existing
              ? "Couldn’t take this out of that channel. Nothing has changed."
              : "Couldn’t add this to that channel. Nothing has changed."),
        );
      } finally {
        setBusy(feedId, false);
      }
    },
    [busyFeeds, membership, native, target],
  );

  const createAndFollow = useCallback(
    async (name: string) => {
      const input = feedFollowAddInput(target);
      if (!name.trim() || !input) return false;
      setError(null);
      let feed: WorkspaceFeed;
      try {
        ({ feed } = await workspaceFeeds.create(name.trim()));
      } catch (err) {
        setError(apiErrorMessage(err) ?? "Couldn’t make the channel. Nothing has changed.");
        return false;
      }
      // The feed EXISTS from here, whatever the add does — so it joins the
      // list either way, and a failed add is said as what it is rather than
      // as a create that did not happen.
      setFeeds((prev) => [...(prev ?? []), feed]);
      try {
        const res = await workspaceFeeds.addSource(feed.id, input);
        setMembership((m) => ({ ...(m ?? {}), [feed.id]: res.source.id }));
        reportFollowState(native ? target.id : null, res.following);
        invalidateAuthorCardCache();
        return true;
      } catch (err) {
        setMembership((m) => ({ ...(m ?? {}), [feed.id]: null }));
        setError(
          apiErrorMessage(err) ??
            "The channel was made, but we couldn’t add them to it. Press its row to try again.",
        );
        return true;
      }
    },
    [native, target],
  );

  const dropStrandedFollow = useCallback(async () => {
    setError(null);
    try {
      await useFollows.getState().unfollow(target.id);
    } catch {
      // The store reverts its optimistic update; say so, or the revert reads
      // as a press that never registered.
      setError("Couldn’t unfollow them. Please try again.");
    }
  }, [target.id]);

  return {
    followable,
    following,
    feeds,
    membership,
    busyFeeds,
    loadFailed,
    error,
    strandedFollow,
    toggleFeed,
    createAndFollow,
    dropStrandedFollow,
  };
}
