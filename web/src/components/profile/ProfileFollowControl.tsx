"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import Link from "next/link";
import { workspaceFeeds, type WorkspaceFeed } from "../../lib/api";
import { invalidateAuthorCardCache } from "../../hooks/useAuthorCard";
import { useAuth } from "../../stores/auth";
import { useFollows, useFollowState } from "../../stores/follows";
import type { AuthorProfile } from "../../lib/api/post";
import { BarButton } from "./ProfileChrome";
import { AnchoredPopover } from "../ui/AnchoredPopover";
import type { VesselPalette } from "../workspace/tokens";

// =============================================================================
// ProfileFollowControl — the follow/unfollow affordance for a full profile
// surface (AuthorProfileView). Two shapes off the server's followTarget:
//
//   • type "user"  → a plain native Follow/Following toggle (global, /follows).
//   • type "source"→ external follow is feed-derived (CLAUDE.md invariant:
//                     "follow an external author" = add its source to a feed).
//                     A standalone profile has NO feed context, so the control
//                     is a "Follow ▾" feed-picker: a menu of the viewer's feeds,
//                     each toggling membership; "following" = in ≥1 feed.
//
// Logged-out viewers get a full-page → /auth link (the workspace is login-gated;
// every logged-out follow CTA goes to /auth full-page by design).
// =============================================================================

type FollowTarget = NonNullable<AuthorProfile["followTarget"]>;

// Protocols workspace addSource can service (mirrors AuthorModal's set).
const FOLLOWABLE_PROTOCOLS = new Set([
  "rss",
  "atproto",
  "activitypub",
  "nostr_external",
]);

export function ProfileFollowControl({
  target,
  palette,
}: {
  target: FollowTarget;
  /** Present ⇒ the control sits on the profile's tier-1 bar, where `.btn`
   *  (ink on ink) is invisible: drive the trigger off the bar tokens instead.
   *  The open menu stays glasshouse — floating material is the outermost layer
   *  (web/CLAUDE.md) and its neutral slugs already invert with the mode. */
  palette?: VesselPalette;
}) {
  const { user, loading } = useAuth();

  if (loading) return null;
  if (!user) {
    // Logged out, tier 1 carries the single `Log in` link (D12) — this is the
    // full-page-only branch, kept for the standalone author page.
    return (
      <Link href="/auth" className="btn py-1.5 px-4 text-ui-xs">
        Log in to follow
      </Link>
    );
  }

  return target.type === "source" ? (
    <SourceFollowPicker target={target} palette={palette} />
  ) : (
    <NativeFollowToggle target={target} palette={palette} />
  );
}

function NativeFollowToggle({
  target,
  palette,
}: {
  target: FollowTarget;
  palette?: VesselPalette;
}) {
  // Live follow state from the shared store, seeded with the server snapshot —
  // a toggle here (or on any other surface) re-renders every mounted follow
  // affordance for this writer.
  const following = useFollowState(target.id, target.isFollowing);
  const [busy, setBusy] = useState(false);

  const toggle = useCallback(async () => {
    if (busy) return;
    setBusy(true);
    try {
      if (following) await useFollows.getState().unfollow(target.id);
      else await useFollows.getState().follow(target.id);
    } catch {
      /* store reverts its optimistic update on failure */
    } finally {
      setBusy(false);
    }
  }, [busy, following, target.id]);

  const label = busy ? "…" : following ? "Following" : "Follow";
  return palette ? (
    <BarButton
      data-explain="profile.follow"
      palette={palette}
      variant={following ? "secondary" : "primary"}
      onClick={toggle}
      disabled={busy}
    >
      {label}
    </BarButton>
  ) : (
    <button
      data-explain="profile.follow"
      onClick={toggle}
      disabled={busy}
      className={`transition-colors disabled:opacity-50 py-1.5 px-4 text-ui-xs ${
        following ? "btn-soft" : "btn"
      }`}
    >
      {label}
    </button>
  );
}

function SourceFollowPicker({
  target,
  palette,
}: {
  target: FollowTarget;
  palette?: VesselPalette;
}) {
  const followable =
    !target.protocol || FOLLOWABLE_PROTOCOLS.has(target.protocol);

  const [open, setOpen] = useState(false);
  const [feeds, setFeeds] = useState<WorkspaceFeed[] | null>(null);
  // feedId → feed_sources row id when the source sits in that feed, else null.
  // null (not {}) until the per-feed fan-out has resolved, so the button label
  // can fall back to the server snapshot rather than reading "Follow" prematurely.
  const [membership, setMembership] = useState<Record<
    string,
    string | null
  > | null>(null);
  const [busyFeeds, setBusyFeeds] = useState<Set<string>>(new Set());
  const [newMode, setNewMode] = useState(false);
  const [newName, setNewName] = useState("");
  const [creating, setCreating] = useState(false);
  const wrapRef = useRef<HTMLDivElement>(null);

  // Until membership is resolved (the fan-out is lazy, on first menu open),
  // trust the server's followTarget.isFollowing — the "in ≥1 feed" projection,
  // exactly what `following` means — so the label is correct on first paint.
  const following = membership
    ? Object.values(membership).some(Boolean)
    : target.isFollowing;

  // Resolve feeds + per-feed membership on first open. listSources per feed is a
  // small fan-out (a handful of feeds) — fine for a deliberate menu open.
  useEffect(() => {
    if (!open || feeds !== null) return;
    let cancelled = false;
    void workspaceFeeds
      .list()
      .then(async ({ feeds }) => {
        const visible = feeds
          .filter((f) => !f.hidden)
          .sort((a, b) => a.sortRank - b.sortRank);
        const entries = await Promise.all(
          visible.map(async (f) => {
            try {
              const { sources } = await workspaceFeeds.listSources(f.id);
              const row = target.sourceId
                ? sources.find(
                    (s) =>
                      s.sourceType === "external_source" &&
                      s.externalSourceId === target.sourceId,
                  )
                : undefined;
              return [f.id, row?.id ?? null] as const;
            } catch {
              return [f.id, null] as const;
            }
          }),
        );
        if (cancelled) return;
        setFeeds(visible);
        setMembership(Object.fromEntries(entries));
      })
      .catch(() => {
        if (!cancelled) setFeeds([]);
      });
    return () => {
      cancelled = true;
    };
  }, [open, feeds, target.sourceId]);

  // Escape and outside-click both live in `AnchoredPopover` now: the panel is
  // portalled out of this subtree, so a `wrapRef.contains` test would dismiss
  // on every click INSIDE the menu.

  const setBusy = (feedId: string, on: boolean) =>
    setBusyFeeds((prev) => {
      const next = new Set(prev);
      if (on) next.add(feedId);
      else next.delete(feedId);
      return next;
    });

  const toggleFeed = useCallback(
    async (feedId: string) => {
      if (busyFeeds.has(feedId)) return;
      const existing = membership?.[feedId];
      setBusy(feedId, true);
      try {
        if (existing) {
          // Removal only needs the feed_sources row id — never gate it on
          // protocol/sourceUri, or an unfollow of an already-followed source
          // silently no-ops when those are absent (mirrors AuthorModal).
          await workspaceFeeds.removeSource(feedId, existing);
          setMembership((m) => ({ ...m, [feedId]: null }));
        } else if (target.protocol && target.sourceUri) {
          const { source } = await workspaceFeeds.addSource(feedId, {
            sourceType: "external_source",
            protocol: target.protocol as
              | "rss"
              | "atproto"
              | "activitypub"
              | "nostr_external",
            sourceUri: target.sourceUri,
          });
          setMembership((m) => ({ ...m, [feedId]: source.id }));
        }
        invalidateAuthorCardCache();
      } catch {
        /* leave membership unchanged on failure */
      } finally {
        setBusy(feedId, false);
      }
    },
    [busyFeeds, membership, target.protocol, target.sourceUri],
  );

  const createAndFollow = useCallback(async () => {
    const name = newName.trim();
    if (!name || creating || !target.protocol || !target.sourceUri) return;
    setCreating(true);
    try {
      const { feed } = await workspaceFeeds.create(name);
      const { source } = await workspaceFeeds.addSource(feed.id, {
        sourceType: "external_source",
        protocol: target.protocol as
          | "rss"
          | "atproto"
          | "activitypub"
          | "nostr_external",
        sourceUri: target.sourceUri,
      });
      setFeeds((prev) => [...(prev ?? []), feed]);
      setMembership((m) => ({ ...m, [feed.id]: source.id }));
      invalidateAuthorCardCache();
      setNewMode(false);
      setNewName("");
    } catch {
      /* keep the input open so the user can retry */
    } finally {
      setCreating(false);
    }
  }, [newName, creating, target.protocol, target.sourceUri]);

  // A protocol we can't add (e.g. email) has no follow gesture at all.
  if (!followable) return null;

  return (
    // C4: the tag rides the wrapper so the trigger and the open picker both
    // answer as the feed-derived external follow.
    <div
      ref={wrapRef}
      data-explain="profile.followFeeds"
      className="relative inline-block"
    >
      {palette ? (
        <BarButton
          palette={palette}
          variant={following ? "secondary" : "primary"}
          onClick={() => setOpen((o) => !o)}
        >
          {following ? "Following" : "Follow"} <span aria-hidden>▾</span>
        </BarButton>
      ) : (
        <button
          onClick={() => setOpen((o) => !o)}
          className={`transition-colors py-1.5 px-4 text-ui-xs ${
            following ? "btn-soft" : "btn"
          }`}
        >
          {following ? "Following" : "Follow"} <span aria-hidden>▾</span>
        </button>
      )}

      {/* Portalled, and `align="end"`, because this control sits at the RIGHT
          end of the profile bar: an absolute `left-0` panel ran 92px past the
          pane's edge and was sliced by its ⊓ wall. */}
      <AnchoredPopover
        anchorRef={wrapRef}
        open={open}
        onDismiss={() => setOpen(false)}
        align="end"
        width={240}
        ariaLabel="Add this author to a feed"
        className="p-1.5"
      >
        <>
          {feeds === null ? (
            <p className="label-ui text-grey-600 px-2 py-2">LOADING…</p>
          ) : (
            <>
              {feeds.length === 0 && !newMode && (
                <p className="text-ui-xs text-grey-600 px-2 py-2">
                  No feeds yet.
                </p>
              )}
              {feeds.map((f) => {
                const inFeed = !!membership?.[f.id];
                const busy = busyFeeds.has(f.id);
                return (
                  <button
                    key={f.id}
                    onClick={() => toggleFeed(f.id)}
                    disabled={busy}
                    className="flex w-full items-center justify-between gap-2 px-2 py-1.5 text-left text-ui-sm text-black hover:bg-glasshouse-well transition-colors disabled:opacity-50"
                  >
                    {/* A feed's name is optional (migration 190); without this the row
                        for an untitled feed is a blank line you cannot tell from
                        its neighbours. Same wording as the ∀ menu's restore rows. */}
                    <span className="truncate">
                      {f.name.trim() || "Unnamed feed"}
                    </span>
                    <span
                      className={`text-ui-sm ${inFeed ? "text-crimson" : "text-grey-300"}`}
                      aria-hidden
                    >
                      {busy ? "…" : inFeed ? "✓" : "+"}
                    </span>
                  </button>
                );
              })}

              {newMode ? (
                <div className="flex items-center gap-1.5 px-1 pt-1.5">
                  <input
                    autoFocus
                    value={newName}
                    onChange={(e) => setNewName(e.target.value)}
                    onKeyDown={(e) => {
                      if (e.key === "Enter") void createAndFollow();
                      if (e.key === "Escape") setNewMode(false);
                    }}
                    placeholder="New feed name"
                    className="min-w-0 flex-1 bg-glasshouse-well px-2 py-1.5 text-ui-sm text-black placeholder:text-grey-300 focus:outline-none"
                  />
                  <button
                    onClick={() => void createAndFollow()}
                    disabled={creating || !newName.trim()}
                    className="btn py-1.5 px-3 text-ui-xs disabled:opacity-50"
                  >
                    {creating ? "…" : "Add"}
                  </button>
                </div>
              ) : (
                <button
                  onClick={() => setNewMode(true)}
                  className="w-full px-2 py-1.5 text-left text-ui-sm text-grey-600 hover:bg-glasshouse-well transition-colors"
                >
                  + New feed…
                </button>
              )}
            </>
          )}
        </>
      </AnchoredPopover>
    </div>
  );
}
