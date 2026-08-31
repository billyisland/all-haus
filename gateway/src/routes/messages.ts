import { UUID_RE } from "../lib/uuid.js";
import type { FastifyInstance, FastifyReply } from 'fastify'
import { z } from 'zod'
import { requireAuth } from '../middleware/auth.js'
import * as messages from '../services/messages.js'

// =============================================================================
// Direct Message Routes — thin dispatchers over services/messages.ts
//
// POST   /conversations                             — create a conversation
// POST   /conversations/:id/members                 — add members
// GET    /messages                                  — list conversations (inbox)
// GET    /messages/:conversationId                  — load messages in a conversation
// POST   /messages/:conversationId                  — send a DM
// POST   /messages/:messageId/read                  — mark as read
// POST   /messages/:conversationId/read-all         — mark all read
// POST   /messages/:messageId/like                  — toggle like
// POST   /dm/decrypt-batch                          — decrypt batch
// GET    /settings/dm-pricing                       — fetch DM pricing
// PUT    /settings/dm-pricing                       — set default price
// PUT    /settings/dm-pricing/override/:userId      — set per-user override
// DELETE /settings/dm-pricing/override/:userId      — remove override
// =============================================================================

const HEX64_RE_NIP = /^[0-9a-f]{64}$/

const CreateConversationSchema = z.object({
  memberIds: z.array(z.string().regex(UUID_RE)).min(1).max(20),
})

const AddMembersSchema = z.object({
  memberIds: z.array(z.string().regex(UUID_RE)).min(1).max(20),
})

const SendMessageSchema = z.object({
  content: z.string().min(1).max(10_000),
  replyToId: z.string().regex(UUID_RE).optional(),
})

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
    if (!parsed.success) return reply.status(400).send({ error: parsed.error.flatten() })

    const result = await messages.createConversation(req.session!.sub, parsed.data.memberIds)
    if (!result.ok) return sendServiceError(reply, result)
    return reply.status(201).send(result.data)
  })

  app.post<{ Params: { id: string } }>(
    '/conversations/:id/members',
    { preHandler: requireAuth },
    async (req, reply) => {
      const parsed = AddMembersSchema.safeParse(req.body)
      if (!parsed.success) return reply.status(400).send({ error: parsed.error.flatten() })

      const result = await messages.addConversationMembers(req.params.id, req.session!.sub, parsed.data.memberIds)
      if (!result.ok) return sendServiceError(reply, result)
      return reply.status(200).send({ ok: true })
    }
  )

  app.get('/messages', { preHandler: requireAuth }, async (req, reply) => {
    const conversations = await messages.listInbox(req.session!.sub)
    return reply.status(200).send({ conversations })
  })

  app.get<{ Params: { conversationId: string }; Querystring: { before?: string; limit?: string } }>(
    '/messages/:conversationId',
    { preHandler: requireAuth },
    async (req, reply) => {
      const limit = Math.min(parseInt(req.query.limit ?? '50', 10), 100)
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
      const parsed = SendMessageSchema.safeParse(req.body)
      if (!parsed.success) return reply.status(400).send({ error: parsed.error.flatten() })

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
      if (!parsed.success) return reply.status(400).send({ error: parsed.error.flatten() })
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
    if (!parsed.success) return reply.status(400).send({ error: parsed.error.flatten() })

    const results = await messages.decryptBatch(req.session!.sub, parsed.data.messages)
    return reply.status(200).send({ results })
  })

  app.get('/settings/dm-pricing', { preHandler: requireAuth }, async (req, reply) => {
    const pricing = await messages.getDmPricing(req.session!.sub)
    return reply.send(pricing)
  })

  app.put('/settings/dm-pricing', { preHandler: requireAuth }, async (req, reply) => {
    const parsed = DmPricingSchema.safeParse(req.body)
    if (!parsed.success) return reply.status(400).send({ error: parsed.error.flatten() })

    await messages.setDefaultDmPrice(req.session!.sub, parsed.data.defaultPricePence)
    return reply.send({ ok: true })
  })

  app.put('/settings/dm-pricing/override/:userId', { preHandler: requireAuth }, async (req, reply) => {
    const userId = (req.params as { userId: string }).userId
    if (!UUID_RE.test(userId)) return reply.status(400).send({ error: 'Invalid user ID' })

    const parsed = DmOverrideSchema.safeParse(req.body)
    if (!parsed.success) return reply.status(400).send({ error: parsed.error.flatten() })

    await messages.setDmPriceOverride(req.session!.sub, userId, parsed.data.pricePence)
    return reply.send({ ok: true })
  })

  app.delete('/settings/dm-pricing/override/:userId', { preHandler: requireAuth }, async (req, reply) => {
    const userId = (req.params as { userId: string }).userId
    if (!UUID_RE.test(userId)) return reply.status(400).send({ error: 'Invalid user ID' })

    await messages.removeDmPriceOverride(req.session!.sub, userId)
    return reply.send({ ok: true })
  })
}
