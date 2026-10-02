import type { ResolverMatch } from '../lib/api/resolver'
import { matchToOptions } from '../lib/workspace/resolve'
import { call, okBody, path, query, GatewayFault, type GatewayContext } from './gateway'

// =============================================================================
// modernhaus — direct messages (MODERNHAUS-ADR §D2.3, E6).
//
// The thread's bodies are decrypted by the member's own key through
// `POST /dm/decrypt-batch` — a POST whose effect is a read, on §D2.5.1's
// closed list — and only for display, in this response. A body that could not
// be decrypted is said to be so, never shown as empty.
//
// DMs ARE TEXT ONLY IN ALL THREE HALVES (security.md). This register is a
// third renderer, and it renders every body as escaped text, never linked.
// =============================================================================

export interface InboxMember {
  id: string
  username: string
  displayName: string | null
}

/** One conversation in the inbox, as `GET /messages` sends it (`lastMessageAt`, not a preview). */
export interface InboxRow {
  id: string
  lastMessageAt: string | null
  createdAt: string
  unreadCount: number
  members: InboxMember[]
}

export async function loadInbox(gw: GatewayContext): Promise<InboxRow[]> {
  const b = okBody(await call<{ conversations: InboxRow[] }>(gw, 'GET', '/messages'), 'inbox')
  if (!Array.isArray(b.conversations)) throw new GatewayFault('inbox: no list')
  return b.conversations
}

interface EncryptedMessage {
  id: string
  senderId: string
  senderUsername: string
  senderDisplayName: string | null
  counterpartyPubkey: string
  contentEnc: string
  replyTo: { id: string; senderUsername: string | null; contentEnc: string | null; counterpartyPubkey: string | null } | null
  createdAt: string
  likeCount: number
  likedByMe: boolean
}

export interface ThreadMessage {
  id: string
  senderId: string
  senderUsername: string
  senderDisplayName: string | null
  /** Null when this message could not be decrypted — said, never shown as empty. */
  content: string | null
  replyTo: { senderUsername: string | null; content: string | null } | null
  createdAt: string
  likeCount: number
  likedByMe: boolean
}

export interface MessageThreadData {
  conversationId: string
  /** The other members, from the inbox; null when the inbox could not say. */
  members: InboxMember[] | null
  /** Oldest first, as a conversation is read. */
  messages: ThreadMessage[]
  /** The cursor for older messages, or null at the start of the conversation. */
  before: string | null
}

/** The route's own cap on one decrypt batch (`messages.ts`). */
const DECRYPT_MAX = 100

/**
 * One page of a conversation, decrypted. Null when the conversation is not
 * the viewer's (the route's 403/404). The decrypt is one call per page: a
 * failure of the whole batch leaves every body undecrypted, which the page
 * says per message — the messages themselves still stand.
 */
export async function loadMessageThread(
  gw: GatewayContext,
  conversationId: string,
  before: string | null,
): Promise<MessageThreadData | null> {
  const [a, inbox] = await Promise.all([
    call<{ messages: EncryptedMessage[]; nextCursor: string | null }>(
      gw,
      'GET',
      path`/messages/${conversationId}` + query({ before: before ?? undefined }),
    ),
    loadInbox(gw).catch((err) => {
      console.warn('[modernhaus] inbox unavailable for a thread header', err instanceof GatewayFault ? err.message : err)
      return null
    }),
  ])
  if (a.status === 403 || a.status === 404 || a.status === 400) return null
  const b = okBody(a, 'messages')
  if (!Array.isArray(b.messages)) throw new GatewayFault('messages: no list')

  const toDecrypt: Array<{ id: string; counterpartyPubkey: string; ciphertext: string }> = []
  for (const m of b.messages) {
    toDecrypt.push({ id: m.id, counterpartyPubkey: m.counterpartyPubkey, ciphertext: m.contentEnc })
    if (m.replyTo?.contentEnc && m.replyTo.counterpartyPubkey) {
      toDecrypt.push({ id: `reply:${m.id}`, counterpartyPubkey: m.replyTo.counterpartyPubkey, ciphertext: m.replyTo.contentEnc })
    }
  }
  const plain = new Map<string, string | null>()
  for (let i = 0; i < toDecrypt.length; i += DECRYPT_MAX) {
    try {
      const d = await call<{ results: Array<{ id: string; plaintext: string | null }> }>(gw, 'POST', '/dm/decrypt-batch', {
        json: { messages: toDecrypt.slice(i, i + DECRYPT_MAX) },
      })
      if (d.status === 200 && Array.isArray(d.body?.results)) {
        for (const r of d.body.results) plain.set(r.id, typeof r.plaintext === 'string' ? r.plaintext : null)
      } else {
        console.warn('[modernhaus] decrypt batch refused', d.status)
      }
    } catch (err) {
      console.warn('[modernhaus] decrypt batch failed', err instanceof GatewayFault ? err.message : err)
    }
  }

  const messages: ThreadMessage[] = b.messages
    .map((m) => ({
      id: m.id,
      senderId: m.senderId,
      senderUsername: m.senderUsername,
      senderDisplayName: m.senderDisplayName,
      content: plain.get(m.id) ?? null,
      replyTo: m.replyTo ? { senderUsername: m.replyTo.senderUsername, content: plain.get(`reply:${m.id}`) ?? null } : null,
      createdAt: m.createdAt,
      likeCount: Number(m.likeCount) || 0,
      likedByMe: m.likedByMe === true,
    }))
    .reverse()
  const members = inbox?.find((c) => c.id === conversationId)?.members ?? null
  return { conversationId, members, messages, before: typeof b.nextCursor === 'string' ? b.nextCursor : null }
}

/** A lookup for a new message: `POST /resolve` in the `dm` context (§D2.5.1). */
export type DmLookup =
  | { kind: 'none' }
  | { kind: 'matches'; accounts: Array<{ id: string; username: string; displayName: string }> }
  | { kind: 'refused'; status: number }

export async function lookupRecipient(gw: GatewayContext, q: string): Promise<DmLookup> {
  const a = await call<{ matches?: ResolverMatch[] }>(gw, 'POST', '/resolve', {
    json: { query: q, context: 'dm', discover: true },
  })
  if (a.status >= 500) throw new GatewayFault(`resolve ${a.status}`)
  if (a.status !== 200) return { kind: 'refused', status: a.status }
  // The feed composer's own mapping (`lib/workspace/resolve.ts`), narrowed to
  // the people it names, as the inbox's `ri.matches.filter(m => m.account)` does.
  const accounts = (a.body?.matches ?? [])
    .flatMap(matchToOptions)
    .flatMap((o) => (o.account ? [o.account] : []))
    .filter((acc, i, all) => all.findIndex((x) => x.id === acc.id) === i)
  return accounts.length > 0 ? { kind: 'matches', accounts } : { kind: 'none' }
}

/** What the VIEWER has done to one account (`GET /my/relations/:id`). */
export interface Relation {
  muted: boolean
  blocked: boolean
}

/**
 * The viewer's relation to the one other member of a two-person conversation
 * — a secondary read, null when it could not be said or the thread is a group.
 * Only this direction is ever known: a block the other party set is not
 * disclosed, and the send's own neutral refusal covers it (security.md).
 */
export async function loadRelation(gw: GatewayContext, data: MessageThreadData): Promise<Relation | null> {
  const other = data.members?.length === 1 ? data.members[0] : null
  if (!other) return null
  return loadRelationFor(gw, other.id)
}

export async function loadRelationFor(gw: GatewayContext, userId: string): Promise<Relation | null> {
  try {
    const a = await call<Relation>(gw, 'GET', path`/my/relations/${userId}`)
    if (a.status === 200 && typeof a.body?.muted === 'boolean' && typeof a.body?.blocked === 'boolean') return a.body
    return null
  } catch (err) {
    console.warn('[modernhaus] relation unavailable', err instanceof GatewayFault ? err.message : err)
    return null
  }
}
