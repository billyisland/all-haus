import { request } from './client'

// The legacy global `GET /feed?reach=` timeline + its `FeedReach` type were
// retired with the FeedView card stack (FEED-RETIREMENT Slice 7); the interim
// `reach:following` / `reach:explore` feed sources were themselves retired in
// migration 177 (§9.16 — Follow now writes concrete `account` sources).
// This module survives only for the replies API below.

// =============================================================================
// Replies
// =============================================================================

export interface ReplyResponse {
  comments: any[]
  totalCount: number
  repliesEnabled: boolean
  commentsEnabled: boolean // backwards-compat alias
  paywallLocked?: boolean
}

export const replies = {
  getForTarget: (targetEventId: string) =>
    request<ReplyResponse>(`/replies/${targetEventId}`),

  deleteReply: (replyId: string) =>
    request<{ ok: boolean }>(`/replies/${replyId}`, { method: 'DELETE' }),

  toggleArticleReplies: (articleId: string, enabled: boolean) =>
    request<{ ok: boolean }>(`/articles/${articleId}/replies`, {
      method: 'PATCH',
      body: JSON.stringify({ enabled }),
    }),

  toggleNoteReplies: (noteId: string, enabled: boolean) =>
    request<{ ok: boolean }>(`/notes/${noteId}/replies`, {
      method: 'PATCH',
      body: JSON.stringify({ enabled }),
    }),
}
