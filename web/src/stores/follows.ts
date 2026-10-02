import { useEffect } from 'react'
import { create } from 'zustand'
import { follows as followsApi } from '../lib/api'
import { invalidateAuthorCardCache } from '../hooks/useAuthorCard'

// =============================================================================
// Follows Store — single source of truth for NATIVE global follow state.
//
// "Follow a native writer" is the /follows graph, keyed by writer (account) id.
// Previously every surface (profile, author modal, network tab, writer header)
// seeded its own copy of isFollowing and never heard about a toggle elsewhere,
// so a follow on one surface left the others stale. This store centralises the
// followed-id set so a toggle anywhere live-updates every mounted surface.
//
// Scope: native follows only. External "follows" are feed-derived (a source in
// one of your feeds) and per-feed, so they stay with the feed/workspace data;
// the author-card cache bust below keeps their hover state fresh.
//
// State is authoritative once `hydrated` (full list from GET /follows). Before
// that, `prime()` lets a surface seed a known server snapshot so the label is
// correct on first paint without waiting for the round-trip.
// =============================================================================

interface FollowsState {
  ids: Set<string>
  hydrated: boolean
  hydrating: boolean

  hydrate: () => Promise<void>
  // No `follow`. A native follow is made by putting somebody in a feed, so the
  // INSERT belongs to `POST /workspace/feeds/:id/sources` and to nothing else
  // (§9.16 as amended 2026-09-18) — a client-side follow writer is how the
  // graph-only row this store used to produce came to exist. Surfaces report
  // what the route did with `setLocal`.
  unfollow: (id: string) => Promise<void>
  /** Reflect a follow the SERVER made or dropped as part of a feed-source
   *  write. Local only — it issues no request and is not a writer; it is the
   *  set catching up with a fact that is already true. */
  setLocal: (id: string, following: boolean) => void
  // Seed a known follow state from a per-surface server snapshot. No-op once
  // hydrated — the authoritative full list wins, so a stale snapshot rendered
  // before a toggle elsewhere can never clobber the live set.
  prime: (id: string, following: boolean) => void
  reset: () => void
}

export const useFollows = create<FollowsState>((set, get) => ({
  ids: new Set(),
  hydrated: false,
  hydrating: false,

  hydrate: async () => {
    if (get().hydrated || get().hydrating) return
    set({ hydrating: true })
    try {
      const { writers } = await followsApi.list()
      set({ ids: new Set(writers.map((w) => w.id)), hydrated: true, hydrating: false })
    } catch {
      // Logged out / network error — settle as an empty authoritative set so
      // buttons stop showing a phantom "loading" state. A later reset re-opens
      // hydration (e.g. after login).
      set({ hydrated: true, hydrating: false })
    }
  },

  // DELETE /follows is idempotent, so this is an unconditional toggle — never
  // gated on current store membership (which may be unhydrated). The set
  // update is optimistic and reverts on error. It survives the move of the
  // INSERT to the feed-source route because it is the LEGACY EXIT: a
  // pre-convergence follow has no source to remove, so there is nothing for
  // `removeSource` to drop, and `unfollowEverywhere` ends here.
  unfollow: async (id) => {
    set((s) => {
      const ids = new Set(s.ids)
      ids.delete(id)
      return { ids }
    })
    try {
      await followsApi.unfollow(id)
      invalidateAuthorCardCache()
    } catch (e) {
      set((s) => {
        const ids = new Set(s.ids)
        ids.add(id)
        return { ids }
      })
      throw e
    }
  },

  setLocal: (id, following) =>
    set((s) => {
      if (s.ids.has(id) === following) return s
      const ids = new Set(s.ids)
      if (following) ids.add(id)
      else ids.delete(id)
      return { ids }
    }),

  prime: (id, following) =>
    set((s) => {
      if (s.hydrated || s.ids.has(id) === following) return s
      const ids = new Set(s.ids)
      if (following) ids.add(id)
      else ids.delete(id)
      return { ids }
    }),

  reset: () => set({ ids: new Set(), hydrated: false, hydrating: false }),
}))

// -----------------------------------------------------------------------------
// useFollowState — the consumer hook every native follow surface reads.
//
// Triggers a one-time global hydrate, seeds the store with the caller's known
// server snapshot (pre-hydration only), and returns the live boolean. Because
// it reads the shared set, a toggle on any surface re-renders all of them.
// -----------------------------------------------------------------------------
export function useFollowState(writerId: string, knownFollowing?: boolean): boolean {
  const following = useFollows((s) => s.ids.has(writerId))
  useEffect(() => {
    if (knownFollowing !== undefined) useFollows.getState().prime(writerId, knownFollowing)
    void useFollows.getState().hydrate()
  }, [writerId, knownFollowing])
  return following
}
