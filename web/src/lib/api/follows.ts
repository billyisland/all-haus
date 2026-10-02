import { request } from './client'

export interface FollowedWriter {
  id: string
  username: string
  displayName: string | null
  avatar: string | null
  pubkey: string | null
  followedAt: string
}

export const follows = {
  // PARKED with the pip panel (CA-I2): its follow state was the only reader,
  // and the workspace stopped fetching it when the panel was unmounted.
  listPubkeys: () =>
    request<{ pubkeys: string[] }>('/follows/pubkeys'),

  list: () =>
    request<{ writers: FollowedWriter[] }>('/follows'),

  // NO `follow`. A native follow is made by putting somebody in a feed, so the
  // INSERT is `POST /workspace/feeds/:id/sources`'s, in the same transaction
  // as the source (§9.16 as amended 2026-09-18). The gateway route still
  // exists and still carries its both-ways block guard; nothing in the browser
  // may reach it, because a client that can make a follow is a client that can
  // make one with no feed behind it — which is the whole defect. Pinned by
  // `web/tests/follow-feed-frontier.test.ts`.
  //
  // `unfollow` stays: it is the LEGACY EXIT for a pre-convergence follow with
  // no source for the route to drop.
  unfollow: (writerId: string) =>
    request<{ ok: boolean }>(`/follows/${writerId}`, { method: 'DELETE' }),
}
