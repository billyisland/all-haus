import { randomUUID } from 'node:crypto'
import { pool, withTransaction } from '@platform-pub/shared/db/client.js'
import { signEvent, nip44EncryptBatch, nip44Decrypt } from '../lib/key-custody-client.js'
import { enqueueRelayPublish, type SignedNostrEvent } from '@platform-pub/shared/lib/relay-outbox.js'
import logger from '@platform-pub/shared/lib/logger.js'

// =============================================================================
// Messages Service
//
// Business logic for direct messages, conversations, DM likes, decryption, and
// DM pricing. Route handlers in routes/messages.ts are thin dispatchers that
// parse/validate input and translate these results into HTTP responses.
//
// Functions return discriminated unions so callers can map error cases to
// HTTP statuses without throws.
// =============================================================================

export type ServiceResult<T> =
  | { ok: true; data: T }
  | { ok: false; status: number; error: string; details?: Record<string, unknown> }

// -----------------------------------------------------------------------------
// Conversations
// -----------------------------------------------------------------------------

export async function createConversation(
  creatorId: string,
  memberIds: string[]
): Promise<ServiceResult<{ conversationId: string }>> {
  const allMembers = [creatorId, ...memberIds.filter(id => id !== creatorId)]

  const blockCheck = await pool.query<{ blocked_id: string }>(
    `SELECT blocked_id FROM blocks
     WHERE (blocker_id = $1 AND blocked_id = ANY($2))
        OR (blocked_id = $1 AND blocker_id = ANY($2))`,
    [creatorId, memberIds]
  )
  if (blockCheck.rows.length > 0) {
    return { ok: false, status: 403, error: 'Cannot create conversation with blocked users' }
  }

  // Conversation identity is the participant set, not a fresh UUID: reuse an
  // existing conversation whose members are *exactly* allMembers (no more, no
  // fewer) so a second message to the same friend continues the existing thread
  // instead of spawning a duplicate. (Member set is unique per conversation —
  // (conversation_id, user_id) is the PK — so array_agg yields the exact set.)
  const sortedMembers = [...allMembers].sort()
  const existing = await pool.query<{ conversation_id: string }>(
    `SELECT conversation_id
       FROM conversation_members
      GROUP BY conversation_id
     HAVING array_agg(user_id ORDER BY user_id) = $1::uuid[]
      LIMIT 1`,
    [sortedMembers]
  )
  if (existing.rows.length > 0) {
    const conversationId = existing.rows[0].conversation_id
    logger.info({ conversationId, creatorId, memberCount: allMembers.length }, 'Conversation reused')
    return { ok: true, data: { conversationId } }
  }

  const conv = await pool.query<{ id: string }>(
    'INSERT INTO conversations (created_by) VALUES ($1) RETURNING id',
    [creatorId]
  )
  const conversationId = conv.rows[0].id

  const memberValues = allMembers
    .map((_, i) => `($1, $${i + 2})`)
    .join(', ')
  await pool.query(
    `INSERT INTO conversation_members (conversation_id, user_id) VALUES ${memberValues}`,
    [conversationId, ...allMembers]
  )

  logger.info({ conversationId, creatorId, memberCount: allMembers.length }, 'Conversation created')
  return { ok: true, data: { conversationId } }
}

export async function addConversationMembers(
  conversationId: string,
  actorId: string,
  memberIds: string[]
): Promise<ServiceResult<{ ok: true }>> {
  const membership = await pool.query(
    'SELECT 1 FROM conversation_members WHERE conversation_id = $1 AND user_id = $2',
    [conversationId, actorId]
  )
  if (membership.rowCount === 0) {
    return { ok: false, status: 403, error: 'Not a member of this conversation' }
  }

  const blockCheck = await pool.query(
    `SELECT blocked_id FROM blocks
     WHERE (blocker_id = $1 AND blocked_id = ANY($2))
        OR (blocked_id = $1 AND blocker_id = ANY($2))`,
    [actorId, memberIds]
  )
  if (blockCheck.rows.length > 0) {
    return { ok: false, status: 403, error: 'Cannot add blocked users' }
  }

  for (const memberId of memberIds) {
    await pool.query(
      `INSERT INTO conversation_members (conversation_id, user_id)
       VALUES ($1, $2) ON CONFLICT DO NOTHING`,
      [conversationId, memberId]
    )
  }

  return { ok: true, data: { ok: true } }
}

interface InboxConversation {
  id: string
  lastMessageAt: string | null
  createdAt: string
  unreadCount: number
  members: { id: string; username: string; displayName: string | null; avatar: string | null }[]
}

export async function listInbox(userId: string): Promise<InboxConversation[]> {
  const { rows } = await pool.query<{
    conversation_id: string
    last_message_at: Date | null
    created_at: Date
    unread_count: number
    member_ids: string[]
    member_usernames: string[]
    member_display_names: (string | null)[]
    member_avatars: (string | null)[]
  }>(
    // Mute filter uses array_agg FILTER so a muted member drops from the
    // listed members of a group convo without dropping the whole conversation
    // (the old WHERE m.muter_id IS NULL filtered pre-aggregate and took the
    // convo with it). HAVING drops 1:1 DMs when the sole counterparty is
    // muted. Blocks mirror the send path: a convo with any member who has
    // blocked the viewer disappears, because send would 403 anyway.
    `SELECT c.id AS conversation_id, c.last_message_at, c.created_at,
            COALESCE(unread.cnt, 0)::int AS unread_count,
            COALESCE(array_agg(a.id) FILTER (WHERE m.muter_id IS NULL), '{}'::uuid[]) AS member_ids,
            COALESCE(array_agg(a.username) FILTER (WHERE m.muter_id IS NULL), '{}'::text[]) AS member_usernames,
            COALESCE(array_agg(a.display_name) FILTER (WHERE m.muter_id IS NULL), '{}'::text[]) AS member_display_names,
            COALESCE(array_agg(a.avatar_blossom_url) FILTER (WHERE m.muter_id IS NULL), '{}'::text[]) AS member_avatars
     FROM conversations c
     JOIN conversation_members cm ON cm.conversation_id = c.id
     JOIN conversation_members my ON my.conversation_id = c.id AND my.user_id = $1
     JOIN accounts a ON a.id = cm.user_id AND a.id != $1
     LEFT JOIN LATERAL (
       SELECT COUNT(*) AS cnt FROM direct_messages
       WHERE conversation_id = c.id AND recipient_id = $1 AND read_at IS NULL
     ) unread ON true
     LEFT JOIN mutes m ON m.muter_id = $1 AND m.muted_id = cm.user_id
     WHERE NOT EXISTS (
       SELECT 1 FROM conversation_members cmb
       JOIN blocks b ON b.blocker_id = cmb.user_id
       WHERE cmb.conversation_id = c.id
         AND cmb.user_id != $1
         AND b.blocked_id = $1
     )
     GROUP BY c.id, unread.cnt
     HAVING COUNT(*) FILTER (WHERE m.muter_id IS NULL) > 0
     ORDER BY COALESCE(c.last_message_at, c.created_at) DESC
     LIMIT 50`,
    [userId]
  )

  return rows.map(r => ({
    id: r.conversation_id,
    lastMessageAt: r.last_message_at?.toISOString() ?? null,
    createdAt: r.created_at.toISOString(),
    unreadCount: r.unread_count,
    members: r.member_ids.map((id, i) => ({
      id,
      username: r.member_usernames[i],
      displayName: r.member_display_names[i],
      avatar: r.member_avatars[i],
    })),
  }))
}

interface ConversationMessage {
  id: string
  senderId: string
  senderUsername: string | null
  senderDisplayName: string | null
  counterpartyPubkey: string
  contentEnc: string
  replyTo: {
    id: string
    senderUsername: string | null
    contentEnc: string | null
    counterpartyPubkey: string | null
  } | null
  readAt: string | null
  createdAt: string
  likeCount: number
  likedByMe: boolean
}

export async function loadConversationMessages(
  conversationId: string,
  userId: string,
  limit: number,
  before?: string
): Promise<ServiceResult<{ messages: ConversationMessage[]; nextCursor: string | null }>> {
  const membership = await pool.query(
    'SELECT 1 FROM conversation_members WHERE conversation_id = $1 AND user_id = $2',
    [conversationId, userId]
  )
  if (membership.rowCount === 0) {
    return { ok: false, status: 403, error: 'Not a member of this conversation' }
  }

  // Group-DM shape: one logical send produces N rows (one per recipient). The
  // outer WHERE matches any row where the viewer is sender or recipient, which
  // for the sender's own group message hits N rows. DISTINCT ON (send_id)
  // collapses that to one row per logical send, preferring the row addressed
  // to the viewer so their key can decrypt content_enc via NIP-44.
  const params: any[] = [conversationId, userId, limit]
  let whereClause = 'dm.conversation_id = $1 AND (dm.recipient_id = $2 OR dm.sender_id = $2)'
  if (before) {
    params.push(before)
    whereClause += ` AND dm.created_at < $4`
  }

  const { rows } = await pool.query<{
    id: string
    sender_id: string
    sender_username: string | null
    sender_display_name: string | null
    sender_pubkey: string
    recipient_pubkey: string
    content_enc: string
    reply_to_id: string | null
    reply_to_sender_username: string | null
    reply_to_content_enc: string | null
    reply_to_counterparty_pubkey: string | null
    read_at: Date | null
    created_at: Date
    like_count: string
    liked_by_me: boolean
  }>(
    `SELECT * FROM (
       SELECT DISTINCT ON (dm.send_id)
              dm.id, dm.sender_id, sa.username AS sender_username,
              sa.display_name AS sender_display_name,
              sa.nostr_pubkey AS sender_pubkey,
              ra.nostr_pubkey AS recipient_pubkey,
              dm.content_enc, dm.reply_to_id, dm.read_at, dm.created_at,
              rsa.username AS reply_to_sender_username,
              rdm.content_enc AS reply_to_content_enc,
              CASE WHEN rdm.sender_id = $2 THEN rra.nostr_pubkey ELSE rsa.nostr_pubkey END AS reply_to_counterparty_pubkey,
              (SELECT COUNT(*) FROM dm_reactions dr WHERE dr.message_id = dm.id AND dr.reaction_type = 'like') AS like_count,
              EXISTS(SELECT 1 FROM dm_reactions dr WHERE dr.message_id = dm.id AND dr.user_id = $2 AND dr.reaction_type = 'like') AS liked_by_me
       FROM direct_messages dm
       JOIN accounts sa ON sa.id = dm.sender_id
       JOIN accounts ra ON ra.id = dm.recipient_id
       LEFT JOIN direct_messages rdm ON rdm.id = dm.reply_to_id
       LEFT JOIN accounts rsa ON rsa.id = rdm.sender_id
       LEFT JOIN accounts rra ON rra.id = rdm.recipient_id
       WHERE ${whereClause}
       ORDER BY dm.send_id,
                CASE WHEN dm.recipient_id = $2 THEN 0 ELSE 1 END,
                dm.id
     ) m
     ORDER BY m.created_at DESC
     LIMIT $3`,
    params
  )

  const nextCursor = rows.length === limit
    ? rows[rows.length - 1].created_at.toISOString()
    : null

  const messages = rows.map<ConversationMessage>(r => ({
    id: r.id,
    senderId: r.sender_id,
    senderUsername: r.sender_username,
    senderDisplayName: r.sender_display_name,
    counterpartyPubkey: r.sender_id === userId ? r.recipient_pubkey : r.sender_pubkey,
    contentEnc: r.content_enc,
    replyTo: r.reply_to_id ? {
      id: r.reply_to_id,
      senderUsername: r.reply_to_sender_username,
      contentEnc: r.reply_to_content_enc,
      counterpartyPubkey: r.reply_to_counterparty_pubkey,
    } : null,
    readAt: r.read_at?.toISOString() ?? null,
    createdAt: r.created_at.toISOString(),
    likeCount: parseInt(r.like_count, 10),
    likedByMe: r.liked_by_me,
  }))

  return { ok: true, data: { messages, nextCursor } }
}

// -----------------------------------------------------------------------------
// Send / read / like
// -----------------------------------------------------------------------------

type SendMessageResult =
  | { ok: true; data: { messageIds: string[]; skippedRecipientIds: string[] } }
  | { ok: false; status: 403 | 400; error: string }

export async function sendMessage(
  conversationId: string,
  senderId: string,
  content: string,
  replyToId: string | null
): Promise<SendMessageResult> {
  const membership = await pool.query(
    'SELECT 1 FROM conversation_members WHERE conversation_id = $1 AND user_id = $2',
    [conversationId, senderId]
  )
  if (membership.rowCount === 0) {
    return { ok: false, status: 403, error: 'Not a member of this conversation' }
  }

  const members = await pool.query<{ user_id: string }>(
    'SELECT user_id FROM conversation_members WHERE conversation_id = $1 AND user_id != $2',
    [conversationId, senderId]
  )
  if (members.rows.length === 0) {
    return { ok: false, status: 400, error: 'No recipients in conversation' }
  }

  const recipientIds = members.rows.map(r => r.user_id)

  const blockCheck = await pool.query(
    `SELECT blocker_id FROM blocks
     WHERE blocker_id = ANY($1) AND blocked_id = $2`,
    [recipientIds, senderId]
  )
  if (blockCheck.rows.length > 0) {
    return { ok: false, status: 403, error: 'You are blocked by one or more recipients' }
  }

  const pubkeyRows = await pool.query<{ id: string; nostr_pubkey: string | null }>(
    'SELECT id, nostr_pubkey FROM accounts WHERE id = ANY($1)',
    [recipientIds]
  )
  const pubkeyMap = new Map(pubkeyRows.rows.map(r => [r.id, r.nostr_pubkey]))

  // Filter out recipients with no pubkey before the encrypt round-trip — they
  // can't receive the message regardless. Preserves the original recipientIds
  // order so encryption result indices line up with deliverable rows. Skipped
  // IDs are returned to the caller so it can distinguish full success from
  // partial delivery (e.g. surface a warning to the sender).
  const deliverable: { recipientId: string; recipientPubkey: string }[] = []
  const skippedRecipientIds: string[] = []
  for (const recipientId of recipientIds) {
    const pubkey = pubkeyMap.get(recipientId)
    if (pubkey) {
      deliverable.push({ recipientId, recipientPubkey: pubkey })
    } else {
      logger.error({ recipientId }, 'Recipient has no pubkey — skipping')
      skippedRecipientIds.push(recipientId)
    }
  }
  if (deliverable.length === 0) {
    return { ok: false, status: 400, error: 'No deliverable recipients' }
  }

  // One key-custody round-trip for the whole send — the service decrypts the
  // sender's private key once and encrypts the plaintext for all recipients
  // in-process.
  const { ciphertexts } = await nip44EncryptBatch(
    senderId,
    deliverable.map(d => d.recipientPubkey),
    content,
  )

  // One send_id per logical send, shared across all N per-recipient rows, so
  // the sender's own view can DISTINCT ON (send_id) and see their message
  // once rather than N times. All INSERTs + the conversation bump go in a
  // single transaction so a partial send never leaves some recipients with
  // the message and others without.
  const sendId = randomUUID()
  const messageIds = await withTransaction(async (client) => {
    // Single multi-row INSERT so N recipients = 1 round-trip instead of N.
    // Build $1, $2, ... placeholders for each recipient row.
    const placeholders: string[] = []
    const values: unknown[] = []
    deliverable.forEach((d, i) => {
      const base = i * 6
      placeholders.push(
        `($${base + 1}, $${base + 2}, $${base + 3}, $${base + 4}, $${base + 5}, $${base + 6})`
      )
      values.push(conversationId, senderId, d.recipientId, ciphertexts[i], replyToId, sendId)
    })

    const inserted = await client.query<{ id: string }>(
      `INSERT INTO direct_messages
         (conversation_id, sender_id, recipient_id, content_enc, reply_to_id, send_id)
       VALUES ${placeholders.join(', ')}
       RETURNING id`,
      values,
    )

    await client.query(
      'UPDATE conversations SET last_message_at = now() WHERE id = $1',
      [conversationId]
    )

    return inserted.rows.map(r => r.id)
  })

  publishConversationPulse(senderId, conversationId).catch(err => {
    logger.error({ err, conversationId }, 'Conversation-pulse publish failed (non-fatal)')
  })

  return { ok: true, data: { messageIds, skippedRecipientIds } }
}

export async function markMessageRead(
  messageId: string,
  userId: string
): Promise<ServiceResult<{ ok: true }>> {
  const result = await pool.query(
    `UPDATE direct_messages SET read_at = now()
     WHERE id = $1 AND recipient_id = $2 AND read_at IS NULL
     RETURNING id`,
    [messageId, userId]
  )
  if (result.rowCount === 0) {
    return { ok: false, status: 404, error: 'Message not found' }
  }
  return { ok: true, data: { ok: true } }
}

export async function markConversationReadAll(
  conversationId: string,
  userId: string
): Promise<ServiceResult<{ markedRead: number }>> {
  const membership = await pool.query(
    'SELECT 1 FROM conversation_members WHERE conversation_id = $1 AND user_id = $2',
    [conversationId, userId]
  )
  if (membership.rowCount === 0) {
    return { ok: false, status: 403, error: 'Not a member of this conversation' }
  }

  const result = await pool.query(
    `UPDATE direct_messages SET read_at = now()
     WHERE conversation_id = $1 AND recipient_id = $2 AND read_at IS NULL`,
    [conversationId, userId]
  )
  return { ok: true, data: { markedRead: result.rowCount ?? 0 } }
}

// App-controlled reaction vocabulary (no DB CHECK — see migration 122). The web
// surface currently only emits 'like' (a heart); the rest are schema-ready for a
// future reaction picker.
export const DM_REACTION_TYPES = ['like', 'love', 'laugh', 'wow', 'sad', 'angry'] as const
export type DmReactionType = (typeof DM_REACTION_TYPES)[number]

export async function toggleMessageReaction(
  messageId: string,
  userId: string,
  reactionType: DmReactionType = 'like'
): Promise<ServiceResult<{ reacted: boolean }>> {
  const membership = await pool.query(
    `SELECT 1 FROM direct_messages dm
     JOIN conversation_members cm ON cm.conversation_id = dm.conversation_id AND cm.user_id = $2
     WHERE dm.id = $1`,
    [messageId, userId]
  )
  if (membership.rowCount === 0) {
    return { ok: false, status: 403, error: 'Not a participant' }
  }

  // DELETE-then-INSERT, wrapped in one txn, so a concurrent toggle can't leave a
  // half-applied state; the unique-violation race (two inserts of the same
  // (message,user,type)) resolves to "reacted".
  return withTransaction(async (client) => {
    const existing = await client.query(
      'DELETE FROM dm_reactions WHERE message_id = $1 AND user_id = $2 AND reaction_type = $3 RETURNING id',
      [messageId, userId, reactionType]
    )
    if ((existing.rowCount ?? 0) > 0) {
      return { ok: true, data: { reacted: false } }
    }
    try {
      await client.query(
        'INSERT INTO dm_reactions (message_id, user_id, reaction_type) VALUES ($1, $2, $3)',
        [messageId, userId, reactionType]
      )
    } catch (err) {
      if ((err as { code?: string }).code === '23505') {
        return { ok: true, data: { reacted: true } }
      }
      throw err
    }
    return { ok: true, data: { reacted: true } }
  })
}

// -----------------------------------------------------------------------------
// Decrypt
// -----------------------------------------------------------------------------

interface DecryptRequest {
  id: string
  counterpartyPubkey: string
  ciphertext: string
}

interface DecryptResult {
  id: string
  plaintext: string | null
  error?: string
}

export async function decryptBatch(
  readerId: string,
  messages: DecryptRequest[]
): Promise<DecryptResult[]> {
  const results = await Promise.allSettled(
    messages.map(async (msg) => {
      const { plaintext } = await nip44Decrypt(readerId, msg.counterpartyPubkey, msg.ciphertext)
      return { id: msg.id, plaintext }
    })
  )
  return results.map((r, i) =>
    r.status === 'fulfilled'
      ? r.value
      : { id: messages[i].id, plaintext: null, error: 'Decryption failed' }
  )
}

// -----------------------------------------------------------------------------
// DM pricing
// -----------------------------------------------------------------------------

interface DmPricingSummary {
  defaultPricePence: number
  overrides: {
    userId: string
    username: string
    displayName: string | null
    pricePence: number
  }[]
}

export async function getDmPricing(ownerId: string): Promise<DmPricingSummary> {
  const defaultRow = await pool.query<{ price_pence: number }>(
    'SELECT price_pence FROM dm_pricing WHERE owner_id = $1 AND target_id IS NULL',
    [ownerId]
  )

  const overrides = await pool.query<{ target_id: string; username: string; display_name: string | null; price_pence: number }>(
    `SELECT dp.target_id, a.username, a.display_name, dp.price_pence
     FROM dm_pricing dp
     JOIN accounts a ON a.id = dp.target_id
     WHERE dp.owner_id = $1 AND dp.target_id IS NOT NULL
     ORDER BY a.username`,
    [ownerId]
  )

  return {
    defaultPricePence: defaultRow.rows[0]?.price_pence ?? 0,
    overrides: overrides.rows.map(r => ({
      userId: r.target_id,
      username: r.username,
      displayName: r.display_name,
      pricePence: r.price_pence,
    })),
  }
}

export async function setDefaultDmPrice(ownerId: string, defaultPricePence: number): Promise<void> {
  if (defaultPricePence === 0) {
    await pool.query(
      'DELETE FROM dm_pricing WHERE owner_id = $1 AND target_id IS NULL',
      [ownerId]
    )
  } else {
    await pool.query(
      `INSERT INTO dm_pricing (owner_id, target_id, price_pence)
       VALUES ($1, NULL, $2)
       ON CONFLICT (owner_id) WHERE target_id IS NULL
       DO UPDATE SET price_pence = $2`,
      [ownerId, defaultPricePence]
    )
  }
  logger.info({ ownerId, defaultPricePence }, 'DM pricing updated')
}

export async function setDmPriceOverride(
  ownerId: string,
  targetUserId: string,
  pricePence: number
): Promise<void> {
  if (pricePence === 0) {
    await pool.query(
      'DELETE FROM dm_pricing WHERE owner_id = $1 AND target_id = $2',
      [ownerId, targetUserId]
    )
  } else {
    await pool.query(
      `INSERT INTO dm_pricing (owner_id, target_id, price_pence)
       VALUES ($1, $2, $3)
       ON CONFLICT (owner_id, target_id)
       DO UPDATE SET price_pence = $3`,
      [ownerId, targetUserId, pricePence]
    )
  }
}

export async function removeDmPriceOverride(ownerId: string, targetUserId: string): Promise<void> {
  await pool.query(
    'DELETE FROM dm_pricing WHERE owner_id = $1 AND target_id = $2',
    [ownerId, targetUserId]
  )
}

// Publishes a "conversation pulse" — an empty kind-14 carrying only the
// internal conversation id. This is NOT NIP-17. Real NIP-17 requires a
// kind-13 seal around the content and a kind-1059 gift-wrap per recipient
// (content remains encrypted at rest on the relay). The pulse exists only
// so clients watching the relay can see "this conversation had activity at
// time T" without content; real message content lives in `direct_messages`
// as NIP-44 ciphertexts. If/when proper gift-wrap ships it should be a
// separate function — do not expand this one.
async function publishConversationPulse(senderId: string, conversationId: string): Promise<void> {
  try {
    const event = await signEvent(senderId, {
      kind: 14,
      content: '',
      tags: [['conversation', conversationId]],
      created_at: Math.floor(Date.now() / 1000),
    })
    await withTransaction(async (client) => {
      await enqueueRelayPublish(client, {
        entityType: 'conversation_pulse',
        signedEvent: event as SignedNostrEvent,
      })
    })
    logger.debug({ conversationId, eventId: event.id }, 'Conversation pulse enqueued')
  } catch (err) {
    logger.error({ err, conversationId }, 'Failed to enqueue conversation pulse')
  }
}
