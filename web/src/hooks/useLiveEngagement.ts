"use client";

import { useEffect, useState, useRef } from "react";
import { externalItems } from "../lib/api/feeds";

interface Snapshot {
  likeCount: number;
  replyCount: number;
  repostCount: number;
}

interface LiveEngagement extends Snapshot {
  loading: boolean;
}

// Module-level cache: itemId → { counts, expiresAt }
const cache = new Map<string, { counts: Snapshot; expiresAt: number }>();
const CACHE_TTL_MS = 30_000;

export function useLiveEngagement(
  itemId: string,
  expanded: boolean,
  snapshot: Snapshot,
): LiveEngagement {
  const [counts, setCounts] = useState<Snapshot>(snapshot);
  const [loading, setLoading] = useState(false);
  const fetched = useRef(false);

  useEffect(() => {
    if (!expanded || fetched.current) return;

    const cached = cache.get(itemId);
    if (cached && cached.expiresAt > Date.now()) {
      setCounts(cached.counts);
      return;
    }

    fetched.current = true;
    setLoading(true);

    externalItems
      .engagement(itemId)
      .then((res) => {
        const live: Snapshot = {
          likeCount: res.likeCount,
          replyCount: res.replyCount,
          repostCount: res.repostCount,
        };
        cache.set(itemId, {
          counts: live,
          expiresAt: Date.now() + CACHE_TTL_MS,
        });
        setCounts(live);
      })
      .catch(() => {
        setCounts(snapshot);
        fetched.current = false;
      })
      .finally(() => setLoading(false));
  }, [expanded, itemId]);

  // Keep snapshot in sync if props change while not expanded
  useEffect(() => {
    if (!fetched.current) {
      setCounts(snapshot);
    }
  }, [snapshot.likeCount, snapshot.replyCount, snapshot.repostCount]);

  return { ...counts, loading };
}
