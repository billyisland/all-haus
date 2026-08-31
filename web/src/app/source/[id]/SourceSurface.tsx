"use client";

import { useCallback, useEffect, useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { PageShell } from "../../../components/ui/PageShell";
import { PostCardInteractive } from "../../../components/post/PostCardInteractive";
import { FEED_LOG_STYLE } from "../../../components/profile/ProfileChrome";
import { ProfileFollowControl } from "../../../components/profile/ProfileFollowControl";
import { PostThread } from "../../../components/post/PostThread";
import type { CardContext } from "../../../components/post/chassis";
import {
  globalContentPalette,
  DEFAULT_DENSITY,
  DEFAULT_TEXT_SIZE,
  TEXT_SIZE_PX,
} from "../../../components/workspace/tokens";
import { sources, type SourceMeta } from "../../../lib/api/feeds";
import type { Post } from "../../../lib/post/types";
import { quotePreviewContent } from "../../../lib/post/quote-preview";
import { useCompose } from "../../../stores/compose";
import { useColorScheme } from "../../../stores/colorScheme";
import { ApiError } from "../../../lib/api/client";

// =============================================================================
// /source/:id — the external source surface (CARD-BEHAVIOUR-ADR §VI.2).
//
// Source meta header + a chronological full-view PostCard log from
// GET /sources/:id. Rendered through the one Post-model path (PostCardInteractive
// / PostThread), exactly like AuthorProfileView — external posts expand inline to
// the unified thread; nothing routes out to the origin platform from a card body.
// Shared by the standalone /source/:id page and the workspace SurfaceOverlay.
// =============================================================================

const PROTOCOL_LABELS: Record<string, string> = {
  rss: "VIA RSS",
  atproto: "VIA BLUESKY",
  activitypub: "VIA FEDIVERSE",
  nostr_external: "VIA NOSTR",
  email: "VIA EMAIL",
};

export function SourceSurface({ id }: { id: string }) {
  const router = useRouter();
  // Cards follow the GLOBAL light/dark toggle (surface overlay, not a vessel).
  const dark = useColorScheme((s) => s.dark);
  const CTX: CardContext = {
    density: DEFAULT_DENSITY,
    palette: globalContentPalette(dark),
    bodyPx: TEXT_SIZE_PX[DEFAULT_TEXT_SIZE],
  };
  const [source, setSource] = useState<SourceMeta | null>(null);
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

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setError(false);
    setNotFound(false);
    sources
      .get(id)
      .then((res) => {
        if (cancelled) return;
        setSource(res.source);
        setItems(res.items);
        setCursor(res.nextCursor);
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
    };
  }, [id]);

  const loadMore = useCallback(() => {
    if (!cursor || loadingMore) return;
    setLoadingMore(true);
    sources
      .get(id, cursor)
      .then((res) => {
        setItems((prev) => [...prev, ...res.items]);
        setCursor(res.nextCursor);
      })
      .catch(() => setError(true))
      .finally(() => setLoadingMore(false));
  }, [id, cursor, loadingMore]);

  const toggleExpand = useCallback((postId: string) => {
    setExpanded((prev) => {
      const next = new Map(prev);
      if (next.has(postId)) next.delete(postId);
      else next.set(postId, postId);
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
    return (
      <PageShell width="feed">
        <div className="label-ui text-grey-600 py-12 text-center">LOADING…</div>
      </PageShell>
    );
  }

  if (notFound) {
    return (
      <PageShell width="feed" title="Source not found">
        <p className="font-sans text-ui-sm text-grey-600">
          This source isn&apos;t available.{" "}
          <Link href="/reader" className="btn-text">
            Back to workspace
          </Link>
        </p>
      </PageShell>
    );
  }

  if (error || !source) {
    return (
      <PageShell width="feed" title="Couldn’t load source">
        <p className="font-sans text-ui-sm text-grey-600">
          Something went wrong loading this source.
        </p>
      </PageShell>
    );
  }

  const protocolLabel =
    PROTOCOL_LABELS[source.protocol] ?? source.protocol.toUpperCase();
  const name = source.displayName ?? source.sourceUri;

  return (
    <PageShell width="feed">
      {/* Source header */}
      <div className="mb-8">
        <div className="label-ui text-grey-600 mb-1">{protocolLabel}</div>
        <div className="flex items-start justify-between gap-4">
          <h1 className="font-sans text-2xl font-medium text-black tracking-tight">
            {name}
          </h1>
          {/* BYLINE-AND-PROVENANCE-ADR D6/D7 ⟂: this surface is where the
              provenance line sends people and the follow target for every
              source-scoped author, so "you follow the Guardian" has to be
              true HERE. The same feed-derived picker AuthorProfileView
              mounts — never a standalone subscribe (CLAUDE.md Invariants). */}
          {source.followTarget && (
            <div className="flex-shrink-0 pt-1">
              <ProfileFollowControl target={source.followTarget} />
            </div>
          )}
        </div>
        {source.description && (
          <p className="font-sans text-ui-sm text-grey-600 mt-2 max-w-feed">
            {source.description}
          </p>
        )}
      </div>

      {items.length === 0 ? (
        <div className="label-ui text-grey-600 py-12 text-center">
          NO ITEMS YET
        </div>
      ) : (
        // The feed's own rhythm — `FEED_LOG_STYLE`'s column gap PLUS each
        // PostCard's `GAP_PX.feed` margin = 20px, which is what a vessel
        // renders (PROFILE-PANE-REDESIGN-ADR §9.2). This log spent a while at
        // 8px on a comment asserting 8px WAS the feed's gap; it is the card
        // margin measured without the column it lives in.
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
            className="btn-text-muted"
          >
            {loadingMore ? "LOADING…" : "SHOW MORE"}
          </button>
        </div>
      )}
    </PageShell>
  );
}
