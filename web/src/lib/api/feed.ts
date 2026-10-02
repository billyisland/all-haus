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
  // GET /replies's OWN flag, and the only one left with this name. It is live:
  // ReplySection sets it and returns null on it, which is how the ARTICLE PAGE
  // withholds a locked piece's comments — a decision the operator reaffirmed on
  // 2026-09-05 (ARTICLE-HEADED-CONVERSATIONS-ADR §6).
  //
  // The identically-named flag on GET /thread/:postId was a DIFFERENT flag with
  // no reader, and it is deleted (D8): under D3 the thread projector returns the
  // whole conversation and marks each node `rootLocked` instead. Two flags
  // sharing one name is how the ADR's first draft came to record that this one
  // had no reader either — do not re-add a thread-level twin.
  paywallLocked?: boolean
}

export const replies = {
  getForTarget: (targetEventId: string) =>
    request<ReplyResponse>(`/replies/${targetEventId}`),

  deleteReply: (replyId: string) =>
    request<{ ok: boolean }>(`/replies/${replyId}`, { method: 'DELETE' }),
}
