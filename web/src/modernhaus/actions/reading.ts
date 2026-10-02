import { createElement } from 'react'
import type { ReplyTarget } from '../../lib/post/reply-target'
import { call, must, path, type GatewayAnswer } from '../gateway'
import { safeReturn } from '../outcomes'
import { documentResponse, loadViewer } from '../page'
import type { ActionContext, ActionOutcome, Input, Registry } from '../door'
import { doorOwns, refusalSentence } from './shared'
import { ReplyAgainPage, type ExternalReplyTarget } from '../pages/conversation'
import { joinTextAndImages } from '../../lib/note-compose'
import { safeHttpUrl } from '../../lib/external-links'
import { filePart, uploadPicture } from '../picture'

// =============================================================================
// modernhaus — the reading step's writes (MODERNHAUS-ADR §D2.4, E3): votes,
// replies, the external interact-backs, deletes, a report, and marking
// notifications read. Each calls the route the full site calls, and the
// orchestrated ones run the browser's own sequence.
//
// A REPLY CARRIES LONG TEXT, so a refusal re-renders its form with what was
// typed (§D1.3) and the route's own sentence (§D2.5.3) — never a redirect
// that would lose it. 401 and `age_required` still go to the door, which owns
// those two redirects.
// =============================================================================

const str = (v: Input[string]): string => (typeof v === 'string' ? v.trim() : '')
const opt = (v: Input[string]): string | undefined => str(v) || undefined

/** The native reply target, rebuilt from the form's hidden fields. */
function nativeTarget(input: Input): ReplyTarget | null {
  const eventId = str(input.eventId)
  const authorPubkey = str(input.authorPubkey)
  const eventKind = Number(str(input.eventKind))
  if (!eventId || !authorPubkey || !Number.isInteger(eventKind)) return null
  return {
    eventId,
    eventKind,
    authorPubkey,
    authorName: '',
    parentCommentId: opt(input.parentCommentId),
    parentCommentEventId: opt(input.parentCommentEventId),
  }
}

async function replyAgain(
  ctx: ActionContext,
  input: Input,
  answer: GatewayAnswer,
  target: { native: ReplyTarget | null; external: ExternalReplyTarget | null },
  pictureUrl: string | null = null,
): Promise<ActionOutcome> {
  const back = safeReturn(str(input.return) || null) ?? '/modernhaus'
  const viewer = await loadViewer(ctx.gw)
  return {
    kind: 'response',
    response: await documentResponse({
      title: 'Your reply was not posted',
      viewer,
      csrf: ctx.csrf,
      twin: null,
      outcome: { kind: 'error', sentence: refusalSentence(answer) },
      body: createElement(ReplyAgainPage, { csrf: ctx.csrf, back, draft: str(input.content), pictureUrl, ...target }),
      status: answer.status >= 400 && answer.status < 500 ? answer.status : 400,
      cookies: ctx.gw.setCookies,
    }),
  }
}

/**
 * `publishReply`'s sequence, on the server: sign and enqueue the kind-1 event
 * with the root `e` tag, the `p` tag and — for a reply to a comment — the
 * comment's `e` reply tag; then index it against the conversation's ROOT with
 * the comment as its parent. The tags are `lib/replies.ts`'s, exactly.
 */
async function reply(ctx: ActionContext, input: Input): Promise<ActionOutcome> {
  const target = nativeTarget(input)
  // A form missing its target is refused as the route would refuse it.
  if (!target) return { kind: 'answer', answer: { status: 400, body: null, setCookies: [] } }

  // A picture is uploaded FIRST and its address joins the words, as the full
  // site's reply box ships it (`joinTextAndImages`). One kept from an earlier,
  // refused press is used rather than asked for again.
  let pictureUrl = safeHttpUrl(str(input.pictureUrl)) ?? null
  const upload = await uploadPicture(ctx, filePart(ctx.form, 'picture'))
  if (upload.kind === 'refused') {
    if (doorOwns(upload.answer)) return { kind: 'answer', answer: upload.answer }
    return replyAgain(ctx, input, upload.answer, { native: target, external: null }, pictureUrl)
  }
  if (upload.kind === 'stored') pictureUrl = upload.url
  const content = joinTextAndImages(str(input.content), pictureUrl ? [pictureUrl] : [])
  // Checked BEFORE the signature: the relay takes a signed event whatever the
  // index then says, so an empty reply refused only by the index is an orphan.
  if (!content) {
    return replyAgain(ctx, input, { status: 400, body: { message: 'Write something, or add a picture, before posting.' }, setCookies: [] }, { native: target, external: null }, pictureUrl)
  }
  const tags: string[][] = [
    ['e', target.eventId, '', 'root'],
    ['p', target.authorPubkey],
  ]
  if (target.parentCommentEventId) tags.push(['e', target.parentCommentEventId, '', 'reply'])

  const signed = must(
    await call<{ id?: string }>(ctx.gw, 'POST', '/sign-and-publish', { json: { kind: 1, content, tags } }),
    'sign-and-publish',
  )
  if (signed.status !== 200 || typeof signed.body?.id !== 'string') {
    if (doorOwns(signed) || signed.status >= 500 || signed.status < 400) return { kind: 'answer', answer: signed }
    return replyAgain(ctx, input, signed, { native: target, external: null }, pictureUrl)
  }

  const indexed = must(
    await call(ctx.gw, 'POST', '/replies', {
      json: {
        nostrEventId: signed.body.id,
        targetEventId: target.eventId,
        targetKind: target.eventKind,
        parentCommentId: target.parentCommentId ?? null,
        content,
      },
    }),
    'replies',
  )
  if (indexed.status === 201 || indexed.status === 200) return { kind: 'done', code: 'replied' }
  if (doorOwns(indexed) || indexed.status < 400) return { kind: 'answer', answer: indexed }
  return replyAgain(ctx, input, indexed, { native: target, external: null }, pictureUrl)
}

async function externalReply(ctx: ActionContext, input: Input): Promise<ActionOutcome> {
  const itemId = str(input.itemId)
  const linkedAccountId = str(input.linkedAccountId)
  const answer = must(
    await call<{ crossPost?: string }>(ctx.gw, 'POST', path`/external-items/${itemId}/reply`, {
      json: { linkedAccountId, content: str(input.content) },
    }),
    'external reply',
  )
  if (answer.status >= 200 && answer.status < 300) {
    return { kind: 'done', code: answer.body?.crossPost === 'not_sent' ? 'replied_not_sent' : 'replied' }
  }
  if (doorOwns(answer)) return { kind: 'answer', answer }
  return replyAgain(ctx, input, answer, { native: null, external: { itemId, linkedAccountId } })
}

async function vote(ctx: ActionContext, input: Input): Promise<ActionOutcome> {
  const direction = str(input.direction)
  const answer = must(
    await call<{ counted?: boolean }>(ctx.gw, 'POST', '/votes', {
      json: {
        targetEventId: str(input.targetEventId),
        targetKind: Number(str(input.targetKind)),
        // Anything but the two words is the route's to refuse.
        direction,
      },
    }),
    'vote',
  )
  if (answer.status >= 200 && answer.status < 300) {
    // `counted: false` — the server capped a repeat (one free vote per
    // direction per target) and recorded nothing.
    return { kind: 'done', code: answer.body?.counted === false ? 'vote_capped' : 'voted' }
  }
  return { kind: 'answer', answer }
}

async function report(ctx: ActionContext, input: Input): Promise<ActionOutcome> {
  const answer = must(
    await call<{ priority?: string }>(ctx.gw, 'POST', '/reports', {
      json: {
        targetPostId: opt(input.targetPostId),
        targetNostrEventId: opt(input.targetNostrEventId),
        targetAccountId: opt(input.targetAccountId),
        category: str(input.category),
        notes: opt(input.notes),
      },
    }),
    'report',
  )
  if (answer.status === 201 || answer.status === 200) {
    // The deadline is the SERVER's: it derives the priority from the category.
    // A reply without one is the widest promise, as the full site's panel does.
    const p = answer.body?.priority
    return { kind: 'done', code: p === 'P0' ? 'reported_p0' : p === 'P2' ? 'reported_p2' : 'reported_p1' }
  }
  return { kind: 'answer', answer }
}

const back = () => '/modernhaus'

export const READING_ACTIONS: Registry = {
  vote: {
    kind: 'orchestrated',
    fields: { targetEventId: 'string', targetKind: 'string', direction: 'string' },
    run: vote,
    defaultReturn: back,
  },
  reply: {
    kind: 'orchestrated',
    fields: {
      content: 'string',
      eventId: 'string',
      eventKind: 'string',
      authorPubkey: 'string',
      parentCommentId: 'string',
      parentCommentEventId: 'string',
      pictureUrl: 'string',
      return: 'string',
    },
    run: reply,
    defaultReturn: back,
  },
  external_like: {
    kind: 'simple',
    method: 'POST',
    fields: { itemId: 'string', linkedAccountId: 'string' },
    path: (i) => path`/external-items/${str(i.itemId)}/like`,
    body: (i) => ({ linkedAccountId: str(i.linkedAccountId) }),
    done: 'liked',
    defaultReturn: back,
  },
  external_repost: {
    kind: 'simple',
    method: 'POST',
    fields: { itemId: 'string', linkedAccountId: 'string' },
    path: (i) => path`/external-items/${str(i.itemId)}/repost`,
    body: (i) => ({ linkedAccountId: str(i.linkedAccountId) }),
    done: 'reposted',
    defaultReturn: back,
  },
  external_reply: {
    kind: 'orchestrated',
    fields: { itemId: 'string', linkedAccountId: 'string', content: 'string', return: 'string' },
    run: externalReply,
    defaultReturn: back,
  },
  external_poll_vote: {
    kind: 'simple',
    method: 'POST',
    fields: { itemId: 'string', linkedAccountId: 'string', choice: 'list' },
    path: (i) => path`/external-items/${str(i.itemId)}/poll-vote`,
    body: (i) => ({
      linkedAccountId: str(i.linkedAccountId),
      choices: (Array.isArray(i.choice) ? i.choice : []).map(Number).filter((n) => Number.isInteger(n) && n >= 0),
    }),
    done: 'poll_voted',
    defaultReturn: back,
  },
  note_delete: {
    kind: 'simple',
    method: 'DELETE',
    fields: { eventId: 'string' },
    path: (i) => path`/notes/${str(i.eventId)}`,
    done: 'deleted',
    defaultReturn: back,
  },
  reply_delete: {
    kind: 'simple',
    method: 'DELETE',
    fields: { replyId: 'string' },
    path: (i) => path`/replies/${str(i.replyId)}`,
    done: 'deleted',
    defaultReturn: back,
  },
  report: {
    kind: 'orchestrated',
    fields: {
      targetPostId: 'string',
      targetNostrEventId: 'string',
      targetAccountId: 'string',
      category: 'string',
      notes: 'string',
    },
    run: report,
    defaultReturn: back,
  },
  notification_read: {
    kind: 'simple',
    method: 'POST',
    fields: { id: 'string' },
    path: (i) => path`/notifications/${str(i.id)}/read`,
    body: () => ({}),
    done: 'read',
    defaultReturn: () => '/modernhaus/notifications',
  },
  notifications_read_all: {
    kind: 'simple',
    method: 'POST',
    fields: {},
    path: () => path`/notifications/read-all`,
    body: () => ({}),
    done: 'all_read',
    defaultReturn: () => '/modernhaus/notifications',
  },
}

