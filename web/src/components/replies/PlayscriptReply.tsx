'use client'

import { useState } from 'react'
import Link from 'next/link'
import { ProfileLink } from '../ui/ProfileLink'
import { ReportButton } from '../ui/ReportButton'
import { MediaContent } from '../ui/MediaContent'
import { VoteControls } from '../ui/VoteControls'
import { TrustPip } from '../ui/TrustPip'
import type { VoteTally, MyVoteCount } from '../../lib/api'
import type { PlayscriptEntry } from './types'

interface PlayscriptReplyProps {
  entry: PlayscriptEntry
  currentUserId?: string
  contentAuthorId?: string
  repliesEnabled: boolean
  onReply?: (replyId: string, replyEventId: string, authorName: string) => void
  onDelete?: (replyId: string) => void
  voteTally?: VoteTally
  myVoteCounts?: MyVoteCount
}

export function PlayscriptReply({
  entry,
  currentUserId,
  contentAuthorId,
  repliesEnabled,
  onReply,
  onDelete,
  voteTally,
  myVoteCounts,
}: PlayscriptReplyProps) {
  const { reply, replyingTo } = entry
  const [confirmDelete, setConfirmDelete] = useState(false)
  const [showActions, setShowActions] = useState(false)

  if (reply.isMuted && !reply.isDeleted) {
    return null
  }

  const isSelf = !!currentUserId && reply.author.id === currentUserId
  const authorName = reply.author.displayName ?? reply.author.username ?? 'Anonymous'
  const canDelete =
    !!currentUserId &&
    (reply.author.id === currentUserId || contentAuthorId === currentUserId)

  const handleDelete = () => {
    if (!confirmDelete) {
      setConfirmDelete(true)
      setTimeout(() => setConfirmDelete(false), 3000)
      return
    }
    onDelete?.(reply.id)
    setConfirmDelete(false)
  }

  const handleFocusShow = () => setShowActions(true)
  const handleBlurHide = (e: React.FocusEvent<HTMLDivElement>) => {
    if (!e.currentTarget.contains(e.relatedTarget as Node)) setShowActions(false)
  }

  return (
    <div
      id={`reply-${reply.id}`}
      className="group relative transition-colors"
      style={{ backgroundColor: showActions ? 'var(--ah-cream-hover)' : undefined }}
      onMouseEnter={() => setShowActions(true)}
      onMouseLeave={() => setShowActions(false)}
      onFocus={handleFocusShow}
      onBlur={handleBlurHide}
    >
      {/* Vote count, top-right, aligned to first line of dialogue */}
      {!reply.isDeleted && (
        <div className="absolute right-0 top-[18px]">
          <VoteControls
            targetEventId={reply.nostrEventId}
            targetKind={1111}
            isOwnContent={isSelf}
            initialTally={voteTally}
            initialMyVotes={myVoteCounts}
          />
        </div>
      )}

      {/* Speaker line */}
      <div
        className="label-ui text-grey-600 flex items-center gap-[6px] pr-20"
      >
        {replyingTo && (
          <>
            <span className="text-grey-400">→</span>
            <span className="font-sans font-bold text-grey-400">
              {replyingTo.name}
            </span>
            <span className="text-grey-400">:</span>
            <span aria-hidden="true" style={{ display: 'inline-block', width: '16px' }} />
          </>
        )}

        {!isSelf && <TrustPip status={reply.author.pipStatus} />}

        {isSelf ? (
          <span className="font-sans font-bold text-black">YOU:</span>
        ) : reply.author.username ? (
          <ProfileLink
            href={`/${reply.author.username}`}
            className="font-sans font-bold text-black hover:underline"
          >
            {authorName}:
          </ProfileLink>
        ) : (
          <span className="font-sans font-bold text-black">{authorName}:</span>
        )}
      </div>

      {/* Dialogue line */}
      <div className="mt-1 pr-20">
        {reply.isDeleted ? (
          <p className="font-sans text-[0.90625rem] leading-[1.55] text-grey-300 italic">
            {reply.content}
          </p>
        ) : (
          <MediaContent
            content={reply.content}
            variant="reply"
            textClassName="font-sans text-[0.90625rem] leading-[1.55] text-black whitespace-pre-wrap"
          />
        )}
      </div>

      {/* Action row — hover/focus reveal (conditional mount so layout collapses) */}
      {!reply.isDeleted && showActions && (
        <div
          className="mt-2 flex items-center gap-4 font-mono text-[11px] uppercase tracking-[0.02em] text-grey-400"
        >
          <time dateTime={reply.publishedAt}>
            {formatRelativeTime(reply.publishedAt)}
          </time>
          {currentUserId && onReply && repliesEnabled && (
            <button
              onClick={() =>
                onReply(reply.id, reply.nostrEventId, authorName)
              }
              className="hover:text-black transition-colors"
            >
              Reply
            </button>
          )}
          {canDelete && (
            <button
              onClick={handleDelete}
              className={`transition-colors ${
                confirmDelete ? 'text-crimson' : 'hover:text-crimson'
              }`}
            >
              {confirmDelete ? 'Confirm?' : 'Delete'}
            </button>
          )}
          <ReportButton targetNostrEventId={reply.nostrEventId} />
        </div>
      )}
    </div>
  )
}

function formatRelativeTime(isoString: string): string {
  const date = new Date(isoString)
  const now = new Date()
  const diffMs = now.getTime() - date.getTime()
  const diffMins = Math.floor(diffMs / (1000 * 60))
  const diffHours = Math.floor(diffMs / (1000 * 60 * 60))
  const diffDays = Math.floor(diffMs / (1000 * 60 * 60 * 24))

  if (diffMins < 1) return 'NOW'
  if (diffMins < 60) return `${diffMins}M`
  if (diffHours < 24) return `${diffHours}H`
  if (diffDays === 1) return '1D'
  if (diffDays < 7) return `${diffDays}D`

  return date
    .toLocaleDateString('en-GB', {
      day: 'numeric',
      month: 'short',
      year: date.getFullYear() !== now.getFullYear() ? 'numeric' : undefined,
    })
    .toUpperCase()
}
