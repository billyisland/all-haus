"use client";

import { useState, useEffect, useRef, useCallback } from "react";
import Link from "next/link";
import { ProfileLink } from "../ui/ProfileLink";
import { Avatar } from "../ui/Avatar";
import { formatDateFromISO } from "../../lib/format";
import { useEscapeShield } from "../../hooks/useEscapeShield";
import { account, subscribe as apiSubscribe, type MySubscription } from "../../lib/api";

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
}: {
  username: string;
  isOwnProfile: boolean;
}) {
  const [following, setFollowing] = useState<Following[]>([]);
  const [total, setTotal] = useState(0);
  const [subscriptions, setSubscriptions] = useState<PublicSubscription[]>([]);
  const [mySubs, setMySubs] = useState<Map<string, MySubscription>>(new Map());
  const [loading, setLoading] = useState(true);
  const [loadingMore, setLoadingMore] = useState(false);
  const [unfollowingId, setUnfollowingId] = useState<string | null>(null);
  const [actionLoadingId, setActionLoadingId] = useState<string | null>(null);
  const [confirmUnsubId, setConfirmUnsubId] = useState<string | null>(null);

  useEffect(() => {
    async function load() {
      setLoading(true);
      try {
        const fetches: Promise<any>[] = [
          fetch(`/api/v1/writers/${username}/following?limit=30`, {
            credentials: "include",
          }),
          fetch(`/api/v1/writers/${username}/subscriptions?limit=50`, {
            credentials: "include",
          }),
        ];
        if (isOwnProfile) {
          fetches.push(account.getMySubscriptions());
        }

        const results = await Promise.all(fetches);
        const followRes = results[0] as Response;
        const subRes = results[1] as Response;

        if (followRes.ok) {
          const data = await followRes.json();
          setFollowing(data.following ?? []);
          setTotal(data.total ?? 0);
        }
        if (subRes.ok) {
          const data = await subRes.json();
          setSubscriptions(data.subscriptions ?? []);
        }
        if (isOwnProfile && results[2]) {
          const mySubData = results[2] as { subscriptions: MySubscription[] };
          const map = new Map<string, MySubscription>();
          for (const s of mySubData.subscriptions) {
            map.set(s.writerId, s);
          }
          setMySubs(map);
        }
      } catch {
        /* silently fail */
      } finally {
        setLoading(false);
      }
    }
    void load();
  }, [username, isOwnProfile]);

  async function loadMore() {
    setLoadingMore(true);
    try {
      const res = await fetch(
        `/api/v1/writers/${username}/following?limit=30&offset=${following.length}`,
        { credentials: "include" },
      );
      if (res.ok) {
        const data = await res.json();
        setFollowing((prev) => [...prev, ...(data.following ?? [])]);
      }
    } catch {
      /* silently fail */
    } finally {
      setLoadingMore(false);
    }
  }

  async function handleUnfollow(writerId: string) {
    setUnfollowingId(writerId);
    try {
      const res = await fetch(`/api/v1/follows/${writerId}`, {
        method: "DELETE",
        credentials: "include",
      });
      if (res.ok) {
        setFollowing((prev) => prev.filter((f) => f.id !== writerId));
        setTotal((prev) => prev - 1);
      }
    } catch {
      /* silently fail */
    } finally {
      setUnfollowingId(null);
    }
  }

  async function handleSubscribe(writerId: string) {
    setActionLoadingId(writerId);
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
    } catch {
      /* silently fail */
    } finally {
      setActionLoadingId(null);
    }
  }

  async function handleUnsubscribe(writerId: string) {
    setConfirmUnsubId(null);
    setActionLoadingId(writerId);
    try {
      const res = await fetch(`/api/v1/subscriptions/${writerId}`, {
        method: "DELETE",
        credentials: "include",
      });
      if (res.ok) {
        const data = await res.json();
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
      }
    } catch {
      /* silently fail */
    } finally {
      setActionLoadingId(null);
    }
  }

  async function handleResubscribe(writerId: string) {
    setActionLoadingId(writerId);
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
    } catch {
      /* silently fail */
    } finally {
      setActionLoadingId(null);
    }
  }

  if (loading) {
    return (
      <div className="py-10 text-center text-ui-sm text-grey-600">
        Loading...
      </div>
    );
  }

  const confirmWriter = confirmUnsubId
    ? following.find((f) => f.id === confirmUnsubId)
    : null;
  const confirmSub = confirmUnsubId ? mySubs.get(confirmUnsubId) : null;

  return (
    <div>
      {/* Unsubscribe confirmation modal */}
      {confirmUnsubId && confirmWriter && (
        <UnsubscribeModal
          confirmWriter={confirmWriter}
          confirmSub={confirmSub ?? undefined}
          onClose={() => setConfirmUnsubId(null)}
          onConfirm={() => handleUnsubscribe(confirmUnsubId)}
        />
      )}

      {/* Following list */}
      {following.length === 0 ? (
        <p className="text-ui-sm text-grey-600 py-10">
          Not following anyone yet.
        </p>
      ) : (
        <div className="space-y-1">
          {following.map((f) => {
            const sub = mySubs.get(f.id);
            const sellsSubscriptions =
              f.hasPaywalledArticle && f.subscriptionPricePence > 0;
            const isActive = sub?.status === "active";
            const isCancelled = sub?.status === "cancelled";

            return (
              <div
                key={f.id}
                className="flex items-center gap-3 px-4 py-3 hover:bg-grey-100 transition-colors"
              >
                <ProfileLink
                  href={`/${f.username}`}
                  className="flex items-center gap-3 min-w-0 flex-1"
                >
                  <Avatar
                    src={f.avatar}
                    name={f.displayName ?? f.username}
                    size={36}
                  />
                  <div className="min-w-0 flex-1">
                    <p className="text-ui-sm font-sans text-black truncate">
                      {f.displayName ?? f.username}
                    </p>
                    <p className="text-ui-xs text-grey-600">@{f.username}</p>
                  </div>
                </ProfileLink>

                {isOwnProfile ? (
                  <div className="flex items-center gap-2 flex-shrink-0">
                    {/* Subscription actions */}
                    {sellsSubscriptions && !isActive && !isCancelled && (
                      <button
                        onClick={() => handleSubscribe(f.id)}
                        disabled={actionLoadingId === f.id}
                        className="btn-accent py-1 px-3 text-[11px] disabled:opacity-50 transition-colors"
                      >
                        {actionLoadingId === f.id
                          ? "..."
                          : `Subscribe £${(f.subscriptionPricePence / 100).toFixed(2)}/mo`}
                      </button>
                    )}
                    {isActive && (
                      <button
                        onClick={() => setConfirmUnsubId(f.id)}
                        disabled={actionLoadingId === f.id}
                        className="btn-soft py-1 px-3 text-[11px] disabled:opacity-50 transition-colors"
                      >
                        {actionLoadingId === f.id ? "..." : "Subscribed"}
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
                          ? "..."
                          : "Cancelled — resubscribe"}
                      </button>
                    )}

                    {/* Unfollow */}
                    <button
                      onClick={() => handleUnfollow(f.id)}
                      disabled={unfollowingId === f.id}
                      className="btn-ghost py-1 px-3 text-[11px] text-grey-600 hover:text-red-600 disabled:opacity-50 transition-colors"
                    >
                      {unfollowingId === f.id ? "..." : "Unfollow"}
                    </button>
                  </div>
                ) : (
                  <time className="text-ui-xs text-grey-600 flex-shrink-0">
                    {formatDateFromISO(f.followedAt)}
                  </time>
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
              ? "Loading..."
              : `Load more (${total - following.length} remaining)`}
          </button>
        </div>
      )}

      {/* Subscriptions section (public view, not own profile) */}
      {!isOwnProfile && subscriptions.length > 0 && (
        <>
          <div className="rule-inset my-8" />
          <h3 className="label-ui text-grey-600 mb-4">Subscribes to</h3>
          <div className="space-y-1">
            {subscriptions.map((s) => (
              <Link
                key={s.writerId}
                href={`/${s.writerUsername}`}
                className="flex items-center gap-3 px-4 py-3 hover:bg-grey-100 transition-colors"
              >
                <Avatar
                  src={s.writerAvatar}
                  name={s.writerDisplayName ?? s.writerUsername}
                  size={36}
                />
                <div className="min-w-0 flex-1">
                  <p className="text-ui-sm font-sans text-black truncate">
                    {s.writerDisplayName ?? s.writerUsername}
                  </p>
                  <p className="text-ui-xs text-grey-600">
                    @{s.writerUsername}
                  </p>
                </div>
              </Link>
            ))}
          </div>
        </>
      )}
    </div>
  );
}

function UnsubscribeModal({
  confirmWriter,
  confirmSub,
  onClose,
  onConfirm,
}: {
  confirmWriter: Following;
  confirmSub?: MySubscription;
  onClose: () => void;
  onConfirm: () => void;
}) {
  const dialogRef = useRef<HTMLDivElement>(null);

  // Escape via the shared shield so it closes only this dialog, not the host
  // Glasshouse under it (§0k.3); Tab keeps the focus trap below.
  useEscapeShield(true, onClose);
  const handleKeyDown = useCallback(
    (e: KeyboardEvent) => {
      if (e.key === "Tab" && dialogRef.current) {
        const focusable = dialogRef.current.querySelectorAll<HTMLElement>(
          'button, [href], input, select, textarea, [tabindex]:not([tabindex="-1"])',
        );
        if (focusable.length === 0) return;
        const first = focusable[0];
        const last = focusable[focusable.length - 1];
        if (e.shiftKey && document.activeElement === first) {
          e.preventDefault();
          last.focus();
        } else if (!e.shiftKey && document.activeElement === last) {
          e.preventDefault();
          first.focus();
        }
      }
    },
    [],
  );

  useEffect(() => {
    document.addEventListener("keydown", handleKeyDown);
    dialogRef.current?.focus();
    return () => document.removeEventListener("keydown", handleKeyDown);
  }, [handleKeyDown]);

  return (
    <div
      className="fixed inset-0 z-50 bg-black/40 flex items-center justify-center p-4"
      onClick={onClose}
    >
      <div
        ref={dialogRef}
        role="dialog"
        aria-modal="true"
        aria-labelledby="unsub-modal-title"
        tabIndex={-1}
        className="bg-white max-w-sm w-full p-6"
        onClick={(e) => e.stopPropagation()}
      >
        <h3
          id="unsub-modal-title"
          className="text-[16px] font-sans font-semibold text-black mb-2"
        >
          Cancel subscription?
        </h3>
        <p className="text-ui-sm text-grey-600 mb-1">
          Are you sure you want to cancel your subscription to{" "}
          <strong className="text-black">
            {confirmWriter.displayName ?? confirmWriter.username}
          </strong>
          ?
        </p>
        <p className="text-ui-sm text-grey-600 mb-6">
          Your subscription will remain active until the end of your current
          billing period
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
          . You won't be charged again.
        </p>
        <div className="flex gap-2 justify-end">
          <button onClick={onClose} className="btn-soft py-1.5 px-4 text-ui-xs">
            Keep subscription
          </button>
          <button
            onClick={onConfirm}
            className="btn py-1.5 px-4 text-ui-xs bg-red-600 hover:bg-red-700 text-white"
          >
            Cancel subscription
          </button>
        </div>
      </div>
    </div>
  );
}
