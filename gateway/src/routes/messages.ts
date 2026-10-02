import { UUID_RE } from "../lib/uuid.js";
import type { FastifyInstance, FastifyReply } from 'fastify'
import { z } from 'zod'
import { requireAuth } from '../middleware/auth.js'
import * as messages from '../services/messages.js'
import { isUuid, parseLimit } from '../lib/request-inputs.js'
import { zodValidationError } from '@platform-pub/shared/lib/validation.js'
import { dmPricingEnabled } from '@platform-pub/shared/lib/env.js'
import {
  containsUrl,
  DM_NO_LINKS_MESSAGE,
} from '@platform-pub/shared/lib/sanitize.js'

// =============================================================================
// Direct Message Routes — thin dispatchers over services/messages.ts
//
// POST   /conversations                             — create a conversation
// GET    /messages                                  — list conversations (inbox)
// GET    /messages/:conversationId                  — load messages in a conversation
// POST   /messages/:conversationId                  — send a DM
// POST   /messages/:messageId/read                  — mark as read
// POST   /messages/:conversationId/read-all         — mark all read
// POST   /messages/:messageId/like                  — toggle like
// POST   /dm/decrypt-batch                          — decrypt batch
// GET    /settings/dm-pricing                       — fetch DM pricing   ) all four
// PUT    /settings/dm-pricing                       — set default price   ) dark behind
// PUT    /settings/dm-pricing/override/:userId      — set per-user override ) DM_PRICING_
// DELETE /settings/dm-pricing/override/:userId      — remove override     ) ENABLED
//
// THE FOUR PRICING ROUTES ARE THE WHOLE OF THE ENTRY to the four `dm_pricing`
// service functions, so they are where the brake goes — one gate, no
// `NEXT_PUBLIC_` twin, and the web asks by reading the GET rather than carrying
// a second copy of the flag. 404 and not 403: dark means the feature is not
// here, which is the answer `DmFeeSettings` reads to decide whether it exists
// at all, and a 403 would read as "you may not" to a member who has done
// nothing. The WRITES are darkened alongside the read deliberately — a member
// holding a stale tab must not be able to save a figure that will never be
// charged. `shared/src/lib/env.ts::dmPricingEnabled` carries why it is off and
// what has to be true before anybody turns it on.
// =============================================================================

const HEX64_RE_NIP = /^[0-9a-f]{64}$/

const CreateConversationSchema = z.object({
  memberIds: z.array(z.string().regex(UUID_RE)).min(1).max(20),
})

const SendMessageSchema = z.object({
  content: z.string().min(1).max(10_000),
  replyToId: z.string().regex(UUID_RE).optional(),
})

// DIRECT MESSAGES ARE TEXT ONLY (L6.2, decision A1; D1 §5).
//
// SERVER-SIDE, because a UI that declines to draw a control is not an access
// control — the request is formable from any surface and only the route stands
// behind it (posts.md's write-path rule, learned the hard way on `POST
// /replies` and `POST /votes`). The composer's upload button being gone is the
// courtesy; this is the rule.
//
// IT IS A REFUSAL AND NOT A STRIP. Silently removing the link would deliver a
// sentence the sender did not write to a recipient who cannot tell, and the
// sender — who watched it send — would never know.
//
// ITS OWN CODE, NOT A ZOD REFINE. A refine would have ridden
// `zodValidationError`, whose `message` is prefixed with the field name
// (`"content: …"`) and whose `error` is the same `validation_failed` every
// other malformed body gets. This refusal is one the sender has to be told in
// their own words and one the web has to be able to RECOGNISE, so it carries a
// code of its own — pinned from the web side, since a string crossing this
// boundary is a claim about a server that nothing otherwise checks.
//
// The detector is `containsUrl` in `shared/lib/sanitize.ts`, beside the other
// URL rules; its header carries what it does and does not catch, and the
// dependency that makes the loose half safe — the DM thread renders plain text
// and mounts no `MediaContent`, so nothing there linkifies, embeds or fetches.
export const DM_LINKS_REFUSED = 'dm_links_not_allowed'

const DecryptBatchSchema = z.object({
  messages: z.array(z.object({
    id: z.string(),
    counterpartyPubkey: z.string().regex(HEX64_RE_NIP),
    ciphertext: z.string().min(1),
  })).min(1).max(100),
})

const DmPricingSchema = z.object({
  defaultPricePence: z.number().int().min(0).max(100_00),
})

const DmOverrideSchema = z.object({
  pricePence: z.number().int().min(0).max(100_00),
})

const ReactionSchema = z.object({
  // optional for back-compat — the heart toggle sends no body, defaulting to 'like'
  reaction_type: z.enum(messages.DM_REACTION_TYPES).default('like'),
})

function sendServiceError(reply: FastifyReply, result: Extract<messages.ServiceResult<unknown>, { ok: false }>) {
  const body: Record<string, unknown> = { error: result.error }
  if (result.details) Object.assign(body, result.details)
  return reply.status(result.status).send(body)
}

export async function messageRoutes(app: FastifyInstance) {
  app.post('/conversations', { preHandler: requireAuth }, async (req, reply) => {
    const parsed = CreateConversationSchema.safeParse(req.body)
    if (!parsed.success) return reply.status(400).send(zodValidationError(parsed.error))

    const result = await messages.createConversation(req.session!.sub, parsed.data.memberIds)
    if (!result.ok) return sendServiceError(reply, result)
    return reply.status(201).send(result.data)
  })

  app.get('/messages', { preHandler: requireAuth }, async (req, reply) => {
    const conversations = await messages.listInbox(req.session!.sub)
    return reply.status(200).send({ conversations })
  })

  app.get<{ Params: { conversationId: string }; Querystring: { before?: string; limit?: string } }>(
    '/messages/:conversationId',
    { preHandler: requireAuth },
    async (req, reply) => {
      if (!isUuid(req.params.conversationId)) {
        return reply.status(404).send({ error: 'not_found' })
      }
      const limit = parseLimit(req.query.limit, 50, 100)
      const result = await messages.loadConversationMessages(
        req.params.conversationId,
        req.session!.sub,
        limit,
        req.query.before
      )
      if (!result.ok) return sendServiceError(reply, result)
      return reply.status(200).send(result.data)
    }
  )

  app.post<{ Params: { conversationId: string } }>(
    '/messages/:conversationId',
    { preHandler: requireAuth, config: { rateLimit: { max: 10, timeWindow: '1 minute' } } },
    async (req, reply) => {
      if (!isUuid(req.params.conversationId)) {
        return reply.status(404).send({ error: 'not_found' })
      }
      const parsed = SendMessageSchema.safeParse(req.body)
      if (!parsed.success) return reply.status(400).send(zodValidationError(parsed.error))

      // Before the service call, so a refused message is never encrypted,
      // never written and never counted against the rate limit's purpose.
      if (containsUrl(parsed.data.content)) {
        return reply
          .status(400)
          .send({ error: DM_LINKS_REFUSED, message: DM_NO_LINKS_MESSAGE })
      }

      const result = await messages.sendMessage(
        req.params.conversationId,
        req.session!.sub,
        parsed.data.content,
        parsed.data.replyToId ?? null
      )
      if (!result.ok) return sendServiceError(reply, result)
      return reply.status(201).send(result.data)
    }
  )

  app.post<{ Params: { messageId: string } }>(
    '/messages/:messageId/read',
    { preHandler: requireAuth },
    async (req, reply) => {
      const result = await messages.markMessageRead(req.params.messageId, req.session!.sub)
      if (!result.ok) return sendServiceError(reply, result)
      return reply.status(200).send({ ok: true })
    }
  )

  app.post<{ Params: { conversationId: string } }>(
    '/messages/:conversationId/read-all',
    { preHandler: requireAuth },
    async (req, reply) => {
      if (!isUuid(req.params.conversationId)) {
        return reply.status(404).send({ error: 'not_found' })
      }
      const result = await messages.markConversationReadAll(req.params.conversationId, req.session!.sub)
      if (!result.ok) return sendServiceError(reply, result)
      return reply.status(200).send({ ok: true, markedRead: result.data.markedRead })
    }
  )

  app.post<{ Params: { messageId: string } }>(
    '/messages/:messageId/like',
    { preHandler: requireAuth },
    async (req, reply) => {
      const parsed = ReactionSchema.safeParse(req.body ?? {})
      if (!parsed.success) return reply.status(400).send(zodValidationError(parsed.error))
      const result = await messages.toggleMessageReaction(
        req.params.messageId,
        req.session!.sub,
        parsed.data.reaction_type
      )
      if (!result.ok) return sendServiceError(reply, result)
      // back-compat field name: web consumes `{ liked }`
      return reply.status(200).send({ liked: result.data.reacted })
    }
  )

  app.post('/dm/decrypt-batch', { preHandler: requireAuth }, async (req, reply) => {
    const parsed = DecryptBatchSchema.safeParse(req.body)
    if (!parsed.success) return reply.status(400).send(zodValidationError(parsed.error))

    const results = await messages.decryptBatch(req.session!.sub, parsed.data.messages)
    return reply.status(200).send({ results })
  })

  // Returns true when the request has been answered — call as
  // `if (dmPricingDark(reply)) return`.
  function dmPricingDark(reply: FastifyReply): boolean {
    if (dmPricingEnabled()) return false
    reply.status(404).send({ error: 'not_found' })
    return true
  }

  app.get('/settings/dm-pricing', { preHandler: requireAuth }, async (req, reply) => {
    if (dmPricingDark(reply)) return
    const pricing = await messages.getDmPricing(req.session!.sub)
    return reply.send(pricing)
  })

  app.put('/settings/dm-pricing', { preHandler: requireAuth }, async (req, reply) => {
    if (dmPricingDark(reply)) return
    const parsed = DmPricingSchema.safeParse(req.body)
    if (!parsed.success) return reply.status(400).send(zodValidationError(parsed.error))

    await messages.setDefaultDmPrice(req.session!.sub, parsed.data.defaultPricePence)
    return reply.send({ ok: true })
  })

  // The two override routes take their subject off the path, so they answer a
  // malformed id the same 404 the conversation routes above do: splitting
  // malformed from absent makes the route an oracle for which ids exist
  // (`lib/request-inputs.ts`). They were the last pair still answering 400.
  app.put('/settings/dm-pricing/override/:userId', { preHandler: requireAuth }, async (req, reply) => {
    if (dmPricingDark(reply)) return
    const userId = (req.params as { userId: string }).userId
    if (!isUuid(userId)) return reply.status(404).send({ error: 'not_found' })

    const parsed = DmOverrideSchema.safeParse(req.body)
    if (!parsed.success) return reply.status(400).send(zodValidationError(parsed.error))

    await messages.setDmPriceOverride(req.session!.sub, userId, parsed.data.pricePence)
    return reply.send({ ok: true })
  })

  app.delete('/settings/dm-pricing/override/:userId', { preHandler: requireAuth }, async (req, reply) => {
    if (dmPricingDark(reply)) return
    const userId = (req.params as { userId: string }).userId
    if (!isUuid(userId)) return reply.status(404).send({ error: 'not_found' })

    await messages.removeDmPriceOverride(req.session!.sub, userId)
    return reply.send({ ok: true })
  })
}
