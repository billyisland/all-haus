"use client";

// =============================================================================
// FollowingTab — tier 4's Following view, a card log (PROFILE-PANE-REDESIGN-ADR
// D11 as amended 2026-09-02). One `PersonCard` per followed writer in the same
// `FEED_LOG_STYLE` column the Articles/Posts/Replies logs run, so the five
// views under one button row read as one surface. The own-profile action
// cluster (subscribe / subscribed / unfollow) rides the card's `trailing` slot,
// beside the identity link rather than inside it.
//
// A FAILED FETCH IS ITS OWN BRANCH, and this is the view that proved why:
// `GET /writers/:username/following` 500'd for its whole life on a column that
// does not exist, and the swallowed response rendered as "Not following anyone
// yet" — a confident claim about the member, on every profile there has ever
// been (the *outage renders as an outage* rule, web/CLAUDE.md). The count on
// the button was the only thing that made it visible; with the counts off the
// row, the branch is what carries it.
// =============================================================================

import { useState, useEffect, useRef, useCallback } from "react";
import { PersonCard } from "./PersonCard";
import { FEED_LOG_STYLE } from "./ProfileChrome";
import { formatDateFromISO } from "../../lib/format";
import type { VesselPalette } from "../workspace/tokens";
import { account, subscribe as apiSubscribe, subscriptions as subscriptionsApi, type MySubscription } from "../../lib/api";
import { unfollowEverywhere } from "../../hooks/useFeedFollow";
import { request, failureSentence } from "../../lib/api/client";
import { mapSubscribeError } from "../../lib/subscribe-errors";
import { ConfirmDialog } from "../ui/ConfirmDialog";
import { ProfileLink } from "../ui/ProfileLink";

interface Following {
  id: string;
  username: string;
  displayName: string | null;
  avatar: string | null;
  followedAt: string;
  subscriptionPricePence: number;
  hasPaywalledArticle: boolean;
}

interface PublicSubscription {
  writerId: string;
  writerUsername: string;
  writerDisplayName: string | null;
  writerAvatar: string | null;
  startedAt: string;
}

export function FollowingTab({
  username,
  isOwnProfile,
  palette,
}: {
  username: string;
  isOwnProfile: boolean;
  palette: VesselPalette;
}) {
  const [following, setFollowing] = useState<Following[]>([]);
  const [total, setTotal] = useState(0);
  const [subscriptions, setSubscriptions] = useState<PublicSubscription[]>([]);
  const [mySubs, setMySubs] = useState<Map<string, MySubscription>>(new Map());
  const [loading, setLoading] = useState(true);
  const [failed, setFailed] = useState(false);
  const [loadingMore, setLoadingMore] = useState(false);
  // A failed page SAYS so under the button, which stays as the retry.
  const [moreError, setMoreError] = useState<string | null>(null);
  const [unfollowingId, setUnfollowingId] = useState<string | null>(null);
  const [actionLoadingId, setActionLoadingId] = useState<string | null>(null);
  const [confirmUnsubId, setConfirmUnsubId] = useState<string | null>(null);
  const unsubAnchorRef = useRef<HTMLElement | null>(null);
  const [unsubError, setUnsubError] = useState<string | null>(null);
  // The row is gone once unfollowed, so a partial outcome is said at the list.
  const [unfollowShortfall, setUnfollowShortfall] = useState<string | null>(null);
  // ONE LINE PER ROW, SAID OUT LOUD (walkthrough A9). Every act on this list
  // used to end in `catch { /* silently fail */ }`, so a reader pressing
  // Subscribe with no card, a declined card, un-accepted Reader Terms or a
  // writer not on sale saw nothing happen at all — while the same press on the
  // writer's profile explained each. `needsTerms` cannot be answered here (the
  // consent replaces the control, and it lives on the profile), so that one
  // sends the member there.
  const [rowError, setRowError] = useState<{
    id: string;
    message: string;
    needsTerms?: boolean;
  } | null>(null);

  useEffect(() => {
    // The same `cancelled` guard `FollowersTab` got in the same commit, and for
    // the same reason: `username` is a prop, so it can change mid-fetch, and
    // without this the PREVIOUS profile's list (or its `failed` state) lands in
    // the new profile's pane. Every setter below the awaits is behind it.
    let cancelled = false;
    async function load() {
      setLoading(true);
      setFailed(false);
      try {
        const [followData, subData, mySubData] = await Promise.all([
          request<{ following?: Following[]; total?: number }>(
            `/writers/${username}/following?limit=30`,
          ).catch(() => null),
          request<{ subscriptions?: PublicSubscription[] }>(
            `/writers/${username}/subscriptions?limit=50`,
          ).catch(() => null),
          isOwnProfile ? account.getMySubscriptions() : Promise.resolve(null),
        ]);
        if (cancelled) return;

        if (followData) {
          setFollowing(followData.following ?? []);
          setTotal(followData.total ?? 0);
        } else {
          // The list itself failed. The subscriptions leg is secondary — its
          // own failure leaves that section absent, which is not a claim.
          setFailed(true);
        }
        if (subData) setSubscriptions(subData.subscriptions ?? []);
        if (mySubData) {
          const map = new Map<string, MySubscription>();
          for (const s of mySubData.subscriptions) {
            map.set(s.writerId, s);
          }
          setMySubs(map);
        }
      } catch {
        if (!cancelled) setFailed(true);
      } finally {
        if (!cancelled) setLoading(false);
      }
    }
    void load();
    return () => {
      cancelled = true;
    };
  }, [username, isOwnProfile]);

  async function loadMore() {
    setLoadingMore(true);
    setMoreError(null);
    try {
      const data = await request<{ following?: Following[] }>(
        `/writers/${username}/following?limit=30&offset=${following.length}`,
      );
      setFollowing((prev) => [...prev, ...(data.following ?? [])]);
    } catch (err) {
      setMoreError(failureSentence(err, "Couldn’t load the next page. Please try again."));
    } finally {
      setLoadingMore(false);
    }
  }

  // Unfollow here is the WHOLE act: the graph row and every feed source the
  // viewer holds for this writer. Two things it must not do, and it did both.
  // It bypassed the shared `useFollows` store with a raw DELETE, so a Follow
  // button mounted anywhere else went on reading "Following" (the stale-label
  // bug the store exists to prevent); and since the convergence a graph row
  // removed on its own leaves the `account` sources standing, so the writer
  // keeps arriving in the feeds of somebody who just unfollowed them.
  async function handleUnfollow(writerId: string) {
    setUnfollowingId(writerId);
    setRowError(null);
    setUnfollowShortfall(null);
    try {
      const { skipped, feedsUnreadable } = await unfollowEverywhere({
        type: "user",
        id: writerId,
        isFollowing: true,
      });
      setFollowing((prev) => prev.filter((f) => f.id !== writerId));
      setTotal((prev) => prev - 1);
      // The follow is gone either way; a feed that still carries them is a
      // shortfall the member needs to hear about, or their posts keep
      // arriving after a press that looked complete.
      if (feedsUnreadable || skipped > 0) {
        setUnfollowShortfall(
          feedsUnreadable
            ? "Unfollowed. We couldn’t check your channels, though, so any that carried their posts still do. Use Follow ▾ on their profile to see."
            : `Unfollowed, but ${skipped === 1 ? "one channel" : `${skipped} channels`} still carr${skipped === 1 ? "ies" : "y"} their posts. Use Follow ▾ on their profile to take them out of ${skipped === 1 ? "it" : "them"}.`,
        );
      }
    } catch {
      // The store reverts its optimistic update and the row stays — which,
      // said nothing, looked exactly like a press that had not registered.
      setRowError({ id: writerId, message: "Couldn’t unfollow them. Please try again." });
    } finally {
      setUnfollowingId(null);
    }
  }

  async function handleSubscribe(writerId: string) {
    setActionLoadingId(writerId);
    setRowError(null);
    try {
      const result = await apiSubscribe(writerId, { period: "monthly" });
      setMySubs((prev) => {
        const next = new Map(prev);
        next.set(writerId, {
          id: result.subscriptionId,
          writerId,
          writerUsername: "",
          writerDisplayName: null,
          writerAvatar: null,
          pricePence: result.pricePence,
          status: "active",
          autoRenew: true,
          currentPeriodEnd: result.currentPeriodEnd ?? "",
          startedAt: new Date().toISOString(),
          cancelledAt: null,
          hidden: false,
          notifyOnPublish: true,
        });
        return next;
      });
    } catch (err) {
      const view = mapSubscribeError(err);
      setRowError({ id: writerId, message: view.message, needsTerms: view.needsTerms });
    } finally {
      setActionLoadingId(null);
    }
  }

  const UNSUB_FAILED = "Couldn't cancel — you are still subscribed. Try again.";

  async function handleUnsubscribe(writerId: string) {
    setActionLoadingId(writerId);
    setUnsubError(null);
    try {
      const data = await subscriptionsApi.unsubscribe(writerId);
      setMySubs((prev) => {
        const next = new Map(prev);
        const existing = next.get(writerId);
        if (existing) {
          next.set(writerId, {
            ...existing,
            status: "cancelled",
            autoRenew: false,
            cancelledAt: new Date().toISOString(),
            currentPeriodEnd: data.accessUntil,
          });
        }
        return next;
      });
      setConfirmUnsubId(null);
    } catch {
      // A refusal must not close the dialog as though it had worked.
      setUnsubError(UNSUB_FAILED);
    } finally {
      setActionLoadingId(null);
    }
  }

  async function handleResubscribe(writerId: string) {
    setActionLoadingId(writerId);
    setRowError(null);
    try {
      const result = await apiSubscribe(writerId, { period: "monthly" });
      setMySubs((prev) => {
        const next = new Map(prev);
        next.set(writerId, {
          id: result.subscriptionId,
          writerId,
          writerUsername: "",
          writerDisplayName: null,
          writerAvatar: null,
          pricePence: result.pricePence,
          status: "active",
          autoRenew: true,
          currentPeriodEnd: result.currentPeriodEnd ?? "",
          startedAt: new Date().toISOString(),
          cancelledAt: null,
          hidden: false,
          notifyOnPublish: true,
        });
        return next;
      });
    } catch (err) {
      const view = mapSubscribeError(err);
      setRowError({ id: writerId, message: view.message, needsTerms: view.needsTerms });
    } finally {
      setActionLoadingId(null);
    }
  }

  if (loading) {
    return (
      <div
        className="py-10 text-center text-ui-sm"
        style={{ color: palette.cardMeta }}
      >
        Loading…
      </div>
    );
  }

  if (failed) {
    return (
      <p className="text-ui-sm py-10" style={{ color: palette.cardMeta }}>
        Couldn&rsquo;t load this list. Nothing is missing — try again in a
        moment.
      </p>
    );
  }

  const confirmWriter = confirmUnsubId
    ? following.find((f) => f.id === confirmUnsubId)
    : null;
  const confirmSub = confirmUnsubId ? mySubs.get(confirmUnsubId) : null;

  return (
    <div>
      {/* Unsubscribe confirmation — the house dialog, hung off the
          Subscribed button. It was a hand-rolled `fixed inset-0` scrim inside
          the profile's Glasshouse (walkthrough A12). */}
      <ConfirmDialog
        anchorRef={unsubAnchorRef}
        open={confirmUnsubId !== null && !!confirmWriter}
        title="Cancel subscription?"
        confirmLabel="Cancel subscription"
        busy={confirmUnsubId !== null && actionLoadingId === confirmUnsubId}
        error={unsubError}
        onConfirm={() => {
          if (confirmUnsubId) void handleUnsubscribe(confirmUnsubId);
        }}
        onCancel={() => {
          setConfirmUnsubId(null);
          setUnsubError(null);
        }}
      >
        <p>
          Your subscription to{" "}
          <strong className="text-black">
            {confirmWriter?.displayName ?? confirmWriter?.username}
          </strong>{" "}
          stays active until the end of the current period
          {confirmSub?.currentPeriodEnd && (
            <>
              {" "}
              (
              {new Date(confirmSub.currentPeriodEnd).toLocaleDateString(
                "en-GB",
                { day: "numeric", month: "long", year: "numeric" },
              )}
              )
            </>
          )}
          . You won&rsquo;t be charged again.
        </p>
      </ConfirmDialog>

      {unfollowShortfall && (
        <p className="text-ui-xs text-crimson mb-3">{unfollowShortfall}</p>
      )}

      {/* Following list */}
      {following.length === 0 ? (
        <p className="text-ui-sm py-10" style={{ color: palette.cardMeta }}>
          Not following anyone yet.
        </p>
      ) : (
        <div style={FEED_LOG_STYLE}>
          {following.map((f) => {
            const sub = mySubs.get(f.id);
            const sellsSubscriptions =
              f.hasPaywalledArticle && f.subscriptionPricePence > 0;
            const isActive = sub?.status === "active";
            const isCancelled = sub?.status === "cancelled";

            return (
              <div key={f.id}>
              <PersonCard
                palette={palette}
                href={`/${f.username}`}
                avatar={f.avatar}
                name={f.displayName ?? f.username}
                handle={`@${f.username}`}
                trailing={
                  isOwnProfile ? (
                    <>
                      {/* Subscription actions */}
                      {sellsSubscriptions && !isActive && !isCancelled && (
                        <button
                          onClick={() => handleSubscribe(f.id)}
                          disabled={actionLoadingId === f.id}
                          className="btn-accent py-1 px-3 text-[11px] disabled:opacity-50 transition-colors"
                        >
                          {actionLoadingId === f.id
                            ? "…"
                            : `Subscribe £${(f.subscriptionPricePence / 100).toFixed(2)}/mo`}
                        </button>
                      )}
                      {isActive && (
                        <button
                          onClick={(e) => {
                            unsubAnchorRef.current = e.currentTarget;
                            setUnsubError(null);
                            setConfirmUnsubId(f.id);
                          }}
                          disabled={actionLoadingId === f.id}
                          className="btn-soft py-1 px-3 text-[11px] disabled:opacity-50 transition-colors"
                        >
                          {actionLoadingId === f.id ? "…" : "Subscribed"}
                        </button>
                      )}
                      {isCancelled && (
                        <button
                          onClick={() => handleResubscribe(f.id)}
                          disabled={actionLoadingId === f.id}
                          className="btn-soft py-1 px-3 text-[11px] text-red-600 disabled:opacity-50 transition-colors"
                          title={
                            sub?.currentPeriodEnd
                              ? `Access until ${new Date(sub.currentPeriodEnd).toLocaleDateString("en-GB", { day: "numeric", month: "short" })}`
                              : undefined
                          }
                        >
                          {actionLoadingId === f.id
                            ? "…"
                            : "Cancelled — resubscribe"}
                        </button>
                      )}

                      {/* Unfollow */}
                      <button
                        onClick={() => handleUnfollow(f.id)}
                        disabled={unfollowingId === f.id}
                        className="btn-ghost py-1 px-3 text-[11px] hover:text-red-600 disabled:opacity-50 transition-colors"
                        style={{ color: palette.cardMeta }}
                      >
                        {unfollowingId === f.id ? "…" : "Unfollow"}
                      </button>
                    </>
                  ) : (
                    <time
                      className="text-ui-xs"
                      style={{ color: palette.cardMeta }}
                    >
                      {formatDateFromISO(f.followedAt)}
                    </time>
                  )
                }
              />
              {rowError?.id === f.id && (
                <p className="text-ui-xs text-crimson mt-2 px-1">
                  {rowError.message}
                  {rowError.needsTerms && (
                    <>
                      {" "}
                      <ProfileLink href={`/${f.username}`} className="underline">
                        Open their profile to accept and subscribe.
                      </ProfileLink>
                    </>
                  )}
                </p>
              )}
              </div>
            );
          })}
        </div>
      )}

      {following.length < total && (
        <div className="mt-6 text-center">
          <button
            onClick={loadMore}
            disabled={loadingMore}
            className="btn-soft py-1.5 px-4 text-ui-xs disabled:opacity-50"
          >
            {loadingMore
              ? "Loading…"
              : `Load more (${total - following.length} remaining)`}
          </button>
          {moreError && (
            <p role="alert" className="mt-2 text-ui-xs text-crimson">
              {moreError}
            </p>
          )}
        </div>
      )}

      {/* Subscriptions section (public view, not own profile) */}
      {!isOwnProfile && subscriptions.length > 0 && (
        <>
          <div className="rule-inset my-8" />
          <h3 className="label-ui mb-4" style={{ color: palette.cardMeta }}>
            Subscribes to
          </h3>
          <div style={FEED_LOG_STYLE}>
            {subscriptions.map((s) => (
              <PersonCard
                key={s.writerId}
                palette={palette}
                href={`/${s.writerUsername}`}
                avatar={s.writerAvatar}
                name={s.writerDisplayName ?? s.writerUsername}
                handle={`@${s.writerUsername}`}
              />
            ))}
          </div>
        </>
      )}
    </div>
  );
}
