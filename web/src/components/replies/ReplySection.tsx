'use client'

import { useState, useEffect, useCallback, useMemo } from 'react'
import { useAuth } from '../../stores/auth'
import { ReplyComposer } from './ReplyComposer'
import { PlayscriptThread } from './PlayscriptThread'
import type { ReplyData, PlayscriptEntry } from './types'
import { replies as repliesApi, votes as votesApi, type VoteTally, type MyVoteCount } from '../../lib/api'

interface ReplySectionProps {
  targetEventId: string
  targetKind: number
  targetAuthorPubkey: string
  contentAuthorId?: string
  compact?: boolean
  dark?: boolean  // kept for API compat
  previewLimit?: number
  composerOpen?: boolean
  onComposerClose?: () => void
  onReplyCountLoaded?: (count: number) => void
  isUnlocked?: boolean
  // Slice 13: when an external publish path inserts a reply (e.g. the
  // workspace's overlay Composer), bumping this triggers a refetch so the
  // inline thread stays consistent with the canonical store.
  refreshKey?: number
}

export function ReplySection({
  targetEventId,
  targetKind,
  targetAuthorPubkey,
  contentAuthorId,
  compact = false,
  previewLimit,
  composerOpen,
  onComposerClose,
  onReplyCountLoaded,
  isUnlocked,
  refreshKey,
}: ReplySectionProps) {
  const { user } = useAuth()
  const [replies, setReplies] = useState<ReplyData[]>([])
  const [totalCount, setTotalCount] = useState(0)
  const [repliesEnabled, setRepliesEnabled] = useState(true)
  const [paywallLocked, setPaywallLocked] = useState(false)
  const [loading, setLoading] = useState(true)
  const [voteTallies, setVoteTallies] = useState<Record<string, VoteTally>>({})
  const [myVoteCounts, setMyVoteCounts] = useState<Record<string, MyVoteCount>>({})
  const [replyTarget, setReplyTarget] = useState<{
    replyId: string
    replyEventId: string
    authorName: string
  } | null>(null)

  useEffect(() => {
    async function loadReplies() {
      setLoading(true)
      try {
        const data = await repliesApi.getForTarget(targetEventId)
        if (data.paywallLocked) {
          setPaywallLocked(true)
          setReplies([])
          setTotalCount(0)
          setRepliesEnabled(data.repliesEnabled ?? true)
          onReplyCountLoaded?.(0)
          return
        }
        setPaywallLocked(false)
        const comments: ReplyData[] = data.comments ?? []
        setReplies(comments)
        const count = data.totalCount ?? 0
        setTotalCount(count)
        setRepliesEnabled(data.repliesEnabled ?? data.commentsEnabled ?? true)
        onReplyCountLoaded?.(count)

        const allEventIds = flattenEventIds(comments)
        if (allEventIds.length > 0) {
          const [talliesRes, myVotesRes] = await Promise.all([
            votesApi.getTallies(allEventIds).catch(() => ({ tallies: {} })),
            user
              ? votesApi.getMyVotes(allEventIds).catch(() => ({ voteCounts: {} }))
              : Promise.resolve({ voteCounts: {} as Record<string, MyVoteCount> }),
          ])
          setVoteTallies(talliesRes.tallies ?? {})
          setMyVoteCounts(myVotesRes.voteCounts ?? {})
        }
      } catch (err) {
        console.error('Failed to load replies:', err)
      } finally {
        setLoading(false)
      }
    }

    void loadReplies()
  }, [targetEventId, isUnlocked, refreshKey])

  const handleNewReply = useCallback((reply: ReplyData) => {
    setReplies(prev => [...prev, reply])
    setTotalCount(prev => prev + 1)
  }, [])

  const handleNewNestedReply = useCallback((reply: ReplyData) => {
    setReplies(prev => appendNested(prev, reply))
    setTotalCount(prev => prev + 1)
    setReplyTarget(null)
  }, [])

  const handleDelete = useCallback(async (replyId: string) => {
    try {
      await repliesApi.deleteReply(replyId)
      setReplies(prev => markDeleted(prev, replyId))
      setTotalCount(prev => prev - 1)
    } catch (err) {
      console.error('Failed to delete reply:', err)
    }
  }, [])

  const handleReplyTo = useCallback((replyId: string, replyEventId: string, authorName: string) => {
    setReplyTarget({ replyId, replyEventId, authorName })
  }, [])

  const entries = useMemo(() => flattenToPlayscript(replies), [replies])
  const visibleEntries = useMemo(() => {
    if (!previewLimit || entries.length <= previewLimit) return entries
    return entries.slice(-previewLimit)
  }, [entries, previewLimit])

  if (loading) {
    return (
      <div className={compact ? '' : 'mt-8 pt-6 border-t border-grey-200'}>
        <div className="ml-8 space-y-[32px] py-2">
          {[1, 2].map(i => (
            <div key={i} className="h-10 animate-pulse bg-grey-100" />
          ))}
        </div>
      </div>
    )
  }

  if (paywallLocked) {
    return (
      <div className={compact ? '' : 'mt-8 pt-6 border-t border-grey-200'}>
        <p className="text-xs text-grey-300 italic mb-4">
          Unlock the article to read and leave replies.
        </p>
      </div>
    )
  }

  const targetForComposer =
    replyTarget && replies.some(r => containsReply(r, replyTarget.replyId))
      ? replyTarget
      : null

  return (
    <div className={compact ? '' : 'mt-8 pt-6 border-t border-grey-200'}>
      {!compact && (
        <h3 className="label-ui text-grey-600 mb-6">
          {totalCount > 0
            ? `${totalCount} ${totalCount !== 1 ? 'replies' : 'reply'}`
            : 'Replies'}
        </h3>
      )}

      {entries.length > 0 && (
        <div className={compact ? '' : 'mb-6'}>
          <PlayscriptThread
            entries={visibleEntries}
            currentUserId={user?.id}
            contentAuthorId={contentAuthorId}
            repliesEnabled={repliesEnabled}
            activeReplyId={targetForComposer?.replyId ?? null}
            voteTallies={voteTallies}
            myVoteCounts={myVoteCounts}
            onReply={repliesEnabled ? handleReplyTo : undefined}
            onDelete={handleDelete}
            renderComposer={(replyId) =>
              targetForComposer && targetForComposer.replyId === replyId ? (
                <ReplyComposer
                  targetEventId={targetEventId}
                  targetKind={targetKind}
                  targetAuthorPubkey={targetAuthorPubkey}
                  parentCommentId={replyId}
                  parentCommentEventId={targetForComposer.replyEventId}
                  replyingToName={targetForComposer.authorName}
                  onPublished={handleNewNestedReply}
                  onCancel={() => setReplyTarget(null)}
                />
              ) : null
            }
          />
        </div>
      )}

      {(composerOpen === undefined || composerOpen) && (
        repliesEnabled && user ? (
          <ReplyComposer
            targetEventId={targetEventId}
            targetKind={targetKind}
            targetAuthorPubkey={targetAuthorPubkey}
            onPublished={(reply) => { handleNewReply(reply); onComposerClose?.() }}
          />
        ) : !repliesEnabled ? (
          <p className="text-xs text-grey-300 italic mb-4">
            The author has closed replies on this piece.
          </p>
        ) : (
          <p className="text-xs text-grey-300 mb-4">
            <a href="/auth?mode=login" className="text-crimson hover:text-crimson-dark">
              Log in
            </a>{' '}
            to leave a reply.
          </p>
        )
      )}
    </div>
  )
}

// ---------------------------------------------------------------------------
// Tree helpers
// ---------------------------------------------------------------------------

/**
 * Walk the nested reply tree and produce a flat chronological list. Each entry
 * carries an optional replyingTo hint, which we set only when the parent is
 * NOT the immediately-previous chronological entry — in that case the → arrow
 * in the speaker line disambiguates a non-adjacent parent.
 */
function flattenToPlayscript(tree: ReplyData[]): PlayscriptEntry[] {
  const flat: ReplyData[] = []
  const walk = (nodes: ReplyData[]) => {
    for (const n of nodes) {
      flat.push(n)
      if (n.replies.length > 0) walk(n.replies)
    }
  }
  walk(tree)

  flat.sort((a, b) => {
    const t = new Date(a.publishedAt).getTime() - new Date(b.publishedAt).getTime()
    return t !== 0 ? t : a.id.localeCompare(b.id)
  })

  const byId = new Map(flat.map(r => [r.id, r]))

  return flat.map((reply, i) => {
    if (!reply.parentCommentId) return { reply, replyingTo: null }
    const prev = i > 0 ? flat[i - 1] : null
    if (prev && prev.id === reply.parentCommentId) {
      return { reply, replyingTo: null }
    }
    const parent = byId.get(reply.parentCommentId)
    if (!parent) return { reply, replyingTo: null }
    const name = parent.author.displayName ?? parent.author.username ?? 'Anonymous'
    return { reply, replyingTo: { name, id: parent.id } }
  })
}

function appendNested(tree: ReplyData[], reply: ReplyData): ReplyData[] {
  return tree.map(node => {
    if (node.id === reply.parentCommentId) {
      return { ...node, replies: [...node.replies, reply] }
    }
    if (node.replies.length === 0) return node
    return { ...node, replies: appendNested(node.replies, reply) }
  })
}

function containsReply(node: ReplyData, id: string): boolean {
  if (node.id === id) return true
  return node.replies.some(c => containsReply(c, id))
}

function markDeleted(tree: ReplyData[], id: string): ReplyData[] {
  return tree.map(r => {
    if (r.id === id) {
      return { ...r, content: '[content deleted]', isDeleted: true }
    }
    return { ...r, replies: markDeleted(r.replies, id) }
  })
}

function flattenEventIds(tree: ReplyData[]): string[] {
  const ids: string[] = []
  for (const r of tree) {
    if (r.nostrEventId) ids.push(r.nostrEventId)
    if (r.replies.length > 0) ids.push(...flattenEventIds(r.replies))
  }
  return ids
}
