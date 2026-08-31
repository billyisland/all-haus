import type { PipStatus } from '../../lib/ndk'

export interface ReplyData {
  id: string
  nostrEventId: string
  author: {
    id: string
    username: string | null
    displayName: string | null
    avatar: string | null
    pipStatus: PipStatus
  }
  parentCommentId: string | null
  content: string
  publishedAt: string
  isDeleted: boolean
  isMuted: boolean
  replies: ReplyData[]
}

export interface PlayscriptEntry {
  reply: ReplyData
  replyingTo: { name: string; id: string } | null
}
