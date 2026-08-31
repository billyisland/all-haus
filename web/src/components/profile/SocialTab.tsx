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
// Profile Social tab — the writer's notes + replies, rendered through the one
// Post-model path (PostCardInteractive / PostThread), the same as the workspace
// and the constructed author profile. Notes come from GET /author/:id/posts?
// kind=note; replies (kind-1111 comments, which aren't feed_items) from
// GET /author/:id/replies. Each card expands inline to the unified thread
// (parent context above) instead of the old "→ replied to X" provenance line.
// =============================================================================

interface SocialTabProps {
  username: string;
  writer: WriterProfile;
  isOwnProfile: boolean;
  /** The profile surface's palette — resolved once at the top of the surface. */
  palette: VesselPalette;
}

export function SocialTab({ writer, isOwnProfile, palette }: SocialTabProps) {
  const router = useRouter();
  const [notes, setNotes] = useState<Post[]>([]);
  const [replies, setReplies] = useState<Post[]>([]);
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
    Promise.all([
      authorPosts(writer.id, undefined, "note", 50),
      authorReplies(writer.id, undefined, 50),
    ])
      .then(([notesRes, repliesRes]) => {
        if (cancelled) return;
        setNotes(notesRes.items);
        setReplies(repliesRes.items);
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
  }, [writer.id]);

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

  const hasNotes = notes.length > 0;
  const hasReplies = replies.length > 0;

  if (!hasNotes && !hasReplies) {
    return (
      <p className="text-ui-sm py-10" style={{ color: palette.cardMeta }}>
        No notes or replies yet.
      </p>
    );
  }

  // The feed's own rhythm: `FEED_LOG_STYLE`'s column gap PLUS each PostCard's
  // own margin = 20px, which is what a vessel renders (§9.2). The card margin
  // alone is 8px and was never the feed's figure.
  return (
    <div>
      {hasNotes && (
        <>
          <h3 className="label-ui mb-4" style={{ color: palette.cardMeta }}>
            Notes
          </h3>
          <div style={FEED_LOG_STYLE}>{notes.map(renderPost)}</div>
        </>
      )}

      {hasReplies && (
        <>
          {hasNotes && <div className="rule-inset my-8" />}
          <h3 className="label-ui mb-4" style={{ color: palette.cardMeta }}>
            Replies
          </h3>
          <div style={FEED_LOG_STYLE}>{replies.map(renderPost)}</div>
        </>
      )}
    </div>
  );
}
