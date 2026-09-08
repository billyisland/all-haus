"use client";

// =============================================================================
// FollowersTab — tier 4's Followers view, a card log (PROFILE-PANE-REDESIGN-ADR
// D11 as amended 2026-09-02). One `PersonCard` per follower in the same
// `FEED_LOG_STYLE` column the Articles/Posts/Replies logs run, so the five
// views under one button row read as one surface.
//
// A FAILED FETCH IS ITS OWN BRANCH. This view used to swallow a bad response
// into an empty list, which rendered as the confident claim "No followers yet"
// — the *outage renders as an outage* rule (web/CLAUDE.md), and it is what the
// count on the button was covering for until the counts came off the row.
// =============================================================================

import { useState, useEffect } from "react";
import { PersonCard } from "./PersonCard";
import { FEED_LOG_STYLE } from "./ProfileChrome";
import { formatDateFromISO } from "../../lib/format";
import type { VesselPalette } from "../workspace/tokens";

interface Follower {
  id: string;
  username: string;
  displayName: string | null;
  avatar: string | null;
  followedAt: string;
  subscriptionStatus?: string;
}

export function FollowersTab({
  username,
  isOwnProfile,
  palette,
}: {
  username: string;
  isOwnProfile: boolean;
  palette: VesselPalette;
}) {
  const [followers, setFollowers] = useState<Follower[]>([]);
  const [total, setTotal] = useState(0);
  const [loading, setLoading] = useState(true);
  const [failed, setFailed] = useState(false);
  const [loadingMore, setLoadingMore] = useState(false);

  useEffect(() => {
    let cancelled = false;
    async function load() {
      setLoading(true);
      setFailed(false);
      try {
        const res = await fetch(
          `/api/v1/writers/${username}/followers?limit=30`,
          { credentials: "include" },
        );
        if (cancelled) return;
        if (!res.ok) {
          setFailed(true);
          return;
        }
        const data = await res.json();
        if (cancelled) return;
        setFollowers(data.followers ?? []);
        setTotal(data.total ?? 0);
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
  }, [username]);

  async function loadMore() {
    setLoadingMore(true);
    try {
      const res = await fetch(
        `/api/v1/writers/${username}/followers?limit=30&offset=${followers.length}`,
        { credentials: "include" },
      );
      if (res.ok) {
        const data = await res.json();
        setFollowers((prev) => [...prev, ...(data.followers ?? [])]);
      }
    } catch {
      /* silently fail */
    } finally {
      setLoadingMore(false);
    }
  }

  if (loading) {
    return (
      <div
        className="py-10 text-center text-ui-sm"
        style={{ color: palette.cardMeta }}
      >
        Loading...
      </div>
    );
  }

  if (failed) {
    return (
      <p className="text-ui-sm py-10" style={{ color: palette.cardMeta }}>
        Couldn&rsquo;t load followers. Nothing is missing — try again in a
        moment.
      </p>
    );
  }

  if (followers.length === 0) {
    return (
      <p className="text-ui-sm py-10" style={{ color: palette.cardMeta }}>
        No followers yet.
      </p>
    );
  }

  return (
    <div>
      <div style={FEED_LOG_STYLE}>
        {followers.map((f) => (
          <PersonCard
            key={f.id}
            palette={palette}
            href={`/${f.username}`}
            avatar={f.avatar}
            name={f.displayName ?? f.username}
            handle={`@${f.username}`}
            badge={
              isOwnProfile && f.subscriptionStatus === "active" ? (
                <span className="inline-flex items-center rounded-full bg-accent/10 px-2 py-0.5 text-[11px] font-mono text-accent leading-none flex-shrink-0">
                  Subscriber
                </span>
              ) : undefined
            }
            trailing={
              <time className="text-ui-xs" style={{ color: palette.cardMeta }}>
                {formatDateFromISO(f.followedAt)}
              </time>
            }
          />
        ))}
      </div>

      {followers.length < total && (
        <div className="mt-6 text-center">
          <button
            onClick={loadMore}
            disabled={loadingMore}
            className="btn-soft py-1.5 px-4 text-ui-xs disabled:opacity-50"
          >
            {loadingMore
              ? "Loading..."
              : `Load more (${total - followers.length} remaining)`}
          </button>
        </div>
      )}
    </div>
  );
}
