import { request } from './client'

export interface Conversation {
  id: string
  lastMessage: { content: string; senderUsername: string; createdAt: string } | null
  unreadCount: number
  members: { id: string; username: string; displayName: string | null; avatar: string | null }[]
}

export interface ReplyTo {
  id: string
  senderUsername: string | null
  contentEnc: string | null
  counterpartyPubkey: string | null
}

export interface DirectMessage {
  id: string
  conversationId: string
  senderId: string
  senderUsername: string
  senderDisplayName: string | null
  counterpartyPubkey: string
  contentEnc: string
  replyTo: ReplyTo | null
  readAt: string | null
  createdAt: string
  likeCount: number
  likedByMe: boolean
}

export interface DecryptedMessage extends DirectMessage {
  content: string | null
  replyToContent: string | null
}

export const messages = {
  listConversations: () =>
    request<{ conversations: Conversation[] }>('/messages'),

  getMessages: (conversationId: string, before?: string) =>
    request<{ messages: DirectMessage[]; nextCursor: string | null }>(
      `/messages/${conversationId}${before ? `?before=${before}` : ''}`
    ),

  send: (conversationId: string, content: string, replyToId?: string) =>
    request<{ messageIds: string[]; skippedRecipientIds: string[] }>(`/messages/${conversationId}`, {
      method: 'POST',
      body: JSON.stringify({ content, ...(replyToId && { replyToId }) }),
    }),

  markRead: (messageId: string) =>
    request<void>(`/messages/${messageId}/read`, { method: 'POST' }),

  markAllRead: (conversationId: string) =>
    request<{ ok: boolean; markedRead: number }>(`/messages/${conversationId}/read-all`, { method: 'POST' }),

  toggleLike: (messageId: string) =>
    request<{ liked: boolean }>(`/messages/${messageId}/like`, { method: 'POST' }),

  createConversation: (memberIds: string[]) =>
    request<{ conversationId: string }>('/conversations', {
      method: 'POST',
      body: JSON.stringify({ memberIds }),
    }),

  decryptBatch: (msgs: { id: string; counterpartyPubkey: string; ciphertext: string }[]) =>
    request<{ results: { id: string; plaintext: string | null; error?: string }[] }>('/dm/decrypt-batch', {
      method: 'POST',
      body: JSON.stringify({ messages: msgs }),
    }),
}

// =============================================================================
// DM Pricing
// =============================================================================

export interface DmPricingOverride {
  userId: string
  username: string
  displayName: string | null
  pricePence: number
}

export const dmPricing = {
  get: () =>
    request<{ defaultPricePence: number; overrides: DmPricingOverride[] }>('/settings/dm-pricing'),

  update: (defaultPricePence: number) =>
    request<{ ok: boolean }>('/settings/dm-pricing', {
      method: 'PUT',
      body: JSON.stringify({ defaultPricePence }),
    }),

  setOverride: (userId: string, pricePence: number) =>
    request<{ ok: boolean }>(`/settings/dm-pricing/override/${userId}`, {
      method: 'PUT',
      body: JSON.stringify({ pricePence }),
    }),

  removeOverride: (userId: string) =>
    request<{ ok: boolean }>(`/settings/dm-pricing/override/${userId}`, {
      method: 'DELETE',
    }),
}
