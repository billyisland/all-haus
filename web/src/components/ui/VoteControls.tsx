'use client'

import { useState, useEffect } from 'react'
import { useAuth } from '../../stores/auth'
import { votes as votesApi } from '../../lib/api'
import type { VesselPalette } from '../workspace/tokens'

// F9 (2026-07-06): voting is free. The former paid-vote confirm modal + cost
// computation were removed; a click casts immediately.

export interface VoteTally {
  upvoteCount: number
  downvoteCount: number
  netScore: number
}

export interface MyVoteCount {
  upCount: number
  downCount: number
}

interface VoteControlsProps {
  targetEventId: string
  targetKind: number
  isOwnContent: boolean
  /** Themed-vessel palette (light/dark). Omit on fixed-light surfaces (the
   *  Glasshouse pane / white legacy cards) → muted text defaults to grey-600. */
  palette?: VesselPalette

  initialTally?: VoteTally
  initialMyVotes?: MyVoteCount
}

export function VoteControls({
  targetEventId,
  targetKind,
  isOwnContent,
  palette,
  initialTally,
  initialMyVotes,
}: VoteControlsProps) {
  const { user } = useAuth()

  const [tally, setTally] = useState<VoteTally>(
    initialTally ?? { upvoteCount: 0, downvoteCount: 0, netScore: 0 }
  )
  const [myVotes, setMyVotes] = useState<MyVoteCount>(
    initialMyVotes ?? { upCount: 0, downCount: 0 }
  )
  const [showTooltip, setShowTooltip] = useState(false)
  const [submitting, setSubmitting] = useState(false)

  useEffect(() => {
    if (!initialTally) {
      votesApi.getTallies([targetEventId])
        .then(data => {
          if (data?.tallies?.[targetEventId]) {
            setTally(data.tallies[targetEventId])
          }
        })
        .catch(err => console.error('Failed to load vote tallies', err))
    }
  }, [targetEventId, initialTally])

  useEffect(() => {
    if (!initialMyVotes && user) {
      votesApi.getMyVotes([targetEventId])
        .then(data => {
          if (data?.voteCounts?.[targetEventId]) {
            setMyVotes(data.voteCounts[targetEventId])
          }
        })
        .catch(err => console.error('Failed to load user votes', err))
    }
  }, [targetEventId, initialMyVotes, user])

  useEffect(() => { if (initialTally) setTally(initialTally) }, [initialTally])
  useEffect(() => { if (initialMyVotes) setMyVotes(initialMyVotes) }, [initialMyVotes])

  function handleVoteClick(direction: 'up' | 'down') {
    if (!user) {
      window.location.href = '/auth?mode=login'
      return
    }
    if (isOwnContent || submitting) return
    castVote(direction).catch((e) => console.error('Failed to cast vote', e))
  }

  async function castVote(direction: 'up' | 'down') {
    setSubmitting(true)
    try {
      const data = await votesApi.cast(targetEventId, targetKind, direction)
      setTally(data.tally)
      // counted:false = the server capped a repeat vote (one free vote per
      // direction) and recorded nothing — don't run the local count ahead.
      if (data.counted) {
        setMyVotes(prev => ({
          upCount: direction === 'up' ? prev.upCount + 1 : prev.upCount,
          downCount: direction === 'down' ? prev.downCount + 1 : prev.downCount,
        }))
      }
    } catch { /* silent */ }
    finally {
      setSubmitting(false)
    }
  }

  const disabled = !user || isOwnContent || submitting

  // Muted/active colours: on a themed vessel they track the palette (so they read
  // on a dark card); on a fixed-light surface (no palette) they fall back to
  // grey-600 / crimson. Hover is the mode-agnostic opacity fade used sitewide.
  const mutedColor = palette?.cardMeta ?? 'var(--ah-grey-600)'
  const accentColor = palette?.crimson ?? 'var(--ah-crimson)'

  return (
    <div className="flex items-center gap-0.5">
      <button
        onClick={() => handleVoteClick('up')}
        disabled={disabled}
        title={!user ? 'Log in to vote' : isOwnContent ? 'Cannot vote on own content' : 'Upvote'}
        aria-label={!user ? 'Log in to vote' : isOwnContent ? 'Cannot vote on own content' : 'Upvote'}
        className="px-1.5 py-0.5 text-ui-xs transition-opacity hover:opacity-70 disabled:opacity-40 disabled:cursor-not-allowed"
        style={{ color: myVotes.upCount > 0 ? accentColor : mutedColor, fontWeight: myVotes.upCount > 0 ? 500 : undefined }}
      >
        ▲
      </button>

      <div className="relative">
        <button
          className="text-ui-xs min-w-[1.5rem] text-center transition-opacity hover:opacity-70"
          style={{ color: mutedColor }}
          onMouseEnter={() => setShowTooltip(true)}
          onMouseLeave={() => setShowTooltip(false)}
        >
          {tally.netScore}
        </button>

        {showTooltip && (tally.upvoteCount > 0 || tally.downvoteCount > 0) && (
          <div className="absolute bottom-full left-1/2 -translate-x-1/2 mb-1 z-10 whitespace-nowrap bg-black px-2 py-1.5 text-[10px] text-white shadow-lg" style={{ borderRadius: '2px' }}>
            <div>↑ {tally.upvoteCount} {tally.upvoteCount !== 1 ? 'upvotes' : 'upvote'}</div>
            <div>↓ {tally.downvoteCount} {tally.downvoteCount !== 1 ? 'downvotes' : 'downvote'}</div>
          </div>
        )}
      </div>

      <button
        onClick={() => handleVoteClick('down')}
        disabled={disabled}
        title={!user ? 'Log in to vote' : isOwnContent ? 'Cannot vote on own content' : 'Downvote'}
        aria-label={!user ? 'Log in to vote' : isOwnContent ? 'Cannot vote on own content' : 'Downvote'}
        className="px-1.5 py-0.5 text-ui-xs transition-opacity hover:opacity-70 disabled:opacity-40 disabled:cursor-not-allowed"
        style={{ color: myVotes.downCount > 0 ? accentColor : mutedColor, fontWeight: myVotes.downCount > 0 ? 500 : undefined }}
      >
        ▼
      </button>
    </div>
  )
}
