'use client'

import { useState, useEffect, useCallback, useMemo } from 'react'
import { useAuth } from '../../stores/auth'
import { useLoginHref } from '../../lib/auth-return'
import { ReplyComposer } from './ReplyComposer'
import { PlayscriptThread } from './PlayscriptThread'
import type { ReplyData, PlayscriptEntry } from './types'
// The house's 4px slab weight (`.slab-rule-4`). A plain constant, not a hook —
// nothing of the public register's palette machinery comes with it.
import { SLAB } from '../public/palette'
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
  const loginHref = useLoginHref()
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

  // THE SECTION'S OUTER SHELL. The break between a piece and its replies is
  // whitespace, exactly as the foot of the piece itself is — the divider that
  // used to sit here was a grey rule one pixel high, which the sitewide
  // no-single-pixel-lines ban forbids, and both surviving copies of it had
  // already drifted apart from the third (the locked branch, now gone).
  //
  // THE SPACING IS UNCHANGED. Keep the margin AND the padding rather than
  // folding them into one measure: this section's wrapper in ArticleReader is
  // `mt-24`, and `mt-8` COLLAPSES into it (no border, no padding between them)
  // while `pt-6` does not — so the rendered gap is 96 + 24, and a tidy-looking
  // `mt-14` would silently take 24px off it.
  //
  // What marks the section now is what marked it before: the `label-ui` count
  // heading below.
  const SHELL = compact ? '' : 'mt-8 pt-6'

  // WAITING IS THE SLAB, NOT A SKELETON. This drew two pulsing grey bars
  // indented to where it guessed the playscript would land — a guess about a
  // layout made at the one moment you cannot know it, which is the house's
  // stated objection to skeletons (Field.tsx's IndeterminateSlab). The 4px
  // weight sweeping the width the section already occupies says "waiting"
  // without claiming to know what arrives, and it is the same gesture the
  // register uses on `/auth`.
  //
  // BUILT FROM TOKENS RATHER THAN IMPORTING THAT COMPONENT, and the reason is
  // a dark-mode trap worth knowing. `IndeterminateSlab` takes its track from
  // `controlLine(usePublicPalette())`, which is `--ah-ink` in light but
  // BASIC_DARK's `--ah-bone` in dark — a value that only resolves to bone
  // INSIDE `LIGHT_ISLAND_STYLE`, which `PublicVessel` applies and this section
  // has no business being wrapped in. Un-islanded, html.dark would inflict a
  // SECOND inversion on it (bone -> 20 19 17) and the track would be
  // near-black on the reader's 30 29 26 ground: an invisible progress bar.
  // `var(--ah-ink)` is a DARK_SLUG, so it inverts once, on its own, correctly
  // in both modes — which is exactly the symmetry palette.ts describes, 4px of
  // ink on white and 4px of bone on a dark ground being one gesture.
  //
  // The animation itself is NOT duplicated: `.ah-indeterminate-slab` in
  // globals.css owns the sweep and its `prefers-reduced-motion` full-width
  // resting state, so the only thing local here is which two colours it wears.
  if (loading) {
    return (
      <div className={SHELL}>
        <div
          role="progressbar"
          aria-label="Loading replies"
          style={{ height: SLAB, background: 'var(--ah-ink)', overflow: 'hidden' }}
        >
          <div
            className="ah-indeterminate-slab"
            style={{ height: SLAB, background: 'var(--ah-crimson)' }}
          />
        </div>
      </div>
    )
  }

  // A locked article shows NOTHING below its gate (2026-09-02). This branch
  // used to draw a rule one pixel high and then tell the reader to unlock the
  // article — a weight the no-single-pixel-lines ban forbids, under advice the
  // crimson gate immediately above had already given, in grey-300 italic that
  // read as an apology for the page ending. The gate is the whole of the
  // message; the foot of a locked piece is quiet.
  if (paywallLocked) return null

  const targetForComposer =
    replyTarget && replies.some(r => containsReply(r, replyTarget.replyId))
      ? replyTarget
      : null

  return (
    <div className={SHELL}>
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
            {/* Carries the piece too — somebody pressing this is unambiguously
                mid-article, and losing their place to log in is exactly what
                the carrier exists to prevent (lib/auth-return.ts). */}
            <a href={loginHref} className="text-crimson hover:text-crimson-dark">
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
