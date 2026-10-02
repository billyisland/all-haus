import { randomUUID } from 'node:crypto'
import { pool, withTransaction } from '@platform-pub/shared/db/client.js'
import { nip44EncryptBatch, nip44DecryptBatch } from '../lib/key-custody-client.js'
import logger from '@platform-pub/shared/lib/logger.js'
import { parseTimestampCursor } from '@platform-pub/shared/lib/timestamp-cursor.js'
import { blockExistsWithAny, blockPairSql } from '../lib/blocks.js'

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
  // Distinct: `(conversation_id, user_id)` is the membership PK, so a repeated
  // id in the request reached the INSERT as a unique violation and answered
  // 500 (CA-D7). A set, not a refusal — naming a friend twice is not a mistake
  // worth telling anybody about.
  const allMembers = [creatorId, ...new Set(memberIds.filter(id => id !== creatorId))]

  // Blocks, BOTH ways, through the one home — see lib/blocks.ts. One neutral
  // refusal, so neither party learns which way the block runs.
  if (await blockExistsWithAny(creatorId, memberIds)) {
    return { ok: false, status: 403, error: "You can't start a conversation with one of these people." }
  }

  // Conversation identity is the participant set, not a fresh UUID: reuse an
  // existing conversation whose members are *exactly* allMembers (no more, no
  // fewer) so a second message to the same friend continues the existing thread
  // instead of spawning a duplicate. (Member set is unique per conversation —
  // (conversation_id, user_id) is the PK — so array_agg yields the exact set.)
  //
  // The read and the two writes are ONE transaction under a per-member-set
  // advisory lock, and both halves of that are load-bearing. Unlocked, two
  // concurrent "message this friend" presses both miss the reuse lookup and
  // mint two conversations for the same pair — the exact duplicate this
  // function exists to prevent, reachable by a double-click. Un-transacted, a
  // failure between the `conversations` INSERT and the `conversation_members`
  // one leaves a conversation with NO members: invisible to every list (they
  // all join through membership), unreachable, and permanent. Same shape as
  // `addSource`'s owner-scoped lock serialising a read-then-write.
  const sortedMembers = [...allMembers].sort()
  return withTransaction(async (client) => {
    await client.query('SELECT pg_advisory_xact_lock(hashtext($1))', [sortedMembers.join(',')])

    const existing = await client.query<{ conversation_id: string }>(
      // Only conversations the first member is IN can match the exact set
      // (CA-G3): pre-filtered through idx_conv_members_user, the grouping runs
      // over that member's conversations rather than every membership row on
      // the platform, under the advisory lock.
      `SELECT conversation_id
         FROM conversation_members
        WHERE conversation_id IN (
          SELECT conversation_id FROM conversation_members
           WHERE user_id = ($1::uuid[])[1]
        )
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

    const conv = await client.query<{ id: string }>(
      'INSERT INTO conversations (created_by) VALUES ($1) RETURNING id',
      [creatorId]
    )
    const conversationId = conv.rows[0].id

    const memberValues = allMembers
      .map((_, i) => `($1, $${i + 2})`)
      .join(', ')
    await client.query(
      `INSERT INTO conversation_members (conversation_id, user_id) VALUES ${memberValues}`,
      [conversationId, ...allMembers]
    )

    logger.info({ conversationId, creatorId, memberCount: allMembers.length }, 'Conversation created')
    return { ok: true, data: { conversationId } }
  })
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
    // muted. Blocks mirror the send path, BOTH ways and through the one home
    // (lib/blocks.ts): a convo with any member the viewer is block-paired with
    // disappears, because every send into it would 403 anyway.
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
       WHERE cmb.conversation_id = c.id
         AND cmb.user_id != $1
         AND ${blockPairSql('$1', 'cmb.user_id')}
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
    return { ok: false, status: 403, error: "You're not part of this conversation." }
  }

  // Group-DM shape: one logical send produces N rows (one per recipient). The
  // outer WHERE matches any row where the viewer is sender or recipient, which
  // for the sender's own group message hits N rows. DISTINCT ON (send_id)
  // collapses that to one row per logical send, preferring the row addressed
  // to the viewer so their key can decrypt content_enc via NIP-44.
  const params: any[] = [conversationId, userId, limit]
  let whereClause = 'dm.conversation_id = $1 AND (dm.recipient_id = $2 OR dm.sender_id = $2)'
  if (before) {
    // Carried as `created_at::text`, fed back as `$4::timestamptz` — the value
    // is never a JS Date, which holds milliseconds where timestamptz holds
    // microseconds. Descending cursor, `<`: truncating down would SKIP the
    // messages inside the lost microsecond, not repeat them. See the header of
    // shared/lib/timestamp-cursor.ts.
    const cursor = parseTimestampCursor(before)
    if (!cursor) {
      return { ok: false, status: 400, error: 'Invalid cursor' }
    }
    params.push(cursor)
    whereClause += ` AND dm.created_at < $4::timestamptz`
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
    created_at_exact: string
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
              dm.created_at::text AS created_at_exact,
              rsa.username AS reply_to_sender_username,
              rdm.content_enc AS reply_to_content_enc,
              CASE WHEN rdm.sender_id = $2 THEN rra.nostr_pubkey ELSE rsa.nostr_pubkey END AS reply_to_counterparty_pubkey,
              (SELECT COUNT(*) FROM dm_reactions dr WHERE dr.message_id = dm.id AND dr.reaction_type = 'like') AS like_count,
              EXISTS(SELECT 1 FROM dm_reactions dr WHERE dr.message_id = dm.id AND dr.user_id = $2 AND dr.reaction_type = 'like') AS liked_by_me
       FROM direct_messages dm
       JOIN accounts sa ON sa.id = dm.sender_id
       JOIN accounts ra ON ra.id = dm.recipient_id
       -- Scoped to the conversation, so a reply_to_id written before the send
       -- guard (CA-D7) cannot surface another conversation's message here.
       LEFT JOIN direct_messages rdm ON rdm.id = dm.reply_to_id
                                    AND rdm.conversation_id = dm.conversation_id
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
    ? rows[rows.length - 1].created_at_exact
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
    return { ok: false, status: 403, error: "You're not part of this conversation." }
  }

  // A reply names a message IN THIS CONVERSATION, or nothing (CA-D7). Unchecked,
  // a known id from somebody else's conversation was stored and then JOINED on
  // read — returning that message's ciphertext, its sender's username and the
  // counterparty's pubkey to every member here — and an unknown id hit the FK
  // and answered 500. One answer for both, so the refusal is not an oracle for
  // which message ids exist. Asked before the key-custody round-trip.
  if (replyToId) {
    const target = await pool.query(
      'SELECT 1 FROM direct_messages WHERE id = $1 AND conversation_id = $2',
      [replyToId, conversationId]
    )
    if (target.rowCount === 0) {
      return { ok: false, status: 400, error: 'That message is not in this conversation' }
    }
  }

  const members = await pool.query<{ user_id: string }>(
    'SELECT user_id FROM conversation_members WHERE conversation_id = $1 AND user_id != $2',
    [conversationId, senderId]
  )
  if (members.rows.length === 0) {
    return { ok: false, status: 400, error: "There's nobody in this conversation who can receive that." }
  }

  const recipientIds = members.rows.map(r => r.user_id)

  // Blocks, BOTH ways — see lib/blocks.ts for why the second direction is the
  // one that mattered here. This asked only "did a recipient block me?", so a
  // blocker could keep sending one-way messages to somebody who could not
  // reply; the block made the other party mute rather than making the pair
  // silent. The old copy ("You are blocked by one or more recipients") also
  // named the direction, which discloses to whichever party did NOT set the
  // block both that one exists and who set it.
  if (await blockExistsWithAny(senderId, recipientIds)) {
    return { ok: false, status: 403, error: "You can't send messages to this conversation." }
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
    return { ok: false, status: 400, error: "There's nobody in this conversation who can receive that." }
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
    return { ok: false, status: 404, error: "We couldn't find that message." }
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
    return { ok: false, status: 403, error: "You're not part of this conversation." }
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
    return { ok: false, status: 403, error: "You're not part of this conversation." }
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

/**
 * ONE HOP PER CHUNK, NOT PER MESSAGE.
 *
 * This fanned out one key-custody request per message, which is fine for a
 * page of a thread and is not fine for the export (L7.1), where the batch is a
 * member's whole history: key-custody's per-signer budget is 120/min
 * (`key-custody/src/lib/rate-limit.ts`), so past that point every remaining
 * message came back `plaintext: null` — an archive whose tail is a column of
 * failures, which reads as "these messages are corrupt" rather than "we asked
 * too fast". The chunk bound is key-custody's own schema cap, and the chunks go
 * sequentially: the point is to stop hammering the service, so issuing them all
 * at once would put the fan-out back one level up.
 *
 * A PARTIAL OUTCOME IS NOT A TOTAL ONE. A chunk that throws — the service down,
 * the budget spent — fails only its own messages, each carrying the error, and
 * the loop continues; one bad ciphertext inside a chunk fails only itself. The
 * caller sees which messages it did not get, never a short list it might read
 * as the whole.
 */
export async function decryptBatch(
  readerId: string,
  messages: DecryptRequest[]
): Promise<DecryptResult[]> {
  const CHUNK = 500
  const out: DecryptResult[] = []

  for (let i = 0; i < messages.length; i += CHUNK) {
    const chunk = messages.slice(i, i + CHUNK)
    try {
      // The reader decrypts with their OWN key, so actor and owner are the
      // same account here (L6.6, `key_access_log`). Stated rather than
      // defaulted — see key-custody-client.
      const { results } = await nip44DecryptBatch(
        readerId,
        chunk.map(m => ({ senderPubkey: m.counterpartyPubkey, ciphertext: m.ciphertext })),
        readerId,
      )
      chunk.forEach((msg, j) => {
        const plaintext = results[j]?.plaintext ?? null
        out.push(
          plaintext === null
            ? { id: msg.id, plaintext: null, error: "Couldn't decrypt that message." }
            : { id: msg.id, plaintext }
        )
      })
    } catch {
      for (const msg of chunk) {
        out.push({ id: msg.id, plaintext: null, error: "Couldn't decrypt that message." })
      }
    }
  }

  return out
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
