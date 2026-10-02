import { createElement } from 'react'
import { MESSAGES_SEND_FAILED } from '../../content/messages'
import { call, must, path } from '../gateway'
import { documentResponse, loadViewer, loadUnreadCounts } from '../page'
import type { ActionContext, ActionOutcome, Input, Registry } from '../door'
import { loadMessageThread, loadRelation } from '../messages-loaders'
import { MessageThreadPage, threadTitle } from '../pages/messages'
import { doorOwns, ok, refused, str } from './shared'

// =============================================================================
// modernhaus — direct-message writes (MODERNHAUS-ADR §D2.4, E6): send, read
// all, like, and start a conversation.
//
// DMs ARE TEXT ONLY IN ALL THREE HALVES (security.md). The route refuses a
// link with its own code and sentence; this door carries that refusal back to
// the member with what they typed, and nothing here turns text into a link.
// =============================================================================

const thread = (id: string) => `/modernhaus/messages/${encodeURIComponent(id)}`

/** The member's own words, never trimmed: a message is sent as it was typed. */
const raw = (v: Input[string]): string => (typeof v === 'string' ? v : '')

/**
 * A refused send, re-rendered with what was typed (§D1.3). The sentence is the
 * route's own where it sent one (the full site's `apiErrorMessage` rule — the
 * link refusal is one), else the full site's own fallback.
 */
async function sendAgain(ctx: ActionContext, conversationId: string, content: string, status: number, message: unknown): Promise<ActionOutcome> {
  const [viewer, data, counts] = await Promise.all([
    loadViewer(ctx.gw),
    loadMessageThread(ctx.gw, conversationId, null),
    loadUnreadCounts(ctx.gw),
  ])
  if (!viewer) return refused(401)
  if (!data) return refused(404)
  const relation = await loadRelation(ctx.gw, data)
  const sentence = typeof message === 'string' && message.trim() !== '' ? message : MESSAGES_SEND_FAILED
  return {
    kind: 'response',
    response: await documentResponse({
      title: threadTitle(data),
      viewer,
      csrf: ctx.csrf,
      twin: `/messages/${encodeURIComponent(conversationId)}`,
      outcome: { kind: 'error', sentence },
      body: createElement(MessageThreadPage, { data, viewer, csrf: ctx.csrf, relation, draft: content }),
      status: status >= 400 && status < 500 ? status : 400,
      cookies: ctx.gw.setCookies,
      counts,
    }),
  }
}

async function messageSend(ctx: ActionContext, input: Input): Promise<ActionOutcome> {
  const conversationId = str(input.conversationId)
  const content = raw(input.content)
  if (!conversationId) return refused(404)
  if (content.trim() === '') return sendAgain(ctx, conversationId, content, 400, null)
  const a = must(await call(ctx.gw, 'POST', path`/messages/${conversationId}`, { json: { content } }), 'message send')
  if (ok(a)) return { kind: 'done', code: 'message_sent', back: thread(conversationId) }
  if (doorOwns(a)) return { kind: 'answer', answer: a }
  const body = a.body && typeof a.body === 'object' ? (a.body as { message?: unknown; error?: unknown }) : {}
  // The route's English refusals ride `error`; its link refusal rides `message`.
  const sentence = typeof body.message === 'string' ? body.message : typeof body.error === 'string' && /\s/.test(body.error) ? body.error : null
  return sendAgain(ctx, conversationId, content, a.status, sentence)
}

async function messageLike(ctx: ActionContext, input: Input): Promise<ActionOutcome> {
  const a = must(await call<{ liked?: unknown }>(ctx.gw, 'POST', path`/messages/${str(input.messageId)}/like`, { json: {} }), 'message like')
  if (!ok(a)) return { kind: 'answer', answer: a }
  return { kind: 'done', code: a.body?.liked === false ? 'unliked' : 'liked' }
}

async function conversationStart(ctx: ActionContext, input: Input): Promise<ActionOutcome> {
  const memberId = str(input.memberId)
  if (!memberId) return refused(400)
  const a = must(
    await call<{ conversationId?: unknown }>(ctx.gw, 'POST', '/conversations', { json: { memberIds: [memberId] } }),
    'conversation start',
  )
  if (ok(a) && typeof a.body?.conversationId === 'string') {
    return { kind: 'done', code: 'conversation_started', back: thread(a.body.conversationId) }
  }
  if (doorOwns(a) || ok(a)) return { kind: 'answer', answer: ok(a) ? { ...a, status: 502 } : a }
  // The full site says one sentence for every refusal here.
  return { kind: 'error', code: 'conversation_not_started' }
}

export const MESSAGE_ACTIONS: Registry = {
  message_send: {
    kind: 'orchestrated',
    fields: { conversationId: 'string', content: 'string' },
    run: messageSend,
    defaultReturn: (i) => thread(str(i.conversationId)),
  },
  messages_read_all: {
    kind: 'simple',
    method: 'POST',
    fields: { conversationId: 'string' },
    path: (i) => path`/messages/${str(i.conversationId)}/read-all`,
    done: 'all_read',
    defaultReturn: (i) => thread(str(i.conversationId)),
  },
  message_like: {
    kind: 'orchestrated',
    fields: { messageId: 'string', conversationId: 'string' },
    run: messageLike,
    defaultReturn: (i) => thread(str(i.conversationId)),
  },
  conversation_start: {
    kind: 'orchestrated',
    fields: { memberId: 'string' },
    run: conversationStart,
    defaultReturn: () => '/modernhaus/messages/new',
  },
}
