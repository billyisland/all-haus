import { request } from './client'

export interface BlockedUser {
  userId: string
  username: string
  displayName: string | null
  avatar: string | null
  blockedAt: string
}

export interface MutedUser {
  userId: string
  username: string
  displayName: string | null
  avatar: string | null
  mutedAt: string
}

/** What the VIEWER has done to one account — never the block the other party
 *  set (gateway `lib/blocks.ts`, `viewerRelation`). */
export interface ViewerRelation {
  muted: boolean
  blocked: boolean
}

/** What a block ended, as the route reports it: follows both ways, and any
 *  subscription between the pair, which runs to its period end. */
export interface BlockResult {
  ok: boolean
  followsDropped: number
  subscriptionsEnding: { subscriptionId: string; accessUntil: string }[]
}

export const social = {
  listBlocks: () =>
    request<{ blocks: BlockedUser[] }>('/my/blocks'),

  block: (userId: string) =>
    request<BlockResult>(`/my/blocks/${userId}`, { method: 'POST' }),

  unblock: (userId: string) =>
    request<{ ok: boolean }>(`/my/blocks/${userId}`, { method: 'DELETE' }),

  listMutes: () =>
    request<{ mutes: MutedUser[] }>('/my/mutes'),

  mute: (userId: string) =>
    request<{ ok: boolean }>(`/my/mutes/${userId}`, { method: 'POST' }),

  unmute: (userId: string) =>
    request<{ ok: boolean }>(`/my/mutes/${userId}`, { method: 'DELETE' }),

  relation: (userId: string) =>
    request<ViewerRelation>(`/my/relations/${userId}`),
}
