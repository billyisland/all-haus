"use client";

import { useState, useEffect, useCallback } from "react";
import { useRouter } from "next/navigation";
import { PostCardInteractive } from "../post/PostCardInteractive";
import { PostThread } from "../post/PostThread";
import { FEED_LOG_STYLE } from "./ProfileChrome";
import type { CardContext } from "../post/chassis";
import {
  DEFAULT_DENSITY,
  DEFAULT_TEXT_SIZE,
  TEXT_SIZE_PX,
  type VesselPalette,
} from "../workspace/tokens";
import { authorPosts, authorReplies } from "../../lib/api/post";
import type { Post } from "../../lib/post/types";
import { quotePreviewContent } from "../../lib/post/quote-preview";
import type { WriterProfile } from "../../lib/api";
import { useCompose } from "../../stores/compose";

// =============================================================================
// SocialLog — ONE log body for the profile's Posts view and its Replies view,
// which are two POPULATIONS and not two components: everything below the fetch
// (thread expansion, the reply composer, the reader route, the feed rhythm) is
// identical, and the pair spent its previous life as one "Social" tab that
// stacked both under `Notes` / `Replies` headings.
//
// Those headings are gone with the tab rig that replaced them: the button that
// opened the view already names it, and a heading repeating the button is the
// same thing said twice — the exact fault that had Followers/Following living
// as counts AND as pills.
//
// Notes come from GET /author/:id/posts?kind=note; replies (kind-1111 comments,
// which aren't feed_items) from GET /author/:id/replies. Each card expands
// inline to the unified thread, parent context above.
// =============================================================================

export type SocialKind = "notes" | "replies";

interface SocialLogProps {
  kind: SocialKind;
  writer: WriterProfile;
  isOwnProfile: boolean;
  /** The profile surface's palette — resolved once at the top of the surface. */
  palette: VesselPalette;
}

export function SocialLog({
  kind,
  writer,
  isOwnProfile,
  palette,
}: SocialLogProps) {
  const router = useRouter();
  const [posts, setPosts] = useState<Post[]>([]);
  const [loading, setLoading] = useState(true);
  const [expanded, setExpanded] = useState<Set<string>>(new Set());
  const CTX: CardContext = {
    density: DEFAULT_DENSITY,
    palette,
    bodyPx: TEXT_SIZE_PX[DEFAULT_TEXT_SIZE],
  };

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setExpanded(new Set());
    const load =
      kind === "notes"
        ? authorPosts(writer.id, undefined, "note", 50)
        : authorReplies(writer.id, undefined, 50);
    load
      .then((res) => {
        if (!cancelled) setPosts(res.items);
      })
      .catch(() => {
        /* silently fail */
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [writer.id, kind]);

  const toggleExpand = useCallback((id: string) => {
    setExpanded((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }, []);

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

  const replyFromPost = useCallback((p: Post) => {
    if (!p.author.pubkey) return;
    useCompose.getState().open("reply", {
      eventId: p.version ?? p.id,
      eventKind: p.type === "article" ? 30023 : 1,
      authorPubkey: p.author.pubkey,
      previewContent: quotePreviewContent(p),
    });
  }, []);

  const renderPost = useCallback(
    (post: Post) =>
      expanded.has(post.id) && post.type !== "article" ? (
        <PostThread
          key={post.id}
          rootPostId={post.id}
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
          isOwnContent={isOwnProfile}
          onExpand={() => toggleExpand(post.id)}
          onOpenReader={openReader}
          onReply={post.author.pubkey ? () => replyFromPost(post) : undefined}
        />
      ),
    [expanded, isOwnProfile, openReader, replyFromPost, toggleExpand],
  );

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

  if (posts.length === 0) {
    return (
      <p className="text-ui-sm py-10" style={{ color: palette.cardMeta }}>
        {kind === "notes" ? "No posts yet." : "No replies yet."}
      </p>
    );
  }

  // The feed's own rhythm: `FEED_LOG_STYLE`'s column gap PLUS each PostCard's
  // own margin = 20px, which is what a vessel renders (§9.2). The card margin
  // alone is 8px and was never the feed's figure.
  return <div style={FEED_LOG_STYLE}>{posts.map(renderPost)}</div>;
}
