import { signPublishAndIndex } from './signPublishAndIndex'
import { useThreadRefresh } from '../stores/threadRefresh'

// =============================================================================
// Reply Publishing Service
//
// Publishes a reply as a Nostr kind 1 event via the gateway, then indexes.
// =============================================================================

// The gateway's own bound on a reply (`gateway/src/routes/replies.ts::
// REPLY_CHAR_LIMIT`), and the ONE copy on this side: both reply composers
// import it. There is no module path between the workspaces, so the number is
// pinned by reading that file — `web/tests/reply-limit-parity.test.ts`, which
// also refuses a second declaration anywhere under `web/src`.
export const REPLY_CHAR_LIMIT = 2000

interface PublishReplyParams {
  content: string
  targetEventId: string
  targetKind: number
  targetAuthorPubkey: string
  parentCommentId?: string
  parentCommentEventId?: string
}

interface PublishReplyResult {
  replyEventId: string
  replyId: string
}

export async function publishReply(params: PublishReplyParams): Promise<PublishReplyResult> {
  const tags: string[][] = [
    ['e', params.targetEventId, '', 'root'],
    ['p', params.targetAuthorPubkey],
  ]

  if (params.parentCommentEventId) {
    tags.push(['e', params.parentCommentEventId, '', 'reply'])
  }

  const result = await signPublishAndIndex({
    content: params.content,
    tags,
    indexEndpoint: '/replies',
    indexBody: (eventId) => ({
      nostrEventId: eventId,
      targetEventId: params.targetEventId,
      targetKind: params.targetKind,
      parentCommentId: params.parentCommentId ?? null,
      content: params.content,
    }),
  })

  // The conversation this reply joined refetches, in place, wherever it is
  // mounted; every cached thread is dropped. One place, because this is the
  // one path a reply takes from any compose surface — see
  // `stores/threadRefresh.ts` for what a per-surface callback cost, and for
  // why the tick carries a target rather than resetting every thread on the
  // page.
  //
  // `parentCommentEventId` when the reply is to a comment, else the root: the
  // target is the post whose descendants just changed.
  useThreadRefresh
    .getState()
    .bump(params.parentCommentEventId ?? params.targetEventId)

  return {
    replyEventId: result.eventId,
    replyId: result.indexData.commentId as string ?? result.indexData.id as string ?? '',
  }
}
