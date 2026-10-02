import type { FastifyInstance, FastifyRequest } from 'fastify'
import { z } from 'zod'
import { requireAuth } from '../middleware/auth.js'
import { canWrite, writerAccessRefusal } from '../lib/writer-gate.js'
import { signEvent, unwrapKey } from '../lib/key-custody-client.js'
import { enqueueRelayPublish, type SignedNostrEvent } from '@platform-pub/shared/lib/relay-outbox.js'
import { pool, withTransaction } from '@platform-pub/shared/db/client.js'
import logger from '@platform-pub/shared/lib/logger.js'
import { publicationsEnabled } from '@platform-pub/shared/lib/env.js'
import { zodValidationError } from '@platform-pub/shared/lib/validation.js'

// =============================================================================
// Signing Routes
//
// The gateway's signing service. Delegates all private-key operations to the
// key-custody service — the gateway never sees ACCOUNT_KEY_HEX.
//
//   POST /sign          — Sign a Nostr event with the writer's custodial key.
//   POST /unwrap-key    — Decrypt a NIP-44 wrapped content key for a reader.
//
// WHAT THE BROWSER MAY ASK FOR (MIRROR-AUDIT §3 *Security*, S15). This is the
// one route on which a logged-in member spends the platform's custody of their
// key on a template THEY compose, so what it accepts is the whole of its
// contract. It used to accept any kind, any tags and any `created_at`.
//
// The kind is an ALLOW-LIST, not a deny-list, and it is short because the client
// only ever asks for three things (`web/src/lib/sign.ts` and its two callers):
// a note, a deletion, and a NIP-23 article. Everything else the platform signs —
// the kind 0/3/10002 discovery set, the kind-24242 Blossom auth, publication
// events — is composed SERVER-side and goes straight to `signEvent`, never
// through here. So a deny-list would have to grow every time NIP-01 does, while
// the allow-list is complete by construction: nothing the product does needs a
// fourth entry, and the day something does, adding it is the moment to ask
// whether the browser should be composing it.
//
// The `created_at` window is not tidiness either. A replaceable event (kind
// 30023) is superseded only by one with a LATER `created_at`, so an article
// signed a century into the future is an article its own author can never edit
// again — permanently, silently, with the relay behaving exactly as specified.
// The far end has the mirror-image bound already (strfry's
// `rejectEventsOlderThanSeconds`, ten years), which catches the backdated half
// and nothing else.
// =============================================================================

/**
 * Per-member budget on the custodial key, keyed on the SESSION and not on the
 * ip. Behind nginx every request arrives from one hop, so an ip-keyed bucket is
 * one bucket for the whole platform — one member publishing would 429 everybody
 * else's replies, which is the shape S7 had to unpick on key-service.
 *
 * `hook: 'preHandler'` is what makes that possible and is NOT decoration. The
 * limiter's default hook is `onRequest`, which runs before `requireAuth` — so
 * `req.session` is undefined when the key is generated, every request falls
 * through to `req.ip`, and the per-member bucket silently collapses into the
 * platform-wide one it was written to avoid. It reads as working: the limiter
 * limits, the routes answer, and only a test driving TWO members through one
 * instance can tell the two apart. @fastify/rate-limit appends its hook to the
 * route's existing `preHandler` chain, so at `preHandler` the session is there
 * (pinned by the second-member case in `gateway/tests/signing-guard.test.ts`).
 *
 * Generous: a paywalled publish signs twice, an archive import signs once per
 * piece, and flicking through a thread posting replies must never meet this.
 */
const signingLimit = {
  rateLimit: {
    max: 120,
    timeWindow: '1 minute',
    hook: 'preHandler' as const,
    keyGenerator: (req: FastifyRequest) => req.session?.sub ?? req.ip,
  },
}

/** Kinds a browser may ask the custodial key to sign. See the header. */
export const CLIENT_SIGNABLE_KINDS = new Set([
  1,      // NIP-01 short text note (notes, comments, replies)
  5,      // NIP-09 deletion (tombstone for a note or an article)
  30023,  // NIP-23 long-form article
])

/** How far a client-supplied `created_at` may sit from now, either way. Wide
 *  enough for a wrong clock on the member's laptop, narrow enough that neither
 *  half of the replaceable-event trap above is reachable. */
export const CREATED_AT_MAX_SKEW_SECONDS = 3600

const SignEventSchema = z.object({
  kind: z.number().int().refine(k => CLIENT_SIGNABLE_KINDS.has(k), {
    message: 'kind not signable from a client',
  }),
  content: z.string(),
  tags: z.array(z.array(z.string())),
  created_at: z.number().int().optional(),
  publicationId: z.string().uuid().optional(),
})

/**
 * Everything the two signing routes check before a private key is touched, in
 * one place — they are two copies of one contract, and a guard added to one of
 * them alone is the shape this file already shipped once (the publication
 * ownership check is duplicated below because it predates this helper; the
 * checks that decide whether to sign at all do not get to be duplicated).
 *
 * Returns null when the request may proceed, or the reply to send.
 */
function refuseUnsignable(
  data: z.infer<typeof SignEventSchema>,
  nowSeconds: number,
): { status: number; body: { error: string; message?: string } } | null {
  if (
    data.created_at !== undefined &&
    Math.abs(data.created_at - nowSeconds) > CREATED_AT_MAX_SKEW_SECONDS
  ) {
    return {
      status: 400,
      body: {
        error: 'created_at_out_of_range',
        message: "Your device's clock seems to be more than an hour out, so we can't sign this. Please check the time and try again.",
      },
    }
  }

  // The publications suspension. Every other publication surface 404s on the
  // flag (`middleware/publication-auth.ts`), and this route signing as one
  // regardless is the same hole the three stray routes had: a suspended system
  // reachable through a sibling that never learned about the suspension.
  if (data.publicationId && !publicationsEnabled()) {
    return { status: 404, body: { error: "We couldn't find that." } }
  }

  return null
}

/**
 * A kind-30023 is an ARTICLE, and signing one is the first writer act on both
 * of the web's publish paths (READER-WRITER-SPLIT-ADR §2 item 1): the free
 * path signs AND relays it here before it ever calls the index route, so a
 * gate on `POST /articles` alone would let a reader's article reach the relay
 * and only then be refused. Kinds 1 and 5 stay open to everyone. Asked after
 * the body parses and before a key is touched; the registry test pins these
 * two routes behaviourally because the check lives in the handler rather than
 * in a preHandler (a note must not pay for the lookup).
 */
async function refuseReaderArticle(kind: number, accountId: string): Promise<boolean> {
  return kind === 30023 && !(await canWrite(accountId))
}

const UnwrapKeySchema = z.object({
  encryptedKey: z.string().min(1),
})

export async function signingRoutes(app: FastifyInstance) {

  // ---------------------------------------------------------------------------
  // POST /sign — sign a Nostr event
  // ---------------------------------------------------------------------------

  app.post('/sign', { config: signingLimit, preHandler: requireAuth }, async (req, reply) => {
    const parsed = SignEventSchema.safeParse(req.body)
    if (!parsed.success) {
      return reply.status(400).send(zodValidationError(parsed.error))
    }

    const refusal = refuseUnsignable(parsed.data, Math.floor(Date.now() / 1000))
    if (refusal) return reply.status(refusal.status).send(refusal.body)

    const accountId = req.session!.sub
    if (await refuseReaderArticle(parsed.data.kind, accountId)) {
      return reply.status(403).send(writerAccessRefusal())
    }
    const { publicationId } = parsed.data

    // If signing as a publication, verify caller has can_publish
    if (publicationId) {
      const { rows } = await pool.query(
        `SELECT can_publish FROM publication_members
         WHERE publication_id = $1 AND account_id = $2 AND removed_at IS NULL`,
        [publicationId, accountId]
      )
      if (rows.length === 0 || !rows[0].can_publish) {
        return reply.status(403).send({ error: 'Not authorized to sign as this publication' })
      }
    }

    const signerId = publicationId ?? accountId
    const signerType = publicationId ? 'publication' as const : 'account' as const

    try {
      const signed = await signEvent(signerId, {
        kind: parsed.data.kind,
        content: parsed.data.content,
        tags: parsed.data.tags,
        created_at: parsed.data.created_at ?? Math.floor(Date.now() / 1000),
      }, signerType)
      logger.info({ signerId, signerType, eventKind: parsed.data.kind, eventId: signed.id }, 'Event signed')
      return reply.status(200).send(signed)
    } catch (err) {
      logger.error({ err, signerId, signerType }, 'Event signing failed')
      return reply.status(500).send({ error: "Couldn't sign that. Please try again." })
    }
  })

  // ---------------------------------------------------------------------------
  // POST /sign-and-publish — sign a Nostr event and enqueue it for publish
  //
  // Combines signing and relay enqueue into a single call so the web client
  // does not need direct relay access. Returns the signed event data.
  //
  // Semantic change (§60 Phase 3): this used to await a synchronous relay
  // publish; it now enqueues into `relay_outbox` and returns once the row is
  // committed. A 200 means "signed and durably queued for publish"; the
  // `relay_publish` worker delivers to the relay with retry. Clients that
  // need delivery confirmation should subscribe to the relay for the
  // returned event id rather than relying on this response alone.
  // ---------------------------------------------------------------------------

  app.post('/sign-and-publish', { config: signingLimit, preHandler: requireAuth }, async (req, reply) => {
    const parsed = SignEventSchema.safeParse(req.body)
    if (!parsed.success) {
      return reply.status(400).send(zodValidationError(parsed.error))
    }

    const refusal = refuseUnsignable(parsed.data, Math.floor(Date.now() / 1000))
    if (refusal) return reply.status(refusal.status).send(refusal.body)

    const accountId = req.session!.sub
    if (await refuseReaderArticle(parsed.data.kind, accountId)) {
      return reply.status(403).send(writerAccessRefusal())
    }
    const { publicationId } = parsed.data

    // If signing as a publication, verify caller has can_publish
    if (publicationId) {
      const { rows } = await pool.query(
        `SELECT can_publish FROM publication_members
         WHERE publication_id = $1 AND account_id = $2 AND removed_at IS NULL`,
        [publicationId, accountId]
      )
      if (rows.length === 0 || !rows[0].can_publish) {
        return reply.status(403).send({ error: 'Not authorized to sign as this publication' })
      }
    }

    const signerId = publicationId ?? accountId
    const signerType = publicationId ? 'publication' as const : 'account' as const

    try {
      const signed = await signEvent(signerId, {
        kind: parsed.data.kind,
        content: parsed.data.content,
        tags: parsed.data.tags,
        created_at: parsed.data.created_at ?? Math.floor(Date.now() / 1000),
      }, signerType)

      await withTransaction(async (client) => {
        await enqueueRelayPublish(client, {
          entityType: 'signing_passthrough',
          signedEvent: signed as SignedNostrEvent,
        })
      })

      logger.info({ signerId, signerType, eventKind: parsed.data.kind, eventId: signed.id }, 'Event signed and enqueued')
      return reply.status(200).send(signed)
    } catch (err) {
      logger.error({ err, signerId, signerType }, 'Sign-and-publish failed')
      return reply.status(500).send({ error: "Couldn't sign and publish that. Please try again." })
    }
  })

  // ---------------------------------------------------------------------------
  // POST /unwrap-key — decrypt a NIP-44 wrapped content key
  // ---------------------------------------------------------------------------

  app.post('/unwrap-key', { preHandler: requireAuth }, async (req, reply) => {
    const parsed = UnwrapKeySchema.safeParse(req.body)
    if (!parsed.success) {
      return reply.status(400).send(zodValidationError(parsed.error))
    }

    const accountId = req.session!.sub

    try {
      // The reader unwraps their OWN content key, so the actor and the key's
      // owner are the same account here (L6.6). Passed explicitly rather than
      // defaulted, because the row `key_access_log` keeps is only worth
      // anything on the day they differ.
      const result = await unwrapKey(accountId, parsed.data.encryptedKey, accountId)
      logger.debug({ accountId }, 'Content key unwrapped for reader')
      return reply.status(200).send(result)
    } catch (err) {
      logger.error({ err, accountId }, 'Key unwrapping failed')
      return reply.status(500).send({ error: "Couldn't unlock your key. Please try again." })
    }
  })
}
