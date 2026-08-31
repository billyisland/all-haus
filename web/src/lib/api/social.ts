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

export const social = {
  listBlocks: () =>
    request<{ blocks: BlockedUser[] }>('/my/blocks'),

  block: (userId: string) =>
    request<{ ok: boolean }>(`/my/blocks/${userId}`, { method: 'POST' }),

  unblock: (userId: string) =>
    request<{ ok: boolean }>(`/my/blocks/${userId}`, { method: 'DELETE' }),

  listMutes: () =>
    request<{ mutes: MutedUser[] }>('/my/mutes'),

  mute: (userId: string) =>
    request<{ ok: boolean }>(`/my/mutes/${userId}`, { method: 'POST' }),

  unmute: (userId: string) =>
    request<{ ok: boolean }>(`/my/mutes/${userId}`, { method: 'DELETE' }),
}
