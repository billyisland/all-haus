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
  listPubkeys: () =>
    request<{ pubkeys: string[] }>('/follows/pubkeys'),

  list: () =>
    request<{ writers: FollowedWriter[] }>('/follows'),

  follow: (writerId: string) =>
    request<{ ok: boolean }>(`/follows/${writerId}`, {
      method: 'POST',
      body: JSON.stringify({}),
    }),

  unfollow: (writerId: string) =>
    request<{ ok: boolean }>(`/follows/${writerId}`, { method: 'DELETE' }),
}
