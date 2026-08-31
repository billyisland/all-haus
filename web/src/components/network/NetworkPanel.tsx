"use client";

// =============================================================================
// NetworkPanel — the social-graph body (following / followers / blocked /
// muted / vouches, plus the feed-reach dial and DM-fee settings), extracted so
// the workspace Glasshouse overlay (NetworkOverlay) owns it. Mirrors
// SettingsPanel/LibraryPanel: a page-capable mode (`inOverlay=false`, wrapped in
// PageShell with the auth redirect) is kept for the standalone /network route,
// but the overlay is the live surface inside the workspace.
//
// Every profile link already routes through <ProfileLink>, which opens the
// profile overlay in place — no black-topbar escape (CLAUDE.md). `initialTab`
// seeds which section opens.
// =============================================================================

import { useState, useEffect } from "react";
import Link from "next/link";
import { ProfileLink } from "../ui/ProfileLink";
import { useRouter } from "next/navigation";
import { useAuth } from "../../stores/auth";
import { useFollows } from "../../stores/follows";
import { DmFeeSettings } from "../social/DmFeeSettings";
import { BlockList } from "../social/BlockList";
import { MuteList } from "../social/MuteList";
import { VouchList } from "../trust/VouchList";
import { trustEnabled } from "../../lib/featureFlags";
import { PageShell, PageHeader } from "../ui/PageShell";
import type { NetworkTab } from "../../stores/networkOverlay";

interface Writer {
  id: string;
  username: string;
  displayName: string | null;
  avatar: string | null;
  pubkey: string;
  followedAt: string;
}

interface Follower {
  id: string;
  username: string;
  displayName: string | null;
  avatar: string | null;
  pubkey: string;
  followedAt: string;
}

export function NetworkPanel({
  inOverlay = false,
  initialTab = "following",
}: {
  inOverlay?: boolean;
  initialTab?: NetworkTab;
}) {
  const { user, loading } = useAuth();
  const router = useRouter();
  // Trust parked (item 7): the vouches tab is trust UI — dropped when off.
  const allTabs: NetworkTab[] = [
    "following",
    "followers",
    "blocked",
    "muted",
    ...(trustEnabled() ? (["vouches"] as NetworkTab[]) : []),
  ];
  // Guard a stale ?tab=vouches deep-link from landing on a now-absent tab.
  const [tab, setTab] = useState<NetworkTab>(
    allTabs.includes(initialTab) ? initialTab : "following",
  );

  const [writers, setWriters] = useState<Writer[]>([]);
  const [followers, setFollowers] = useState<Follower[]>([]);
  const [writersLoading, setWritersLoading] = useState(true);
  const [followersLoading, setFollowersLoading] = useState(true);
  const [unfollowing, setUnfollowing] = useState<Set<string>>(new Set());

  useEffect(() => {
    if (!inOverlay && !loading && !user) router.push("/auth?mode=login");
  }, [inOverlay, user, loading, router]);

  useEffect(() => {
    if (!user) return;
    fetch("/api/v1/follows", { credentials: "include" })
      .then((r) => (r.ok ? r.json() : { writers: [] }))
      .then((d) => {
        const list = d.writers ?? [];
        setWriters(list);
        // Seed the shared store from this authoritative list so follow buttons
        // elsewhere reflect it (pre-hydration; no-op once hydrated).
        for (const w of list) useFollows.getState().prime(w.id, true);
      })
      .catch((err) => console.error("Failed to load followed writers", err))
      .finally(() => setWritersLoading(false));

    fetch("/api/v1/follows/followers", { credentials: "include" })
      .then((r) => (r.ok ? r.json() : { followers: [] }))
      .then((d) => setFollowers(d.followers ?? []))
      .catch((err) => console.error("Failed to load followers", err))
      .finally(() => setFollowersLoading(false));
  }, [user]);

  function switchTab(t: NetworkTab) {
    setTab(t);
    if (inOverlay) return;
    const url = new URL(window.location.href);
    url.searchParams.set("tab", t);
    window.history.replaceState({}, "", url.toString());
  }

  async function handleUnfollow(writerId: string) {
    setUnfollowing((prev) => new Set([...prev, writerId]));
    try {
      // Through the shared store so the unfollow propagates to every other
      // mounted follow affordance for this writer.
      await useFollows.getState().unfollow(writerId);
      setWriters((prev) => prev.filter((w) => w.id !== writerId));
    } catch {
      /* ignore */
    } finally {
      setUnfollowing((prev) => {
        const s = new Set(prev);
        s.delete(writerId);
        return s;
      });
    }
  }

  if (loading || !user) {
    return inOverlay ? <PanelSkeleton /> : (
      <PageShell width="feed">
        <PanelSkeleton withHeader />
      </PageShell>
    );
  }

  const tabs: NetworkTab[] = allTabs;

  const body = (
    <>
      {inOverlay && <PageHeader title="Network" />}

      {/* Always-visible settings */}
      <div className="space-y-8 mb-8">
        <section data-explain="network.dmFee" className="bg-glasshouse-well px-6 py-5">
          <DmFeeSettings />
        </section>
      </div>

      {/* Tabs */}
      <div
        className="flex gap-2 mb-8"
        role="tablist"
        aria-label="Network sections"
      >
        {tabs.map((t, i) => {
          let label = t.charAt(0).toUpperCase() + t.slice(1);
          if (t === "following" && !writersLoading)
            label += ` (${writers.length})`;
          if (t === "followers" && !followersLoading)
            label += ` (${followers.length})`;
          return (
            <button
              key={t}
              role="tab"
              aria-selected={tab === t}
              aria-controls={`network-panel-${t}`}
              id={`network-tab-${t}`}
              onClick={() => switchTab(t)}
              onKeyDown={(e) => {
                if (e.key === "ArrowRight") {
                  switchTab(tabs[(i + 1) % tabs.length]);
                  e.preventDefault();
                }
                if (e.key === "ArrowLeft") {
                  switchTab(tabs[(i - 1 + tabs.length) % tabs.length]);
                  e.preventDefault();
                }
              }}
              tabIndex={tab === t ? 0 : -1}
              className={`tab-pill ${tab === t ? "tab-pill-active" : "tab-pill-inactive"}`}
            >
              {label}
            </button>
          );
        })}
      </div>

      {/* Following tab */}
      {tab === "following" && (
        <div
          role="tabpanel"
          id="network-panel-following"
          aria-labelledby="network-tab-following"
          data-explain="network.following"
        >
          {writersLoading ? (
            <ListSkeleton />
          ) : writers.length === 0 ? (
            <div className="py-20 text-center">
              <p className="text-ui-sm text-grey-400">
                You're not following anyone yet.
              </p>
              {/* In the overlay the ∀ disc (an X) is the way back to the feeds —
                  no in-panel workspace escape. Only the standalone page links. */}
              {!inOverlay && (
                <Link
                  href="/reader"
                  className="btn py-2 px-5 text-ui-sm mt-4 inline-block"
                >
                  Discover writers
                </Link>
              )}
            </div>
          ) : (
            <div className="space-y-1">
              {writers.map((w) => (
                <div key={w.id} className="flex items-center gap-4 py-4">
                  <ProfileLink href={`/${w.username}`} className="flex-shrink-0">
                    {w.avatar ? (
                      <img
                        src={w.avatar}
                        alt=""
                        className="h-11 w-11  object-cover"
                      />
                    ) : (
                      <span className="flex h-11 w-11 items-center justify-center bg-grey-100 text-sm font-medium text-grey-400 ">
                        {(w.displayName ?? w.username)[0].toUpperCase()}
                      </span>
                    )}
                  </ProfileLink>
                  <div className="flex-1 min-w-0">
                    <ProfileLink href={`/${w.username}`} className="group">
                      <p className="font-sans text-base font-medium text-black group-hover:opacity-75 transition-opacity truncate">
                        {w.displayName ?? w.username}
                      </p>
                      <p className="text-ui-xs text-grey-400">@{w.username}</p>
                    </ProfileLink>
                  </div>
                  <button
                    onClick={() => handleUnfollow(w.id)}
                    disabled={unfollowing.has(w.id)}
                    className="btn-soft py-1.5 px-4 text-ui-xs flex-shrink-0 disabled:opacity-40"
                  >
                    {unfollowing.has(w.id) ? "..." : "Unfollow"}
                  </button>
                </div>
              ))}
            </div>
          )}
        </div>
      )}

      {/* Followers tab */}
      {tab === "followers" && (
        <div
          role="tabpanel"
          id="network-panel-followers"
          aria-labelledby="network-tab-followers"
        >
          {followersLoading ? (
            <ListSkeleton />
          ) : followers.length === 0 ? (
            <div className="py-20 text-center">
              <p className="text-ui-sm text-grey-400 mb-4">No followers yet.</p>
              <p className="text-ui-xs text-grey-300">
                Share your writing to grow your audience.
              </p>
            </div>
          ) : (
            <div className="space-y-1">
              {followers.map((f) => (
                <div key={f.id} className="flex items-center gap-4 py-4">
                  <ProfileLink href={`/${f.username}`} className="flex-shrink-0">
                    {f.avatar ? (
                      <img
                        src={f.avatar}
                        alt=""
                        className="h-11 w-11  object-cover"
                      />
                    ) : (
                      <span className="flex h-11 w-11 items-center justify-center bg-grey-100 text-sm font-medium text-grey-400 ">
                        {(f.displayName ?? f.username)[0].toUpperCase()}
                      </span>
                    )}
                  </ProfileLink>
                  <div className="flex-1 min-w-0">
                    <ProfileLink href={`/${f.username}`} className="group">
                      <p className="font-sans text-base font-medium text-black group-hover:opacity-75 transition-opacity truncate">
                        {f.displayName ?? f.username}
                      </p>
                      <p className="text-ui-xs text-grey-400">
                        @{f.username}
                      </p>
                    </ProfileLink>
                  </div>
                </div>
              ))}
            </div>
          )}
        </div>
      )}

      {/* Blocked tab */}
      {tab === "blocked" && (
        <div
          role="tabpanel"
          id="network-panel-blocked"
          aria-labelledby="network-tab-blocked"
          data-explain="network.blocked"
        >
          <section className="bg-glasshouse-well px-6 py-5">
            <BlockList />
          </section>
        </div>
      )}

      {/* Muted tab */}
      {tab === "muted" && (
        <div
          role="tabpanel"
          id="network-panel-muted"
          aria-labelledby="network-tab-muted"
          data-explain="network.muted"
        >
          <section className="bg-glasshouse-well px-6 py-5">
            <MuteList />
          </section>
        </div>
      )}

      {/* Vouches tab */}
      {tab === "vouches" && (
        <div
          role="tabpanel"
          id="network-panel-vouches"
          aria-labelledby="network-tab-vouches"
        >
          <VouchList />
        </div>
      )}
    </>
  );

  if (inOverlay) return body;
  return (
    <PageShell width="feed" title="Network">
      {body}
    </PageShell>
  );
}

function ListSkeleton() {
  return (
    <div className="space-y-3">
      {[1, 2, 3].map((i) => (
        <div
          key={i}
          className="flex items-center gap-4 py-4 mb-1 animate-pulse"
        >
          <div className="h-11 w-11  bg-grey-100 flex-shrink-0" />
          <div className="flex-1">
            <div className="h-3.5 w-32 bg-grey-100 mb-2 rounded" />
            <div className="h-3 w-20 bg-grey-100 rounded" />
          </div>
        </div>
      ))}
    </div>
  );
}

function PanelSkeleton({ withHeader = false }: { withHeader?: boolean }) {
  return (
    <>
      {withHeader && <div className="h-7 w-36 animate-pulse bg-grey-100 mb-8 rounded" />}
      <div className="flex gap-2 mb-8">
        {[1, 2, 3, 4].map((i) => (
          <div key={i} className="h-9 w-24 animate-pulse bg-glasshouse-well" />
        ))}
      </div>
      <ListSkeleton />
    </>
  );
}
