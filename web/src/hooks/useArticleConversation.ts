"use client";

// =============================================================================
// useArticleConversation — the article foot's RESTING shape.
//
// The conversation under an article opens on its DIRECT replies (operator,
// 2026-09-27), ranked by how much conversation hangs off each, each with its
// first two replies as previews and a count — GET /thread/:postId/top. Opening
// any one of them is `PostThread` from that node, which reads the ordinary
// /thread; this hook only holds the rest state.
//
// THE RANK IS TAKEN ONCE, AT LOAD. A refresh (a reply published anywhere, a
// delete) updates the counts and previews of the replies already on screen IN
// THE ORDER THEY ARE IN, and appends anything new at the end — just above the
// composer it was most likely written in. Re-sorting under a reader who has
// just replied would move the card they were looking at.
//
// An ERRAND (a notification, a `#reply-<id>` address, the reader's own
// just-published reply) rides the fetch as `focusComment`: the server widens
// its first page through the reply that carries it, so nothing pages to find
// it, and says which reply that is (`focus`).
// =============================================================================

import { useCallback, useEffect, useRef, useState } from "react";
import {
  postThreadTop,
  type PostThreadTopResponse,
  type TopLevelEntry,
} from "../lib/api/post";
import type { Post } from "../lib/post/types";

// GET /thread/:postId/top's own ceiling (`post-thread.ts::MAX_REPLY_LIMIT`).
const MAX_TOP_LIMIT = 50;

export interface TopState {
  entries: TopLevelEntry[];
  posts: Map<string, Post>;
  nextOffset?: number;
  totalReplies: number;
}

export const EMPTY_TOP: TopState = { entries: [], posts: new Map(), totalReplies: 0 };

/** Fold a response into what is loaded. `page` appends a further page;
 *  `refresh` keeps the loaded order, updates what it names and appends what
 *  is new. Exported for the merge tests. */
export function mergeTop(
  prev: TopState,
  res: PostThreadTopResponse,
  mode: "page" | "refresh",
): TopState {
  const posts = new Map(prev.posts);
  for (const p of res.posts) posts.set(p.id, p);
  const fresh = new Map(res.topLevel.map((e) => [e.id, e]));
  const known = new Set(prev.entries.map((e) => e.id));
  const entries = [
    ...(mode === "refresh"
      ? prev.entries.map((e) => fresh.get(e.id) ?? e)
      : prev.entries),
    ...res.topLevel.filter((e) => !known.has(e.id)),
  ];
  return {
    entries,
    posts,
    // After a refresh the loaded list may have grown by an arrival, so the
    // next page starts after everything shown; a page carries its own.
    nextOffset:
      mode === "page" || res.nextOffset === undefined
        ? res.nextOffset
        : Math.max(prev.nextOffset ?? 0, entries.length),
    totalReplies: res.totalReplies,
  };
}

export function useArticleConversation(postId: string, pageSize: number) {
  const [state, setState] = useState<TopState>(EMPTY_TOP);
  const [loading, setLoading] = useState(true);
  const [loadingMore, setLoadingMore] = useState(false);
  const [error, setError] = useState(false);
  // The errand's answer, handed to the host once per fetch that carried one.
  const [focus, setFocus] = useState<PostThreadTopResponse["focus"]>(null);
  const stateRef = useRef(state);
  stateRef.current = state;
  // A newer fetch orphans an older one's settle (the reader pane keeps this
  // mounted across a skip, so `postId` changes under an in-flight load).
  const seq = useRef(0);
  // A further page is not orphaned by a refresh — only by a different article,
  // or by a `load()` that started the list again (CA-E13a): its page was cut
  // at an offset into the list `load()` threw away, and merged into the new
  // one it would duplicate or skip. `refresh()` MERGES, so it leaves this be.
  const postIdRef = useRef(postId);
  postIdRef.current = postId;
  const listGen = useRef(0);

  const load = useCallback(
    (focusComment: string | null) => {
      const mine = ++seq.current;
      listGen.current++;
      setState(EMPTY_TOP);
      setLoading(true);
      setError(false);
      setFocus(null);
      postThreadTop(postId, { limit: pageSize, focusComment })
        .then((res) => {
          if (mine !== seq.current) return;
          setState(mergeTop(EMPTY_TOP, res, "page"));
          setFocus(res.focus);
          setLoading(false);
        })
        .catch(() => {
          if (mine !== seq.current) return;
          setError(true);
          setLoading(false);
        });
    },
    [postId, pageSize],
  );

  const refresh = useCallback(
    (focusComment: string | null = null) => {
      const mine = ++seq.current;
      const loaded = stateRef.current.entries.length;
      postThreadTop(postId, {
        limit: Math.min(Math.max(loaded, pageSize), MAX_TOP_LIMIT),
        focusComment,
      })
        .then((res) => {
          if (mine !== seq.current) return;
          setState((prev) => mergeTop(prev, res, "refresh"));
          if (focusComment) setFocus(res.focus);
        })
        .catch(() => {
          // A failed refresh leaves the conversation exactly as it was.
        });
    },
    [postId, pageSize],
  );

  const loadMore = useCallback(() => {
    const offset = stateRef.current.nextOffset;
    if (offset === undefined || loadingMore) return;
    const pid = postId;
    const gen = listGen.current;
    setLoadingMore(true);
    postThreadTop(pid, { limit: pageSize, offset })
      .then((res) => {
        if (pid !== postIdRef.current || gen !== listGen.current) return;
        setState((prev) => mergeTop(prev, res, "page"));
      })
      .catch(() => {})
      .finally(() => setLoadingMore(false));
  }, [postId, pageSize, loadingMore]);

  // Nothing is fetched until the host says which errand, if any, to carry.
  useEffect(() => {
    return () => {
      seq.current++;
    };
  }, [postId]);

  return {
    ...state,
    loading,
    loadingMore,
    error,
    focus,
    clearFocus: () => setFocus(null),
    load,
    refresh,
    loadMore,
  };
}
