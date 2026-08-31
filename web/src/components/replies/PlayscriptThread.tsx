'use client'

import { useState, type ReactNode } from 'react'
import { PlayscriptReply } from './PlayscriptReply'
import type { PlayscriptEntry } from './types'
import type { VoteTally, MyVoteCount } from '../../lib/api'

const INITIAL_VISIBLE = 10

interface PlayscriptThreadProps {
  entries: PlayscriptEntry[]
  currentUserId?: string
  contentAuthorId?: string
  repliesEnabled: boolean
  activeReplyId: string | null
  voteTallies: Record<string, VoteTally>
  myVoteCounts: Record<string, MyVoteCount>
  onReply?: (replyId: string, replyEventId: string, authorName: string) => void
  onDelete?: (replyId: string) => void
  renderComposer: (replyId: string) => ReactNode
}

export function PlayscriptThread({
  entries,
  currentUserId,
  contentAuthorId,
  repliesEnabled,
  activeReplyId,
  voteTallies,
  myVoteCounts,
  onReply,
  onDelete,
  renderComposer,
}: PlayscriptThreadProps) {
  const [showAll, setShowAll] = useState(false)

  if (entries.length === 0) return null

  const visibleEntries =
    showAll || entries.length <= INITIAL_VISIBLE
      ? entries
      : entries.slice(0, INITIAL_VISIBLE)
  const hiddenCount = entries.length - visibleEntries.length

  return (
    <div className="ml-8">
      <ol className="space-y-[32px]">
        {visibleEntries.map(entry => (
          <li key={entry.reply.id}>
            <PlayscriptReply
              entry={entry}
              currentUserId={currentUserId}
              contentAuthorId={contentAuthorId}
              repliesEnabled={repliesEnabled}
              onReply={onReply}
              onDelete={onDelete}
              voteTally={voteTallies[entry.reply.nostrEventId]}
              myVoteCounts={myVoteCounts[entry.reply.nostrEventId]}
            />
            {activeReplyId === entry.reply.id && (
              <div className="mt-4">{renderComposer(entry.reply.id)}</div>
            )}
          </li>
        ))}
      </ol>

      {hiddenCount > 0 && (
        <button
          onClick={() => setShowAll(true)}
          className="mt-[32px] label-ui text-grey-400 hover:text-black hover:underline transition-colors"
        >
          Show {hiddenCount} more {hiddenCount === 1 ? 'reply' : 'replies'}
        </button>
      )}
    </div>
  )
}
