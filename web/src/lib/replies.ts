import { signPublishAndIndex } from './signPublishAndIndex'

// =============================================================================
// Reply Publishing Service
//
// Publishes a reply as a Nostr kind 1 event via the gateway, then indexes.
// =============================================================================

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
    indexEndpoint: '/api/v1/replies',
    indexBody: (eventId) => ({
      nostrEventId: eventId,
      targetEventId: params.targetEventId,
      targetKind: params.targetKind,
      parentCommentId: params.parentCommentId ?? null,
      content: params.content,
    }),
  })

  return {
    replyEventId: result.eventId,
    replyId: result.indexData.commentId as string ?? result.indexData.id as string ?? '',
  }
}
