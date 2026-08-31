"use client";

import { useState, useEffect, useCallback, useRef } from "react";
import { useRouter } from "next/navigation";
import { PostCardInteractive } from "../../../components/post/PostCardInteractive";
import { FEED_LOG_STYLE } from "../../../components/profile/ProfileChrome";
import type { CardContext } from "../../../components/post/chassis";
import {
  globalContentPalette,
  DEFAULT_DENSITY,
  DEFAULT_TEXT_SIZE,
  TEXT_SIZE_PX,
} from "../../../components/workspace/tokens";
import { tagPosts } from "../../../lib/api/post";
import type { Post } from "../../../lib/post/types";
import { quotePreviewContent } from "../../../lib/post/quote-preview";
import { useReader } from "../../../stores/reader";
import { useCompose } from "../../../stores/compose";
import { useColorScheme } from "../../../stores/colorScheme";

// =============================================================================
// /tag/:name — articles for one tag, rendered through the one Post-model path
// (PostCardInteractive), the same as SourceSurface / AuthorProfileView
// (FEED-RETIREMENT Slice 4). Tags are article-only, so every row is an article
// card opening the reader; there is no thread expansion here.
//
// `inOverlay` is set when TagBrowser renders inside the surface overlay
// (useSurfaceOverlay): article rows open the reader overlay in place rather than
// navigating to /article/:dTag and escaping the workspace to the black topbar.
// The standalone /tag/[tag] page leaves it false (full-page navigation).
//
// `initialItems`/`initialTotal`/`initialCursor` are seeded by the server
// `page.tsx` (SSR, perf-audit #5) so the first paint already carries the list;
// when present the initial client fetch is skipped. The overlay passes none, so
// it keeps fetching client-side (with the viewer's cookie).
// =============================================================================

export function TagBrowser({
  tagName,
  inOverlay = false,
  initialItems,
  initialTotal,
  initialCursor,
}: {
  tagName: string;
  inOverlay?: boolean;
  initialItems?: Post[];
  initialTotal?: number;
  initialCursor?: string;
}) {
  const router = useRouter();
  // Cards follow the GLOBAL light/dark toggle (this is a surface overlay, not a
  // feed vessel).
  const dark = useColorScheme((s) => s.dark);
  const CTX: CardContext = {
    density: DEFAULT_DENSITY,
    palette: globalContentPalette(dark),
    bodyPx: TEXT_SIZE_PX[DEFAULT_TEXT_SIZE],
  };
  const openNative = useReader((s) => s.openNative);
  const hasInitial = initialItems != null;
  const [items, setItems] = useState<Post[]>(initialItems ?? []);
  const [total, setTotal] = useState(initialTotal ?? 0);
  const [cursor, setCursor] = useState<string | undefined>(initialCursor);
  const [loading, setLoading] = useState(!hasInitial);
  const [loadingMore, setLoadingMore] = useState(false);
  // True only on the first effect run when the server seeded this tag (SSR).
  // We then skip that one fetch; any later tagName change still refetches.
  const seededRef = useRef(hasInitial);

  useEffect(() => {
    if (seededRef.current) {
      seededRef.current = false;
      return;
    }
    let cancelled = false;
    setLoading(true);
    tagPosts(tagName)
      .then((res) => {
        if (cancelled) return;
        setItems(res.items);
        setTotal(res.total);
        setCursor(res.nextCursor);
      })
      .catch(() => {
        /* silent */
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [tagName]);

  const loadMore = useCallback(() => {
    if (!cursor || loadingMore) return;
    setLoadingMore(true);
    tagPosts(tagName, cursor)
      .then((res) => {
        setItems((prev) => [...prev, ...res.items]);
        setCursor(res.nextCursor);
      })
      .catch(() => {
        /* silent */
      })
      .finally(() => setLoadingMore(false));
  }, [tagName, cursor, loadingMore]);

  // In the overlay, open the reader in place; on the standalone page navigate.
  const openReader = useCallback(
    (p: Post) => {
      if (!p.dTag) return;
      if (inOverlay) openNative(p.dTag, { postId: p.id });
      else router.push(`/article/${p.dTag}`);
    },
    [inOverlay, openNative, router],
  );

  const replyFromPost = useCallback((p: Post) => {
    if (!p.author.pubkey) return;
    useCompose.getState().open("reply", {
      eventId: p.version ?? p.id,
      eventKind: p.type === "article" ? 30023 : 1,
      authorPubkey: p.author.pubkey,
      previewContent: quotePreviewContent(p),
    });
  }, []);

  return (
    <div className="mx-auto max-w-feed px-4 sm:px-6 py-12">
      <h1 className="font-mono text-2xl uppercase tracking-[0.02em] text-black">
        #{tagName}
      </h1>
      <p className="label-ui text-grey-600 mt-1 mb-10">
        {total} article{total !== 1 ? "s" : ""}
      </p>

      {loading ? (
        <div className="space-y-3">
          {[1, 2, 3].map((i) => (
            <div key={i} className="h-20 animate-pulse bg-white" />
          ))}
        </div>
      ) : items.length === 0 ? (
        <div className="py-20 text-center">
          <p className="text-ui-sm text-grey-600">
            #{tagName} — No articles yet.
          </p>
        </div>
      ) : (
        // The feed's own rhythm — `FEED_LOG_STYLE`'s column gap PLUS each
        // PostCard's `GAP_PX.feed` margin = 20px, which is what a vessel
        // renders (PROFILE-PANE-REDESIGN-ADR §9.2). This log spent a while at
        // 8px on a comment asserting 8px WAS the feed's gap; it is the card
        // margin measured without the column it lives in.
        <div style={FEED_LOG_STYLE}>
          {items.map((post) => (
            <PostCardInteractive
              key={post.id}
              post={post}
              level="feed"
              ctx={CTX}
              onOpenReader={openReader}
              onReply={
                post.author.pubkey ? () => replyFromPost(post) : undefined
              }
            />
          ))}

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
        </div>
      )}
    </div>
  );
}
