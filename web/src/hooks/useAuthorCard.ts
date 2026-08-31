"use client";

import { useState, useEffect, useCallback } from "react";
import type { AuthorProfile } from "../lib/api/post";

// One author DTO across the codebase — the gateway AuthorCardResponse, defined
// canonically in lib/api/post.ts. Re-exported here so AuthorModal's existing
// import keeps working.
export type AuthorCardData = AuthorProfile;

// "native" / "external" hit the legacy item-keyed /author-card; "author" hits
// the Phase-4 /author/:id/profile keyed on the persistent author.id.
export type AuthorCardType = "native" | "external" | "author";

interface AuthorCardState {
  data: AuthorCardData | null;
  loading: boolean;
}

interface CacheEntry {
  data: AuthorCardData;
  expiresAt: number;
}

const CACHE_TTL_MS = 5 * 60_000;
const cache = new Map<string, CacheEntry>();
const inflight = new Map<string, Promise<AuthorCardData | null>>();

// Drop every cached profile. Called after a follow/unfollow so the next hover
// re-fetches the live follow state instead of re-asserting a stale snapshot.
// The cache only holds lightweight hover previews, so a full clear is cheap.
export function invalidateAuthorCardCache(): void {
  cache.clear();
}

async function fetchAuthorCard(
  type: AuthorCardType,
  id: string,
): Promise<AuthorCardData | null> {
  try {
    const url =
      type === "author"
        ? `/api/v1/author/${encodeURIComponent(id)}/profile`
        : `/api/v1/author-card?type=${type}&id=${encodeURIComponent(id)}`;
    const res = await fetch(url, { credentials: "include" });
    if (!res.ok) return null;
    return (await res.json()) as AuthorCardData;
  } catch {
    return null;
  }
}

export function useAuthorCard(
  type: AuthorCardType,
  id: string | null,
  enabled: boolean,
): AuthorCardState & { refresh: () => void } {
  const [state, setState] = useState<AuthorCardState>({
    data: null,
    loading: false,
  });

  useEffect(() => {
    if (!enabled || !id) return;

    const cacheKey = `${type}:${id}`;
    const cached = cache.get(cacheKey);
    if (cached && cached.expiresAt > Date.now()) {
      setState({ data: cached.data, loading: false });
      return;
    }

    // A cancellation guard (not a "have we fetched?" ref) is what makes this
    // correct when type/id change on a mounted hook: each run owns its own
    // `cancelled` flag, so a stale request's settle can't clobber the current
    // one, and a cache-missing id change always refetches. The inflight map
    // still dedupes concurrent identical requests (incl. StrictMode remounts).
    let cancelled = false;
    setState({ data: null, loading: true });

    let existing = inflight.get(cacheKey);
    if (!existing) {
      existing = fetchAuthorCard(type, id);
      inflight.set(cacheKey, existing);
      void existing.finally(() => inflight.delete(cacheKey));
    }

    void existing.then((data) => {
      if (data) {
        cache.set(cacheKey, { data, expiresAt: Date.now() + CACHE_TTL_MS });
      }
      if (cancelled) return;
      setState({ data, loading: false });
    });

    return () => {
      cancelled = true;
    };
  }, [type, id, enabled]);

  const refresh = useCallback(() => {
    if (!id) return;
    const cacheKey = `${type}:${id}`;
    cache.delete(cacheKey);
    setState({ data: null, loading: true });
    void fetchAuthorCard(type, id).then((data) => {
      if (data) {
        cache.set(cacheKey, { data, expiresAt: Date.now() + CACHE_TTL_MS });
      }
      setState({ data, loading: false });
    });
  }, [type, id]);

  return { ...state, refresh };
}
