"use client";

import { useState, useRef, useEffect, useCallback } from "react";
import { createPortal } from "react-dom";
import Link from "next/link";
import {
  useAuthorCard,
  invalidateAuthorCardCache,
  type AuthorCardData,
  type AuthorCardType,
} from "../../hooks/useAuthorCard";
import { workspaceFeeds } from "../../lib/api";
import { openProfileHref, isModifiedClick } from "../ui/ProfileLink";
import { useEscapeShield } from "../../hooks/useEscapeShield";
import { useLightbox } from "../../stores/lightbox";
import { useFollows } from "../../stores/follows";
import { useExplain } from "../../stores/explain";
import { SourceVolume } from "./SourceVolume";
import type { FeedScheme } from "../workspace/tokens";

interface AuthorModalProps {
  type: AuthorCardType;
  id: string;
  anchorRef: React.RefObject<HTMLElement | null>;
  onClose: () => void;
  // Hover-driven callers (feed ExternalCard) close on mouse-leave; click-driven
  // callers (workspace external pip) pass false and rely on Escape /
  // outside-pointerdown instead.
  dismissOnMouseLeave?: boolean;
  // Hover bridge: when the modal itself is the hover target, the trigger's
  // useAuthorHover hands these in so moving the pointer onto the modal cancels
  // the pending close (and leaving the modal re-arms it). Without them the modal
  // vanishes the instant the pointer leaves the byline, before it can be reached.
  onMouseEnter?: () => void;
  onMouseLeave?: () => void;
  // Stacking override for callers that open the modal above a frosted overlay
  // (the FeedComposer Glasshouse sits at z-56, above this modal's default 50).
  zIndex?: number;
  // The workspace feed this byline was hovered in. External "Follow" = add the
  // source to THIS feed; absent ⇒ no feed context, so the external Follow
  // affordance is omitted. Native Follow is the global graph toggle AND — with
  // feed context, since the reach retirement (§9.16) — writes the concrete
  // `account` source into this feed too (without it, only the graph toggles).
  feedId?: string;
  // Native author's 64-hex pubkey (from the feed-card byline) — lets the panel
  // host the per-feed VOLUME control for followed native authors. Absent for
  // external bylines (those resolve volume off the feed_sources row instead).
  pubkey?: string;
  // The hovered feed's COLOURWAY (palette.scheme). When the name link opens the
  // profile overlay, the pane wears that feed's scheme entire.
  frameScheme?: FeedScheme | null;
}

function formatCount(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 1_000) return `${(n / 1_000).toFixed(1)}K`;
  return String(n);
}

export function AuthorModal({
  type,
  id,
  anchorRef,
  onClose,
  dismissOnMouseLeave = true,
  onMouseEnter,
  onMouseLeave,
  zIndex = 50,
  feedId,
  pubkey,
  frameScheme,
}: AuthorModalProps) {
  const { data, loading } = useAuthorCard(type, id, true);
  const modalRef = useRef<HTMLDivElement>(null);
  const [position, setPosition] = useState<{
    top: number;
    left: number;
    below: boolean;
  } | null>(null);

  useEffect(() => {
    if (!anchorRef.current) return;
    const rect = anchorRef.current.getBoundingClientRect();
    const below = rect.bottom + 320 < window.innerHeight;
    setPosition({
      top: below ? rect.bottom + 6 : rect.top - 6,
      left: Math.max(8, Math.min(rect.left, window.innerWidth - 316)),
      below,
    });
  }, [anchorRef]);

  // Escape via the shared shield: stops propagation so a host Glasshouse
  // BELOW doesn't close with the modal (§0k.3 — the old bare handler shielded
  // the lightbox above but double-closed the pane below), and yields to the
  // lightbox ABOVE at z-[70] — its listener shares this `document` node where
  // registration order wins, so stopPropagation can't arbitrate that pair
  // (§0f-15); the yield does.
  useEscapeShield(true, onClose, () => useLightbox.getState().isOpen);

  // Outside-pointerdown dismissal (the anchor is excluded so a click on the
  // trigger toggles rather than close-then-reopen).
  useEffect(() => {
    function onPointerDown(e: PointerEvent) {
      if (useLightbox.getState().isOpen) return; // lightbox scrim click is not "outside"
      const target = e.target as Node;
      if (modalRef.current?.contains(target)) return;
      if (anchorRef.current?.contains(target)) return;
      // Swallow the click this pointerdown is about to produce, so dismissing
      // the modal by clicking the card underneath doesn't also fire the card's
      // expand handler (L1). Capture-phase + a 0ms cleanup catches only the
      // click from this same gesture. The anchor case returns above, so the pip
      // trigger still toggles normally.
      const swallowClick = (ce: MouseEvent) => {
        ce.stopPropagation();
        document.removeEventListener("click", swallowClick, true);
      };
      document.addEventListener("click", swallowClick, true);
      setTimeout(() => {
        document.removeEventListener("click", swallowClick, true);
      }, 0);
      onClose();
    }
    document.addEventListener("pointerdown", onPointerDown);
    return () => {
      document.removeEventListener("pointerdown", onPointerDown);
    };
  }, [onClose, anchorRef]);

  if (!position) return null;

  const style: React.CSSProperties = {
    position: "fixed",
    left: position.left,
    width: 300,
    zIndex,
    ...(position.below
      ? { top: position.top }
      : { bottom: window.innerHeight - position.top }),
  };

  return createPortal(
    <div
      ref={modalRef}
      style={style}
      className="bg-white shadow-lg p-4"
      onMouseEnter={onMouseEnter}
      onMouseLeave={
        onMouseLeave ?? (dismissOnMouseLeave ? onClose : undefined)
      }
      onClick={(e) => e.stopPropagation()}
    >
      {loading && <ModalSkeleton />}
      {data && !loading && (
        <ModalContent
          data={data}
          onClose={onClose}
          feedId={feedId}
          pubkey={pubkey}
          frameScheme={frameScheme}
        />
      )}
      {!data && !loading && (
        <p className="text-ui-xs text-grey-400">Could not load profile</p>
      )}
    </div>,
    document.body,
  );
}

function ModalSkeleton() {
  return (
    <div className="animate-pulse space-y-3">
      <div className="flex items-center gap-3">
        <div className="w-10 h-10 bg-grey-200 rounded-full" />
        <div className="flex-1 space-y-1.5">
          <div className="h-3 bg-grey-200 w-2/3" />
          <div className="h-2.5 bg-grey-100 w-1/2" />
        </div>
      </div>
      <div className="h-2.5 bg-grey-100 w-full" />
      <div className="h-2.5 bg-grey-100 w-3/4" />
    </div>
  );
}

function ModalContent({
  data,
  onClose,
  feedId,
  pubkey,
  frameScheme,
}: {
  data: AuthorCardData;
  onClose: () => void;
  feedId?: string;
  pubkey?: string;
  frameScheme?: FeedScheme | null;
}) {
  if (data.tier === "D") {
    return (
      <div>
        {data.displayName && (
          <p className="text-ui-sm font-medium">{data.displayName}</p>
        )}
        {data.sourceName && (
          <p className="text-ui-xs text-grey-600">{data.sourceName}</p>
        )}
        <p className="label-ui text-grey-400 mt-2">
          LIMITED INFO FROM THIS SOURCE
        </p>
        {data.followTarget && (
          <FollowButton
            target={data.followTarget}
            onClose={onClose}
            feedId={feedId}
          />
        )}
      </div>
    );
  }

  // Tier C — the source-scoped rss/email byline (BYLINE-AND-PROVENANCE-ADR
  // D6, S3). The author's name leads and the source sits beneath it, in the
  // same order as the card: hovering "Aditya Chakrabortty" must open a panel
  // headed by HER name, not by "The Guardian" — a panel that names only the
  // source rebuilds D1's slot collapse inside the hover. Follow is the SOURCE
  // (the followTarget the gateway emits for tier C), because that is the truth.
  if (data.tier === "C") {
    return (
      <div>
        {data.displayName && (
          <p className="text-ui-sm font-medium">{data.displayName}</p>
        )}
        {data.sourceName && (
          <p
            className={
              data.displayName
                ? "text-ui-xs text-grey-600 mt-0.5"
                : "text-ui-sm font-medium"
            }
          >
            {data.sourceName}
          </p>
        )}
        {data.sourceDescription && (
          <p className="text-ui-xs text-grey-600 mt-1 line-clamp-3">
            {data.sourceDescription}
          </p>
        )}
        {data.followTarget && (
          <FollowButton
            target={data.followTarget}
            onClose={onClose}
            feedId={feedId}
          />
        )}
        <SourceVolume data={data} feedId={feedId} pubkey={pubkey} />
      </div>
    );
  }

  return (
    <div>
      <div className="flex items-start gap-3">
        {data.avatarUrl && (
          <button
            type="button"
            onClick={(e) => {
              e.stopPropagation();
              useLightbox.getState().open(data.avatarUrl!, data.displayName ?? "");
            }}
            aria-label="View picture"
            className="focus-ring flex-shrink-0 cursor-zoom-in"
          >
            <img
              src={data.avatarUrl}
              alt=""
              className="w-10 h-10 rounded-full object-cover bg-grey-100"
              referrerPolicy="no-referrer"
            />
          </button>
        )}
        <div className="min-w-0 flex-1">
          {data.displayName &&
            (data.profilePath ? (
              // The name links to the author's all.haus profile (native
              // /:username, external A/B /author/:id).
              <Link
                href={data.profilePath}
                onClick={(e) => {
                  // Plain click opens the profile overlay in place; modified
                  // clicks (new tab) fall through to the real link.
                  if (
                    !isModifiedClick(e) &&
                    openProfileHref(data.profilePath!, frameScheme)
                  ) {
                    e.preventDefault();
                  }
                  onClose();
                }}
                className="block text-ui-sm font-medium truncate hover:underline"
              >
                {data.displayName}
              </Link>
            ) : (
              <p className="text-ui-sm font-medium truncate">
                {data.displayName}
              </p>
            ))}
          {data.handle &&
            (data.externalUrl ? (
              // The handle links out to the author's profile on the origin
              // platform (Bluesky / Fediverse / Nostr).
              <a
                href={data.externalUrl}
                target="_blank"
                rel="noopener noreferrer"
                onClick={(e) => e.stopPropagation()}
                className="block text-mono-xs text-grey-400 truncate hover:text-grey-600 hover:underline"
              >
                @{data.handle}
              </a>
            ) : (
              <p className="text-mono-xs text-grey-400 truncate">
                @{data.handle}
              </p>
            ))}
        </div>
      </div>

      {data.bio && (
        <p className="text-ui-xs text-grey-600 mt-2 line-clamp-2">{data.bio}</p>
      )}

      {(data.followerCount != null ||
        data.followingCount != null ||
        data.postCount != null) && (
        <div className="flex items-center gap-3 mt-2.5">
          {data.followerCount != null && (
            <span className="text-mono-xs text-grey-600">
              <span className="font-medium text-black">
                {formatCount(data.followerCount)}
              </span>{" "}
              followers
            </span>
          )}
          {data.followingCount != null && (
            <span className="text-mono-xs text-grey-600">
              <span className="font-medium text-black">
                {formatCount(data.followingCount)}
              </span>{" "}
              following
            </span>
          )}
          {data.postCount != null && (
            <span className="text-mono-xs text-grey-600">
              <span className="font-medium text-black">
                {formatCount(data.postCount)}
              </span>{" "}
              posts
            </span>
          )}
        </div>
      )}

      {(data.website || data.lightningAddress) && (
        <div className="flex flex-col gap-1 mt-2">
          {data.website && (
            <a
              href={data.website}
              target="_blank"
              rel="noopener noreferrer"
              onClick={(e) => e.stopPropagation()}
              className="text-mono-xs text-grey-600 truncate hover:text-black hover:underline"
            >
              {data.website.replace(/^https?:\/\//, "")}
            </a>
          )}
          {data.lightningAddress && (
            <span className="text-mono-xs text-grey-600 truncate">
              ⚡ {data.lightningAddress}
            </span>
          )}
        </div>
      )}

      {data.partial && (
        <p className="label-ui text-grey-300 mt-2">SOME DATA UNAVAILABLE</p>
      )}

      {data.followTarget && (
        <FollowButton
          target={data.followTarget}
          onClose={onClose}
          feedId={feedId}
        />
      )}

      {/* Per-feed VOLUME for followed sources — the parked pip panel's control,
          relocated here. Self-gates on feed context + follow state. */}
      <SourceVolume data={data} feedId={feedId} pubkey={pubkey} />
    </div>
  );
}

// Protocols the workspace addSource path can service (email is ingest-only —
// no Follow affordance until it's wired). Mirrors AddWorkspaceFeedSourceInput.
const FOLLOWABLE_PROTOCOLS = new Set([
  "rss",
  "atproto",
  "activitypub",
  "nostr_external",
]);

function FollowButton({
  target,
  onClose,
  feedId,
}: {
  target: NonNullable<AuthorCardData["followTarget"]>;
  onClose: () => void;
  feedId?: string;
}) {
  const isSource = target.type === "source";
  // External follow is feed-derived: "follow" means the source sits in THIS
  // feed (a feed_sources row). Without a feed context, or for a protocol we
  // can't add, there's no external Follow affordance.
  const externalFollowable =
    isSource &&
    !!feedId &&
    (!target.protocol || FOLLOWABLE_PROTOCOLS.has(target.protocol));

  // Seed the label from the server snapshot — `isFollowing` is the global
  // subscription state, which is the right initial guess for the common case
  // (a source is followed from the feed you're hovering in). For external
  // sources the authoritative state is per-feed, so we confirm it below; until
  // then the button is held disabled (`resolved`) so the label can't be acted
  // on while it's still a guess (avoids both the FOLLOW→FOLLOWING flicker and a
  // fast click firing the wrong path against an unresolved feedSourceId).
  const [following, setFollowing] = useState(target.isFollowing);
  const [resolved, setResolved] = useState(!isSource);
  const [busy, setBusy] = useState(false);
  // The feed_sources row id for the source in THIS feed, used to remove it.
  const [feedSourceId, setFeedSourceId] = useState<string | null>(null);
  // Native follow state from the shared store (external stays per-feed local).
  const nativeFollowing = useFollows((s) => s.ids.has(target.id));

  // Native follow is resolved from the server snapshot directly. External
  // membership is per-feed, so resolve it from the feed's own source list
  // (matched on the external_sources id) rather than the global isFollowing.
  useEffect(() => {
    if (!isSource) {
      // Native follow state is owned by the shared store; seed it with the
      // server snapshot (pre-hydration only) and ensure it's hydrated.
      useFollows.getState().prime(target.id, target.isFollowing);
      void useFollows.getState().hydrate();
      setResolved(true);
      return;
    }
    if (!externalFollowable || !feedId) {
      setFollowing(false);
      setFeedSourceId(null);
      setResolved(true);
      return;
    }
    let cancelled = false;
    setResolved(false);
    void workspaceFeeds
      .listSources(feedId)
      .then(({ sources }) => {
        if (cancelled) return;
        const row = target.sourceId
          ? sources.find(
              (s) =>
                s.sourceType === "external_source" &&
                s.externalSourceId === target.sourceId,
            )
          : undefined;
        setFollowing(!!row);
        setFeedSourceId(row?.id ?? null);
        setResolved(true);
      })
      .catch(() => {
        if (cancelled) return;
        setFollowing(false);
        setFeedSourceId(null);
        setResolved(true);
      });
    return () => {
      cancelled = true;
    };
  }, [
    isSource,
    externalFollowable,
    feedId,
    target.sourceId,
    target.isFollowing,
  ]);

  const handleClick = useCallback(
    async (e: React.MouseEvent) => {
      e.stopPropagation();
      if (busy) return;
      setBusy(true);

      try {
        if (!isSource) {
          // Native follow lives in the shared store — optimistic update,
          // revert, and author-card cache bust all happen there — so a toggle
          // here live-updates every other follow affordance for this writer.
          //
          // Since the reach retirement (migration 177, §9.16) the graph row
          // alone has no feed consequence, so with feed context the same
          // gesture also writes/removes the concrete `account` source for
          // THIS feed — converging with the external branch below: one Follow
          // button, one meaning, on either side of the native/external seam.
          // Best-effort: the graph toggle is the primary action and stands
          // even if the source write fails (DUPLICATE — already a source
          // here — lands in the same catch by design).
          if (nativeFollowing) {
            await useFollows.getState().unfollow(target.id);
            if (feedId) {
              try {
                const { sources } = await workspaceFeeds.listSources(feedId);
                const row = sources.find(
                  (s) => s.sourceType === "account" && s.accountId === target.id,
                );
                if (row) {
                  await workspaceFeeds.removeSource(feedId, row.id);
                  invalidateAuthorCardCache();
                }
              } catch {
                /* source row stays; removable by hand in the FeedComposer */
              }
            }
          } else {
            await useFollows.getState().follow(target.id);
            if (feedId) {
              try {
                await workspaceFeeds.addSource(feedId, {
                  sourceType: "account",
                  accountId: target.id,
                });
                invalidateAuthorCardCache();
              } catch {
                /* already a source here, or a transient failure — the follow stood */
              }
            }
          }
        } else if (feedId) {
          const prev = following;
          setFollowing(!prev);
          try {
            if (prev) {
              // Remove the source from this feed; the gateway tears down the
              // derived subscription when it leaves the owner's last feed.
              if (!feedSourceId) throw new Error("missing feed source id");
              await workspaceFeeds.removeSource(feedId, feedSourceId);
              setFeedSourceId(null);
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
              setFeedSourceId(source.id);
            }
            // Drop the shared author-card cache so the next hover re-derives.
            invalidateAuthorCardCache();
          } catch {
            setFollowing(prev);
          }
        }
      } finally {
        setBusy(false);
      }
    },
    [isSource, target, following, busy, feedId, feedSourceId, nativeFollowing],
  );

  // External byline with no feed context (e.g. a profile overlay) has no
  // follow gesture; native follow is unaffected.
  if (isSource && !externalFollowable) return null;

  // Native reads the live store; external uses the per-feed local state.
  const displayFollowing = isSource ? following : nativeFollowing;

  return (
    <button
      onClick={handleClick}
      disabled={busy || !resolved}
      className={`mt-3 w-full py-1.5 text-ui-xs font-medium transition-colors ${
        displayFollowing
          ? "bg-grey-100 text-grey-600 hover:bg-grey-200"
          : "bg-black text-white hover:bg-grey-800"
      }`}
    >
      {displayFollowing ? "FOLLOWING" : "FOLLOW"}
    </button>
  );
}

export function useAuthorHover(type: AuthorCardType, id: string | null) {
  const [open, setOpen] = useState(false);
  const bylineRef = useRef<HTMLElement>(null);
  // Two independent timers: one arms the open after a rest debounce, the other
  // is the close grace period. Keeping them separate is what makes the hover
  // bridge work — entering the modal cancels the close without touching open.
  const openTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const closeTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const supportsHover =
    typeof window !== "undefined" &&
    window.matchMedia("(hover: hover)").matches;

  const clearOpenTimer = useCallback(() => {
    if (openTimerRef.current) {
      clearTimeout(openTimerRef.current);
      openTimerRef.current = null;
    }
  }, []);

  const clearCloseTimer = useCallback(() => {
    if (closeTimerRef.current) {
      clearTimeout(closeTimerRef.current);
      closeTimerRef.current = null;
    }
  }, []);

  // 220ms grace: long enough for the pointer to cross the gap between the byline
  // and the modal (and between regions of the modal) without it disappearing
  // mid-reach.
  const scheduleClose = useCallback(() => {
    clearCloseTimer();
    closeTimerRef.current = setTimeout(() => setOpen(false), 220);
  }, [clearCloseTimer]);

  const onMouseEnter = useCallback(() => {
    if (!supportsHover || !id) return;
    // D2: native hover surfaces are suppressed while Explain is active. D1
    // already stops events reaching the byline through the scrim, but this is
    // belt-and-braces for any hover armed just before activation.
    if (useExplain.getState().isActive) return;
    clearCloseTimer();
    clearOpenTimer();
    openTimerRef.current = setTimeout(() => setOpen(true), 300);
  }, [supportsHover, id, clearCloseTimer, clearOpenTimer]);

  // D2: a modal already open when Explain activates closes rather than lingering
  // under the scrim.
  const explainActive = useExplain((s) => s.isActive);
  useEffect(() => {
    if (explainActive) {
      clearOpenTimer();
      clearCloseTimer();
      setOpen(false);
    }
  }, [explainActive, clearOpenTimer, clearCloseTimer]);

  const onMouseLeave = useCallback(() => {
    clearOpenTimer();
    scheduleClose();
  }, [clearOpenTimer, scheduleClose]);

  // Pointer reached the modal → cancel the pending close so it stays open while
  // the user moves to its buttons; leaving the modal re-arms the close.
  const onModalMouseEnter = useCallback(() => {
    clearCloseTimer();
  }, [clearCloseTimer]);

  const onModalMouseLeave = useCallback(() => {
    scheduleClose();
  }, [scheduleClose]);

  const onModalClose = useCallback(() => {
    clearOpenTimer();
    clearCloseTimer();
    setOpen(false);
  }, [clearOpenTimer, clearCloseTimer]);

  useEffect(() => {
    return () => {
      clearOpenTimer();
      clearCloseTimer();
    };
  }, [clearOpenTimer, clearCloseTimer]);

  return {
    bylineRef,
    open,
    onMouseEnter,
    onMouseLeave,
    onModalMouseEnter,
    onModalMouseLeave,
    onModalClose,
    type,
    id,
  };
}
