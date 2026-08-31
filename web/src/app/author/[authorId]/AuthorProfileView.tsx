"use client";

import { useCallback, useEffect, useState, type ReactNode } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { PostCardInteractive } from "../../../components/post/PostCardInteractive";
import { PostThread } from "../../../components/post/PostThread";
import type { CardContext } from "../../../components/post/chassis";
import {
  DEFAULT_DENSITY,
  DEFAULT_TEXT_SIZE,
  TEXT_SIZE_PX,
  type FeedScheme,
} from "../../../components/workspace/tokens";
import {
  ProfileBar,
  ProfileMeta,
  ProfileSurface,
  ProfileWritingIn,
  FEED_LOG_STYLE,
  profileIslandStyle,
  profilePalette,
  protocolChipLabel,
  type ProfileIdentity,
} from "../../../components/profile/ProfileChrome";
import { useResolvedDark } from "../../../stores/colorScheme";
import {
  authorProfile,
  authorPosts,
  type AuthorProfile,
} from "../../../lib/api/post";
import type { Post } from "../../../lib/post/types";
import { quotePreviewContent } from "../../../lib/post/quote-preview";
import { useCompose } from "../../../stores/compose";
import { ProfileFollowControl } from "../../../components/profile/ProfileFollowControl";
import { IdentityLinkControl } from "../../../components/profile/IdentityLinkControl";
import { ApiError } from "../../../lib/api/client";

// =============================================================================
// /author/:authorId — the constructed author profile (UNIVERSAL-POST-ADR §4.4).
//
// Header from GET /author/:id/profile, a chronological full-view PostCard log
// from GET /author/:id/posts. Reached from a tier-A/B external byline (and works
// for native ids too, though native bylines route to /{username}). Native
// articles open at /article/<dTag>, external at /read/<postId>; notes/external
// expand inline to the unified PostThread, exactly as in the workspace.
//
// It renders the SHARED profile chassis (components/profile/ProfileChrome) —
// the same four tiers as the native profile, differing only in what a tier can
// hold: an external profile has no tab rig, and its identity row draws the
// `detected` / `asserted` tiers rather than `verified`, because an assertion
// needs two external_sources endpoints and a presence needs an accounts row.
// "One row on both kinds" is one GRAMMAR, not one query (D7).
// =============================================================================

function formatCount(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 1_000) return `${(n / 1_000).toFixed(1)}K`;
  return String(n);
}

export function AuthorProfileView({
  authorId,
  inOverlay = false,
  onClose,
  scheme,
}: {
  authorId: string;
  inOverlay?: boolean;
  /** The overlay register's alone (§5.1) — tier 1 renders the ✕ only when it
   *  is given one, and the standalone page has nothing to close (D10). */
  onClose?: () => void;
  /** The launching feed's colourway (overlay register only): the pane wears it
   *  entire. Absent on the standalone page and on feed-agnostic launches. */
  scheme?: FeedScheme | null;
}) {
  const router = useRouter();
  // Off a feed card the whole pane wears that feed's colourway; everywhere else
  // (this page, a feed-agnostic launch) the content log follows the GLOBAL
  // light/dark toggle. useResolvedDark, NOT useColorScheme().dark:
  // /author/[authorId] is SSR'd and the store's `dark` only flips in a
  // post-mount effect, so a dark-mode visitor painted light and snapped (§4.2 —
  // this surface was the recorded instance of that bug).
  const dark = useResolvedDark();
  const palette = profilePalette(scheme, dark);
  const CTX: CardContext = {
    density: DEFAULT_DENSITY,
    palette,
    bodyPx: TEXT_SIZE_PX[DEFAULT_TEXT_SIZE],
  };

  // The load/error/not-found states arrive before there is an identity to put
  // in tier 1, so they render on the interior ground alone — the surface's
  // colour, but no bar claiming to be a person we haven't got.
  const frame = (children: ReactNode) => (
    <div
      data-explain="profile"
      style={{
        ...profileIslandStyle(scheme),
        background: palette.interior,
        minHeight: inOverlay ? "100%" : "100dvh",
        padding: 8,
      }}
    >
      {children}
    </div>
  );
  const [profile, setProfile] = useState<AuthorProfile | null>(null);
  const [items, setItems] = useState<Post[]>([]);
  const [cursor, setCursor] = useState<string | undefined>(undefined);
  const [loading, setLoading] = useState(true);
  const [loadingMore, setLoadingMore] = useState(false);
  const [notFound, setNotFound] = useState(false);
  const [error, setError] = useState(false);
  // host post id → thread root id. Usually root === host; a quote-tile click on
  // a collapsed card roots the thread on the QUOTED post instead (fresh focal,
  // no residue of the quoting host — the WorkspaceView expandQuote grammar).
  const [expanded, setExpanded] = useState<Map<string, string>>(new Map());
  // The gateway kicked a background timeline hydration for this author
  // (EXTERNAL-AUTHOR-HISTORY-ADR §3.1): show a quiet status line while the
  // log is empty and refetch the first page once after ~2.5s (single retry,
  // then rest — the thread projector's established pattern).
  const [hydrating, setHydrating] = useState(false);

  useEffect(() => {
    let cancelled = false;
    let refetchTimer: ReturnType<typeof setTimeout> | undefined;
    setLoading(true);
    setError(false);
    setNotFound(false);
    setHydrating(false);
    Promise.all([authorProfile(authorId), authorPosts(authorId)])
      .then(([prof, posts]) => {
        if (cancelled) return;
        setProfile(prof);
        setItems(posts.items);
        setCursor(posts.nextCursor);
        if (posts.hydrating) {
          setHydrating(true);
          refetchTimer = setTimeout(() => {
            authorPosts(authorId)
              .then((res) => {
                if (cancelled) return;
                setItems(res.items);
                setCursor(res.nextCursor);
              })
              .catch(() => {
                /* keep whatever the first page showed */
              })
              .finally(() => {
                if (!cancelled) setHydrating(false);
              });
          }, 2500);
        }
      })
      .catch((err) => {
        if (cancelled) return;
        if (err instanceof ApiError && err.status === 404) setNotFound(true);
        else setError(true);
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
      if (refetchTimer) clearTimeout(refetchTimer);
    };
  }, [authorId]);

  const loadMore = useCallback(() => {
    if (!cursor || loadingMore) return;
    setLoadingMore(true);
    authorPosts(authorId, cursor)
      .then((res) => {
        setItems((prev) => [...prev, ...res.items]);
        setCursor(res.nextCursor);
      })
      .catch(() => setError(true))
      .finally(() => setLoadingMore(false));
  }, [authorId, cursor, loadingMore]);

  const toggleExpand = useCallback((id: string) => {
    setExpanded((prev) => {
      const next = new Map(prev);
      if (next.has(id)) next.delete(id);
      else next.set(id, id);
      return next;
    });
  }, []);

  const expandQuote = useCallback((hostId: string, quotedPostId: string) => {
    setExpanded((prev) => new Map(prev).set(hostId, quotedPostId));
  }, []);

  // Article → its addressable reader page (no overlay is mounted off-workspace).
  const openReader = useCallback(
    (p: Post) => {
      if (p.author.pubkey) {
        if (p.dTag) router.push(`/article/${p.dTag}`);
      } else {
        router.push(`/read/${p.id}`);
      }
    },
    [router],
  );

  // Native reply via the global compose overlay (mounted in app/layout).
  const replyFromPost = useCallback((p: Post) => {
    if (!p.author.pubkey) return;
    useCompose.getState().open("reply", {
      eventId: p.version ?? p.id,
      eventKind: p.type === "article" ? 30023 : 1,
      authorPubkey: p.author.pubkey,
      previewContent: quotePreviewContent(p),
    });
  }, []);

  if (loading) {
    return frame(
      <div
        className="label-ui py-12 text-center"
        style={{ color: palette.cardMeta }}
      >
        LOADING…
      </div>,
    );
  }

  if (notFound) {
    return frame(
      <p className="font-sans text-ui-sm py-12" style={{ color: palette.cardMeta }}>
        This author isn&apos;t available.{" "}
        <Link href="/reader" className="btn-text">
          Back to workspace
        </Link>
      </p>,
    );
  }

  if (error || !profile) {
    return frame(
      <p className="font-sans text-ui-sm py-12" style={{ color: palette.cardMeta }}>
        Something went wrong loading this profile.
      </p>,
    );
  }

  const name = profile.displayName ?? profile.handle ?? "Author";
  const hasStats =
    profile.followerCount != null ||
    profile.followingCount != null ||
    profile.postCount != null;

  // The identity row (D7). An external profile draws the two owner-scoped
  // tiers: `detected` is a link the PLATFORM inferred (a global row, owner
  // NULL), `asserted` is one the VIEWER made. The boundary is owner-scope, not
  // a hand-list of link_type names — so `cross_link`, if Slice 8 ever lands it,
  // joins `detected` without a change here.
  //
  // This reuses the gateway's EXISTING linkedSources projection, which already
  // subtracts the viewer's `user_unlinked` tombstones. Writing a second query
  // over that table would rebuild the "Stop merging did nothing" bug as display.
  const identities: ProfileIdentity[] = (profile.linkedSources ?? []).map(
    (l) => ({
      key: l.linkId,
      tier: l.detected ? "detected" : "asserted",
      protocol: protocolChipLabel(l.protocol),
      label: l.displayName || l.sourceUri,
    }),
  );

  // The tier-C log header (BYLINE-AND-PROVENANCE-ADR D6, S4). A source-scoped
  // author record has no bio, no website, no handle and no origin profile —
  // its one fact beyond the name is the source it writes in, which is also
  // its follow target. `sourceId` rides `followTarget` (the S3 shape); when
  // the backing source row is gone the gateway's base response carries no
  // `sourceName` either, so the line simply doesn't render.
  const writingIn =
    profile.tier === "C" && profile.sourceName ? (
      <ProfileWritingIn
        palette={palette}
        sources={[
          {
            key: profile.followTarget?.sourceId ?? profile.sourceName,
            name: profile.sourceName,
            protocol: protocolChipLabel(profile.sourceProtocol ?? ""),
            href: profile.followTarget?.sourceId
              ? `/source/${profile.followTarget.sourceId}`
              : undefined,
          },
        ]}
      />
    ) : undefined;

  // Counts are mono and tabular (D4). Unlike the native profile these are not
  // links: there is no followers/following view for an external author, and a
  // number that looks pressable but is not is worse than a plain one.
  const stats = hasStats ? (
    <>
      {[
        profile.followerCount != null &&
          `${formatCount(profile.followerCount)} FOLLOWERS`,
        profile.followingCount != null &&
          `${formatCount(profile.followingCount)} FOLLOWING`,
        profile.postCount != null &&
          `${formatCount(profile.postCount)} POSTS`,
      ]
        .filter(Boolean)
        .join(" · ")}
    </>
  ) : null;

  return (
    <ProfileSurface
      palette={palette}
      scheme={scheme}
      minHeight={inOverlay ? "100%" : "100dvh"}
      bar={
        <ProfileBar
          palette={palette}
          avatarUrl={profile.avatarUrl}
          name={name}
          handle={profile.handle ? `@${profile.handle}` : null}
          // BOTH the name and the handle go to this person's page on their own
          // network. That out-link is what the "VIA BLUESKY" strap above the
          // name used to gesture at without offering, and dropping the strap
          // takes a line back off tier 1 (web/CLAUDE.md › Profile chassis).
          handleHref={profile.externalUrl}
          nameHref={profile.externalUrl}
          identityControl={
            // The `+` is EXTERNAL-only (D7) and asserts at the `asserted` tier:
            // it needs a source the viewer can link another identity to. A
            // tier-C author (BYLINE-AND-PROVENANCE-ADR D4) has a source-typed
            // follow target too, but is UNLINKABLE — the only edge the
            // source-only link graph could write for a journalist would merge
            // their whole paper — so the control is withheld, not offered and
            // 400'd.
            profile.followTarget?.type === "source" && profile.tier !== "C" ? (
              <IdentityLinkControl
                authorId={authorId}
                initial={profile.linkedSources}
                palette={palette}
              />
            ) : undefined
          }
          actions={
            profile.followTarget ? (
              <ProfileFollowControl
                target={profile.followTarget}
                palette={palette}
              />
            ) : undefined
          }
          onClose={onClose}
        />
      }
    >
      <ProfileMeta
        palette={palette}
        writingIn={writingIn}
        bio={profile.bio}
        stats={stats}
        identities={identities}
      />

      {items.length === 0 ? (
        <div
          className="label-ui py-12 text-center"
          style={{ color: palette.cardMeta }}
        >
          {hydrating ? "FETCHING RECENT POSTS FROM THE NETWORK…" : "NO POSTS YET"}
        </div>
      ) : (
        // The feed's own rhythm, which is the column gap PLUS the card's own
        // margin = 20px (§9.2). The comment this replaces said a `gap` here
        // would double the 8px margin — true, and 8px was never the feed's
        // figure; it was the margin measured without the column it lives in.
        <div style={FEED_LOG_STYLE}>
          {items.map((post) =>
            expanded.has(post.id) && post.type !== "article" ? (
              <PostThread
                key={post.id}
                rootPostId={expanded.get(post.id) ?? post.id}
                ctx={CTX}
                onCollapse={() => toggleExpand(post.id)}
                onReply={replyFromPost}
                onOpenReader={openReader}
              />
            ) : (
              <PostCardInteractive
                key={post.id}
                post={post}
                level="feed"
                expanded={false}
                ctx={CTX}
                onExpand={() => toggleExpand(post.id)}
                onQuoteOpen={(qid) => expandQuote(post.id, qid)}
                onOpenReader={openReader}
                onReply={
                  post.author.pubkey ? () => replyFromPost(post) : undefined
                }
              />
            ),
          )}
        </div>
      )}

      {cursor && (
        <div className="pt-8 text-center">
          <button
            type="button"
            onClick={loadMore}
            disabled={loadingMore}
            className="text-ui-xs transition-opacity hover:opacity-70"
            style={{
              background: "none",
              border: "none",
              cursor: "pointer",
              color: palette.cardMeta,
            }}
          >
            {loadingMore ? "LOADING…" : "SHOW MORE"}
          </button>
        </div>
      )}
    </ProfileSurface>
  );
}
