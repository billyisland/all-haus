"use client";

import { useState, useEffect, useCallback, useMemo } from "react";
import { useRouter } from "next/navigation";
import { PostCardInteractive } from "../post/PostCardInteractive";
import { PostThread } from "../post/PostThread";
import { FEED_LOG_STYLE } from "./ProfileChrome";
import { LoadFailed } from "../ui/LoadFailed";
import type { CardContext } from "../post/chassis";
import {
  DEFAULT_DENSITY,
  DEFAULT_TEXT_SIZE,
  TEXT_SIZE_PX,
  type VesselPalette,
} from "../workspace/tokens";
import { authorPosts, authorReplies } from "../../lib/api/post";
import type { Post } from "../../lib/post/types";
import { openPostInReader } from "../../lib/workspace/open-post";
import type { WriterProfile } from "../../lib/api";

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
  /** THE CONVERSATION THIS PANE WAS OPENED ON — pinned above the log, already
   *  expanded, and taken out of the log below so it is not on screen twice.
   *
   *  It is pinned rather than scrolled to, and that is the whole reason this is
   *  not three lines seeding `expanded`: the log is one page of 50, the post a
   *  notification points at can be older than that, and a feature that works
   *  only while the thing is recent is the kind that looks fine in dev. Pinning
   *  addresses the conversation directly (`GET /thread/:postId`), so it does
   *  not matter whether the post is in the page, and it is what puts the
   *  message at the TOP rather than wherever its date happens to place it. */
  focusPostId?: string | null;
}

export function SocialLog({
  kind,
  writer,
  isOwnProfile,
  palette,
  focusPostId = null,
}: SocialLogProps) {
  const router = useRouter();
  const [posts, setPosts] = useState<Post[]>([]);
  const [failed, setFailed] = useState(false);
  const [loading, setLoading] = useState(true);
  const [expanded, setExpanded] = useState<Set<string>>(new Set());
  // Collapsing the pinned conversation RELEASES it rather than hiding it: the
  // post rejoins the log in its own place, which is where the reader would
  // next look for it. A pin that collapses to nothing would make the post
  // vanish from a profile that has it.
  const [pinned, setPinned] = useState<string | null>(focusPostId);
  useEffect(() => setPinned(focusPostId), [focusPostId]);
  // Memoised on the palette and named in `renderPost`'s deps (CA-E13f): a
  // context built per render and left out of the deps froze the colours the
  // pane opened with, so a palette change while it was mounted never reached
  // the cards.
  const CTX: CardContext = useMemo(
    () => ({
      density: DEFAULT_DENSITY,
      palette,
      bodyPx: TEXT_SIZE_PX[DEFAULT_TEXT_SIZE],
    }),
    [palette],
  );

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
        if (cancelled) return;
        setPosts(res.items);
        setFailed(false);
      })
      .catch(() => {
        // An outage is not an empty log. Swallowed, this printed "No posts
        // yet." / "No replies yet." over a member who may have written a great
        // deal — a confident claim about somebody else's work, made by a
        // surface that had been told nothing.
        if (!cancelled) setFailed(true);
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

  // Reader pane inside the workspace, standalone route outside it — one home,
  // because a bare push from an overlay body is the escape ban (lib/workspace/
  // open-post.ts, which also gates the external target on a real origin URL).
  const openReader = useCallback(
    (p: Post) => openPostInReader(p, router),
    [router],
  );

  const renderPost = useCallback(
    (post: Post) =>
      expanded.has(post.id) && post.type !== "article" ? (
        <PostThread
          key={post.id}
          rootPostId={post.id}
          ctx={CTX}
          onCollapse={() => toggleExpand(post.id)}
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
        />
      ),
    [expanded, isOwnProfile, openReader, toggleExpand, CTX],
  );

  if (loading) {
    return (
      <div
        className="py-10 text-center text-ui-sm"
        style={{ color: palette.cardMeta }}
      >
        Loading…
      </div>
    );
  }

  if (failed) {
    return (
      <LoadFailed
        what={kind === "notes" ? "these posts" : "these replies"}
        color={palette.cardMeta}
      />
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
  return (
    <div style={FEED_LOG_STYLE}>
      {pinned && (
        <PostThread
          key={`pinned-${pinned}`}
          rootPostId={pinned}
          ctx={CTX}
          // It is the head of the log already — see `autoScroll`'s own note.
          autoScroll={false}
          onCollapse={() => setPinned(null)}
          onOpenReader={openReader}
        />
      )}
      {posts.filter((p) => p.id !== pinned).map(renderPost)}
    </div>
  );
}
