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
import { failureSentence } from "../../lib/api/client";
import { openProfileHref, isModifiedClick } from "../ui/ProfileLink";
import { useEscapeShield } from "../../hooks/useEscapeShield";
import { safeHttpUrl } from "../../lib/external-links";
import { useLightbox } from "../../stores/lightbox";
import { useFollows } from "../../stores/follows";
import {
  useFeedFollow,
  isFeedFollowable,
  matchFeedSource,
  feedFollowAddInput,
  reportFollowState,
  type FeedFollowTarget,
} from "../../hooks/useFeedFollow";
import { FeedFollowMenu } from "./FeedFollowMenu";
import { Pointer } from "../ui/Pointer";
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
  // The workspace feed this byline was hovered in — the context that decides
  // where a follow lands. Present ⇒ one press adds/removes the source in THIS
  // feed (and, for a native writer, the graph row beside it). ABSENT ⇒ the
  // surface is feed-less (the article page, /read/:postId, /tag, a profile
  // log, the reader), nothing can decide for the reader, and the button
  // becomes the same "Follow ▾" feed picker the profile bar carries (§9.16).
  // It used to hide external follow outright here and toggle native follow
  // into no feed at all.
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
  // The in-panel feed picker's open state, lifted because it changes how the
  // PANEL dismisses: hover-close would snatch the menu away the moment the
  // pointer crossed one of its rows, and Escape has to close the menu before
  // the panel. The picker renders inside `modalRef`, so outside-pointerdown
  // and the click-swallow already cover it.
  const [pickerOpen, setPickerOpen] = useState(false);
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
  // Yield to the picker as well as the lightbox: both listeners sit on
  // `document`, this one registers first (the panel mounts before the menu
  // opens), so it must stand aside or one Escape would close the whole panel
  // out from under an open menu. Two Escapes, two surfaces.
  useEscapeShield(
    true,
    onClose,
    () => useLightbox.getState().isOpen || pickerOpen,
  );

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

  // The above/below decision is taken once against a ~320px budget, so a panel
  // that grows (the picker) must be bounded rather than allowed to run off the
  // viewport. Capping against the SAME anchor the panel is positioned by keeps
  // it on screen either way; the `above` case already grew upward safely.
  const style: React.CSSProperties = {
    position: "fixed",
    left: position.left,
    width: 300,
    zIndex,
    overflowY: "auto",
    ...(position.below
      ? {
          top: position.top,
          maxHeight: Math.max(160, window.innerHeight - position.top - 8),
        }
      : {
          bottom: window.innerHeight - position.top,
          maxHeight: Math.max(160, position.top - 8),
        }),
  };

  return createPortal(
    <div
      ref={modalRef}
      style={style}
      className="bg-white shadow-lg p-4"
      onMouseEnter={onMouseEnter}
      onMouseLeave={
        // `dismissOnMouseLeave`'s first real use as false (it has been
        // declared and never passed since it was written): while the picker is
        // open the panel is click-dismissed, not hover-dismissed. Both arms
        // are suppressed — the bridge's own handler re-ARMS the close timer,
        // so leaving only `onClose` out would still lose the menu.
        pickerOpen
          ? undefined
          : (onMouseLeave ?? (dismissOnMouseLeave ? onClose : undefined))
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
          onPickerOpenChange={setPickerOpen}
        />
      )}
      {!data && !loading && (
        <p className="text-ui-xs text-grey-400">Couldn’t load this profile.</p>
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
  onPickerOpenChange,
}: {
  data: AuthorCardData;
  onClose: () => void;
  feedId?: string;
  pubkey?: string;
  frameScheme?: FeedScheme | null;
  onPickerOpenChange: (open: boolean) => void;
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
          This source doesn’t say much about who wrote it
        </p>
        {data.followTarget && (
          <FollowButton
            target={data.followTarget}
            feedId={feedId}
            onPickerOpenChange={onPickerOpenChange}
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
            feedId={feedId}
            onPickerOpenChange={onPickerOpenChange}
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
            (safeHttpUrl(data.externalUrl) ? (
              // The handle links out to the author's profile on the origin
              // platform (Bluesky / Fediverse / Nostr) — through `safeHttpUrl`,
              // like every href that leaves all.haus (CA-E15).
              <a
                href={safeHttpUrl(data.externalUrl)}
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
              href={safeHttpUrl(data.website)}
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
        <p className="label-ui text-grey-300 mt-2">Some details couldn’t be loaded</p>
      )}

      {data.followTarget && (
        <FollowButton
          target={data.followTarget}
          feedId={feedId}
          onPickerOpenChange={onPickerOpenChange}
        />
      )}

      {/* Per-feed VOLUME for followed sources — the parked pip panel's control,
          relocated here. Self-gates on feed context + follow state. */}
      <SourceVolume data={data} feedId={feedId} pubkey={pubkey} />
    </div>
  );
}

// -----------------------------------------------------------------------------
// The hover panel's follow affordance — TWO SHAPES, decided by whether the
// context already answers "into which feed?" (§9.16).
//
//   feedId present  → FeedScopedFollowButton. The byline was hovered inside a
//                     vessel, so the feed IS the answer: one press, no menu.
//   feedId absent   → PickerFollowButton. The article page, /read/:postId,
//                     /tag, a profile log, the reader — nothing here decides,
//                     so the reader is asked, with the same picker the profile
//                     bar carries. Before this the panel hid external follow
//                     outright on those surfaces and toggled native follow
//                     into no feed at all, which is the whole complaint.
//
// The matching and add rules are NOT restated here: both shapes take
// `matchFeedSource` / `feedFollowAddInput` from `useFeedFollow`, so a feed
// press and a menu tick cannot come to mean different things.
// -----------------------------------------------------------------------------

function FollowButton({
  target,
  feedId,
  onPickerOpenChange,
}: {
  target: FeedFollowTarget;
  feedId?: string;
  onPickerOpenChange: (open: boolean) => void;
}) {
  return feedId ? (
    <FeedScopedFollowButton target={target} feedId={feedId} />
  ) : (
    <PickerFollowButton
      target={target}
      onPickerOpenChange={onPickerOpenChange}
    />
  );
}

const BUTTON_CLASS =
  "mt-3 w-full py-1.5 text-ui-xs font-medium transition-colors";

function buttonTone(following: boolean): string {
  return following
    ? "bg-grey-100 text-grey-600 hover:bg-grey-200"
    : "bg-black text-white hover:bg-grey-800";
}

function FeedScopedFollowButton({
  target,
  feedId,
}: {
  target: FeedFollowTarget;
  feedId: string;
}) {
  const native = target.type === "user";
  const followable = isFeedFollowable(target);

  // ONE CODE PATH FOR BOTH KINDS, and the label is about THIS FEED. It used to
  // fork: external read per-feed membership, native read the global graph
  // store. That disagreed with what the press did the moment a native follow
  // became feed-derived — press FOLLOWING on a writer who also sits in another
  // feed and the row leaves this one while the global label stays put, so the
  // button reads as inert. Per-feed for both is what "one Follow button, one
  // meaning, either side of the seam" actually requires. A native card can
  // also reach a feed through a TAG source, where the author is no account
  // source of this feed and the button honestly reads FOLLOW: pressing it
  // puts them in, which is exactly what it says.
  //
  // Seeded from the server snapshot so the first paint is usually right, held
  // disabled until resolved so the label can't be acted on while it is a
  // guess (avoids both the FOLLOW→FOLLOWING flicker and a fast click firing
  // the wrong path against an unresolved row id).
  const [following, setFollowing] = useState(target.isFollowing);
  const [resolved, setResolved] = useState(false);
  const [busy, setBusy] = useState(false);
  const [rowId, setRowId] = useState<string | null>(null);
  // A failed press SAYS so (web-foundations › a press that fails), and a
  // membership that failed to load asserts nothing: no FOLLOW label that
  // would be a guess, just the failure and a Retry, which bumps `attempt`.
  const [error, setError] = useState<string | null>(null);
  const [loadFailed, setLoadFailed] = useState(false);
  const [attempt, setAttempt] = useState(0);

  // The shared store still matters here even though this label no longer
  // reads it: a press must update every OTHER mounted follow affordance for
  // this writer, and `prime` keeps the pre-hydration snapshot honest.
  useEffect(() => {
    if (native) {
      useFollows.getState().prime(target.id, target.isFollowing);
      void useFollows.getState().hydrate();
    }
  }, [native, target.id, target.isFollowing]);

  useEffect(() => {
    if (!followable) {
      setFollowing(false);
      setRowId(null);
      setResolved(true);
      return;
    }
    let cancelled = false;
    setResolved(false);
    setLoadFailed(false);
    void workspaceFeeds
      .listSources(feedId)
      .then(({ sources }) => {
        if (cancelled) return;
        const id = matchFeedSource(sources, target);
        setFollowing(!!id);
        setRowId(id);
        setResolved(true);
      })
      .catch(() => {
        if (cancelled) return;
        setRowId(null);
        setLoadFailed(true);
      });
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [followable, feedId, target.type, target.id, target.sourceId, attempt]);

  const handleClick = useCallback(
    async (e: React.MouseEvent) => {
      e.stopPropagation();
      if (busy || !resolved) return;
      setBusy(true);
      setError(null);
      const prev = following;
      setFollowing(!prev);
      try {
        if (prev) {
          // Removal needs only the row id — never gate it on
          // protocol/sourceUri, or an unfollow of an already-followed source
          // silently no-ops when those are absent. The gateway tears down the
          // derived subscription, and for an account source the native
          // follow, when this was the owner's last feed holding it.
          if (!rowId) throw new Error("missing feed source id");
          const res = await workspaceFeeds.removeSource(feedId, rowId);
          setRowId(null);
          reportFollowState(native ? target.id : null, res.following);
        } else {
          const input = feedFollowAddInput(target);
          if (!input) throw new Error("nothing to add");
          const res = await workspaceFeeds.addSource(feedId, input);
          setRowId(res.source.id);
          reportFollowState(native ? target.id : null, res.following);
        }
        // Drop the shared author-card cache so the next hover re-derives.
        invalidateAuthorCardCache();
      } catch (err) {
        setFollowing(prev);
        // The route's refusals (a dead source, a blocked account) are
        // sentences worth reading; otherwise say what did not happen.
        setError(
          failureSentence(
            err,
            prev
              ? "Couldn’t take this out of the channel. Nothing has changed."
              : "Couldn’t add this to the channel. Nothing has changed.",
          ),
        );
      } finally {
        setBusy(false);
      }
    },
    [native, target, following, busy, resolved, feedId, rowId],
  );

  // A protocol we can't add (e.g. email) has no follow gesture at all.
  if (!followable) return null;

  if (loadFailed) {
    return (
      <p role="alert" className="mt-3 text-ui-xs text-crimson">
        Couldn’t check whether this is in the channel.{" "}
        <button
          className="btn-text"
          onClick={(e) => {
            e.stopPropagation();
            setAttempt((n) => n + 1);
          }}
        >
          Retry
        </button>
      </p>
    );
  }

  return (
    <>
      <button
        onClick={handleClick}
        disabled={busy || !resolved}
        className={`${BUTTON_CLASS} ${buttonTone(following)}`}
      >
        {following ? "FOLLOWING" : "FOLLOW"}
      </button>
      {error && (
        <p role="alert" className="mt-1.5 text-ui-xs text-crimson">
          {error}
        </p>
      )}
    </>
  );
}

function PickerFollowButton({
  target,
  onPickerOpenChange,
}: {
  target: FeedFollowTarget;
  onPickerOpenChange: (open: boolean) => void;
}) {
  const [open, setOpen] = useState(false);
  const state = useFeedFollow(target, open);

  // The panel has to know: while the menu is up it stops dismissing on
  // mouse-leave and stands aside on Escape. Reported on unmount too, so a
  // panel closed with its menu open doesn't leave the flag stuck.
  useEffect(() => {
    onPickerOpenChange(open);
    return () => onPickerOpenChange(false);
  }, [open, onPickerOpenChange]);

  // One Escape closes the menu, the next closes the panel. This listener
  // registers when the menu opens — after the panel's — and the panel's yields
  // to it, so order and arbitration agree.
  useEscapeShield(
    open,
    () => setOpen(false),
    () => useLightbox.getState().isOpen,
  );

  if (!state.followable) return null;

  return (
    <div onClick={(e) => e.stopPropagation()}>
      <button
        onClick={() => setOpen((o) => !o)}
        className={`${BUTTON_CLASS} ${buttonTone(state.following)}`}
      >
        {state.following ? "FOLLOWING" : "FOLLOW"}{" "}
        <Pointer direction="down" size="sm" className="ml-1" />
      </button>

      {/* IN FLOW, NOT PORTALLED (§9.16's positioning ruling). The panel's own
          outside-pointerdown test is `modalRef.contains(target)`, so a menu
          rendered inside it inherits the dismissal, the hover bridge and the
          click-swallow for nothing; a separately-portalled layer would sit
          outside that node, read as "outside", and close the whole panel on
          its own first click. The list is capped and scrolls so the panel
          stays near the ~320px budget its above/below decision was taken
          against — and the panel now carries its own maxHeight as a backstop. */}
      {open && (
        <div className="mt-2">
          <FeedFollowMenu state={state} register="panel" maxListHeight={132} />
        </div>
      )}
    </div>
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
