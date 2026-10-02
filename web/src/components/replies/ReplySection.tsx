'use client'

import { useState, useEffect, useRef } from 'react'
import { useAuth } from '../../stores/auth'
import { useLoginHref } from '../../lib/auth-return'
import { useResolvedDark } from '../../stores/colorScheme'
import { useThreadRefresh } from '../../stores/threadRefresh'
import { useArticleConversation } from '../../hooks/useArticleConversation'
import { PostCardInteractive } from '../post/PostCardInteractive'
import { PostThread } from '../post/PostThread'
import type { CardContext } from '../post/chassis'
import type { Post } from '../../lib/post/types'
import {
  DEFAULT_DENSITY,
  DEFAULT_TEXT_SIZE,
  TEXT_SIZE_PX,
  VESSEL_PAD,
  globalContentPalette,
} from '../workspace/tokens'
import { ReplyComposer } from './ReplyComposer'
// The house's 4px slab weight (`.slab-rule-4`). A plain constant, not a hook —
// nothing of the public register's palette machinery comes with it.
import { SLAB } from '../public/palette'
import { replies as repliesApi } from '../../lib/api'
import { commentIdFromAnchor } from '../../lib/post/reply-anchor'

// =============================================================================
// ReplySection — the conversation at the foot of an article.
//
// ONE GRAMMAR FOR A CONVERSATION (operator, 2026-09-27): every reply is a
// `PostCardInteractive`, as everywhere else — no playscript, and nothing that
// appears on hover.
//
// AT REST, THE DIRECT REPLIES — flush and full size, because being here already
// says they answer the article (operator, 2026-09-27). The inset is kept for
// what it means everywhere else: THIS answers the card above. So each direct
// reply is a `feed`-level card carrying its first two replies as inset
// previews and a count of the rest. They are ranked by how much conversation
// hangs off each (GET /thread/:postId/top, `useArticleConversation`).
//
// OPENING ONE is the workspace's conversation grammar, in place: the clicked
// card becomes the focal of a `PostThread` in its own slot, its parents inset
// above, its replies inset below with "→ NAME" where a reply does not answer
// the card above it. Re-rooting works as it does anywhere; clicking the focal
// closes it. One conversation is open at a time, and the ARTICLE is never
// drawn at the head of the chain — the page above is the article.
//
// The workspace does NOT follow (operator, 2026-09-27): an expanded article in
// a vessel keeps its whole flat subtree under the article card.
//
// GET /replies is still asked, for the two facts `/thread` does not carry:
// whether the author has closed replies, and `paywallLocked`, which stays the
// server's word that a locked piece shows nothing below its gate (ADR §6a).
// =============================================================================

const ARTICLE_REPLY_PAGE = 10
// The beat between two direct replies' groups — a log item's, against the
// 5px inside a conversation.
const GROUP_GAP_PX = 20

interface ReplySectionProps {
  /** The article's `post_id` — what `/thread` resolves the conversation by. */
  postId: string
  targetEventId: string
  targetKind: number
  targetAuthorPubkey: string
  isUnlocked?: boolean
  /** A comment (`comments.id`) to bring into view once the conversation has
   *  loaded — a notification's errand. Absent on the page route, where the
   *  `#reply-<id>` hash says the same. */
  focusCommentId?: string | null
}

/** The one conversation open at the foot: which direct reply's slot it is in,
 *  and the node it was opened on. */
interface OpenSlot {
  topLevelId: string
  focalId: string
}

export function ReplySection({
  postId,
  targetEventId,
  targetKind,
  targetAuthorPubkey,
  isUnlocked,
  focusCommentId,
}: ReplySectionProps) {
  const { user } = useAuth()
  const loginHref = useLoginHref()
  const dark = useResolvedDark()
  const ctx: CardContext = {
    density: DEFAULT_DENSITY,
    palette: globalContentPalette(dark),
    bodyPx: TEXT_SIZE_PX[DEFAULT_TEXT_SIZE],
  }

  const convo = useArticleConversation(postId, ARTICLE_REPLY_PAGE)
  const [open, setOpen] = useState<OpenSlot | null>(null)
  const rootRef = useRef<HTMLDivElement>(null)

  // `null` until GET /replies answers: the composer and its alternatives wait
  // for it rather than guessing "open".
  const [gate, setGate] = useState<{ repliesEnabled: boolean; paywallLocked: boolean } | null>(null)

  // A CANCEL FLAG, because the reader pane keeps this mounted across a skip
  // and `targetEventId` changes under an in-flight load.
  useEffect(() => {
    let cancelled = false
    setGate(null)
    repliesApi
      .getForTarget(targetEventId)
      .then((d) => {
        if (cancelled) return
        setGate({
          repliesEnabled: d.repliesEnabled ?? d.commentsEnabled ?? true,
          paywallLocked: !!d.paywallLocked,
        })
      })
      .catch(() => {
        if (!cancelled) setGate({ repliesEnabled: true, paywallLocked: false })
      })
    return () => {
      cancelled = true
    }
  }, [targetEventId, isUnlocked])

  // The first read carries the errand, from the prop (the reader pane) or the
  // page's own `#reply-<id>` hash.
  const { load } = convo
  useEffect(() => {
    setOpen(null)
    load(focusCommentId ?? commentIdFromAnchor(window.location.hash))
  }, [postId, focusCommentId, load])

  // ── THE ERRAND LANDS ──────────────────────────────────────────────────────
  // A direct reply is brought into view where it stands; anything deeper
  // opens its conversation on it, and PostThread's own scroll-in finds it.
  const { focus, clearFocus } = convo
  useEffect(() => {
    if (!focus) return
    clearFocus()
    if (focus.postId !== focus.topLevelId) {
      setOpen({ topLevelId: focus.topLevelId, focalId: focus.postId })
      return
    }
    requestAnimationFrame(() => {
      rootRef.current
        ?.querySelector(`[data-post-id="${focus.postId}"]`)
        ?.scrollIntoView({ block: 'center', behavior: 'smooth' })
    })
  }, [focus, clearFocus])

  // ── A REPLY WAS PUBLISHED, OR DELETED, SOMEWHERE ──────────────────────────
  // Counts and previews are re-read in place. A reply written at rest, into a
  // direct reply or a preview, OPENS that card's conversation, so the reader
  // sees it land — at rest the only other sign would be a count going up. A
  // reply written inside the open conversation is PostThread's to merge.
  const refreshKey = useThreadRefresh((s) => s.tick)
  const refreshTarget = useThreadRefresh((s) => s.targetEventId)
  const seenKey = useRef(refreshKey)
  const { refresh, posts, entries } = convo
  useEffect(() => {
    if (refreshKey === seenKey.current) return
    seenKey.current = refreshKey
    refresh()
    if (!refreshTarget || refreshTarget === targetEventId) return
    const target = [...posts.values()].find((p) => p.version === refreshTarget)
    if (!target) return
    const slot = entries.find((e) => e.id === target.id || e.previewIds.includes(target.id))
    if (slot && open?.topLevelId !== slot.id) {
      setOpen({ topLevelId: slot.id, focalId: target.id })
    }
  }, [refreshKey, refreshTarget, targetEventId, refresh, posts, entries, open])

  // WAITING IS THE SLAB, NOT A SKELETON — the 4px weight sweeping the width the
  // section already occupies. Built from tokens rather than importing
  // `IndeterminateSlab`, whose track resolves correctly only inside
  // `LIGHT_ISLAND_STYLE`; `var(--ah-ink)` is a DARK_SLUG and inverts once, on
  // its own. `.ah-indeterminate-slab` in globals.css owns the sweep.
  //
  // THE SECTION'S OUTER SHELL. Keep the margin AND the padding rather than
  // folding them into one measure: this section's wrapper in ArticleReader is
  // `mt-24`, and `mt-8` COLLAPSES into it while `pt-6` does not — so the
  // rendered gap is 96 + 24, and a tidy-looking `mt-14` would take 24px off it.
  const SHELL = 'mt-8 pt-6'
  if (!gate || convo.loading) {
    return (
      <div className={SHELL}>
        <div
          role="progressbar"
          aria-label="Loading"
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

  // A locked article shows NOTHING below its gate (2026-09-02; ADR §6a).
  if (gate.paywallLocked) return null

  const total = convo.totalReplies
  const isOwn = (p: Post) => !!user?.pubkey && p.author.pubkey === user.pubkey
  const openOn = (topLevelId: string, p: Post) => setOpen({ topLevelId, focalId: p.id })

  return (
    <div className={SHELL} ref={rootRef}>
      <h3 className="label-ui text-grey-600 mb-6">
        {total > 0 ? `${total} ${total !== 1 ? 'replies' : 'reply'}` : 'Replies'}
      </h3>

      {convo.error && convo.entries.length === 0 && (
        <p className="text-ui-xs text-grey-400 mb-6">Couldn’t load the replies. Please reload the page to try again.</p>
      )}

      {/* THE VESSEL'S GROUND, because a card is a card only against one: the
          article page is the cards' own white, and on it the replies read as
          loose text with an action row. The /author page sets its log on
          `palette.interior` for the same reason; the pad is the vessel's. */}
      {convo.entries.length > 0 && (
        <div
          className="mb-6"
          style={{ background: ctx.palette.interior, padding: VESSEL_PAD }}
        >
          {convo.entries.map((entry, i) => {
            const last = i === convo.entries.length - 1 && !convo.nextOffset
            const groupStyle = { marginBottom: last ? 0 : GROUP_GAP_PX }
            if (open?.topLevelId === entry.id) {
              return (
                <div key={entry.id} style={groupStyle}>
                  <PostThread
                    rootPostId={open.focalId}
                    ctx={ctx}
                    omitAncestorId={postId}
                    replyPage={ARTICLE_REPLY_PAGE}
                    markReplyParents
                    onCollapse={() => setOpen(null)}
                    currentUserPubkey={user?.pubkey ?? null}
                  />
                </div>
              )
            }
            const head = convo.posts.get(entry.id)
            if (!head) return null
            const previews = entry.previewIds
              .map((id) => convo.posts.get(id))
              .filter((p): p is Post => !!p)
            const rest = entry.count - previews.length
            return (
              <div key={entry.id} style={groupStyle}>
                <PostCardInteractive
                  post={head}
                  level="feed"
                  ctx={ctx}
                  onExpand={(p) => openOn(entry.id, p)}
                  isOwnContent={isOwn(head)}
                />
                {previews.map((p) => (
                  <PostCardInteractive
                    key={p.id}
                    post={p}
                    level="thread-reply"
                    ctx={ctx}
                    onReroot={(x) => openOn(entry.id, x)}
                    isOwnContent={isOwn(p)}
                  />
                ))}
                {rest > 0 && (
                  <button
                    type="button"
                    onClick={() => openOn(entry.id, head)}
                    className="ml-8 mt-1 label-ui hover:underline"
                    style={{ color: ctx.palette.cardMeta }}
                  >
                    {`Show ${rest} more repl${rest === 1 ? 'y' : 'ies'}`}
                  </button>
                )}
              </div>
            )
          })}
          {convo.nextOffset !== undefined && (
            <button
              type="button"
              onClick={convo.loadMore}
              disabled={convo.loadingMore}
              className="mt-2 label-ui hover:underline disabled:opacity-50"
              style={{ color: ctx.palette.cardMeta }}
            >
              {convo.loadingMore ? 'Loading…' : 'Show more replies'}
            </button>
          )}
        </div>
      )}

      {gate.repliesEnabled && user ? (
        // A reply to the article carries itself as the errand: the server
        // widens the page through it, the refresh appends it at the end of
        // what is loaded — just above this box — and the errand brings it
        // into view.
        <ReplyComposer
          targetEventId={targetEventId}
          targetKind={targetKind}
          targetAuthorPubkey={targetAuthorPubkey}
          onPublished={(r: { id: string }) => refresh(r.id)}
        />
      ) : !gate.repliesEnabled ? (
        <p className="text-xs text-grey-300 italic mb-4">
          The writer has turned off replies for this piece.
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
      )}
    </div>
  )
}
