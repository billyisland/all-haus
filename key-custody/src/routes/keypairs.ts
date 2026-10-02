import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify'
import { z } from 'zod'
import { generateKeypair, signEvent, unwrapKey, exportSecretKey, nip44Encrypt, nip44EncryptBatch, nip44Decrypt, nip44DecryptBatch, signEventsBatch } from '../lib/crypto.js'
import logger from '@platform-pub/shared/lib/logger.js'
import {
  BINDING_HEADER,
  timingSafeEqualStrings,
  verifyInternalRequest,
} from '@platform-pub/shared/lib/internal-binding.js'
import { rawBodyOf } from '../lib/raw-body.js'
import { signerBudget, exportBudget, generateBudget, signBatchBudget } from '../lib/rate-limit.js'
import { zodValidationError } from '@platform-pub/shared/lib/validation.js'
import { recordKeyAccess } from '../lib/access-log.js'

// =============================================================================
// Keypair Routes — internal only
//
// All endpoints require the X-Internal-Secret header. They are not exposed
// to the public internet — the gateway calls them on behalf of authenticated
// users.
//
// POST /api/v1/keypairs/generate   — generate a keypair for a new account
// POST /api/v1/keypairs/sign       — sign a Nostr event for an account
// POST /api/v1/keypairs/unwrap     — unwrap a NIP-44 content key for a reader
// POST /api/v1/keypairs/export     — export the owner's secret key (migration)
//
// TWO GUARDS, and the difference between them is the whole of S15 on this
// service. `requireInternalSecret` is the bearer check the service always had,
// now compared in constant time; it is what `GET /auth-check` uses and nothing
// else, because that route is the shared parity probe and reaching it IS the
// proof (gateway/src/lib/internal-parity.ts). Every route that touches a private
// key uses `requireBoundInternalSecret`, which additionally requires a
// per-request binding over method, path, signer and body
// (shared/lib/internal-binding.ts). Bearer alone meant a single captured request
// yielded the secret and with it every OTHER request — including retargeting
// `/keypairs/export` at any account in the table.
// =============================================================================

// THE BEARER MISMATCH SAYS SO, AND IT SAYS SO HERE (L6.6; D10 §5.3).
//
// It was the one refusal on this service that logged nothing: a drifted
// `INTERNAL_SECRET` and a stranger probing the mesh looked identical from the
// outside AND left the same trace inside — none. The BINDING failure a few
// lines down has always said which half it got wrong; this is the half that
// means "somebody who is not our gateway reached a key route", which is the
// more interesting of the two and was the silent one.
//
// The line lives in the COMPARISON rather than in either guard, because there
// are two guards with the same refusal and a third would be written without
// it. The caller still learns only 401 — a fault of ours is the operator's.
function constantTimeSecretMatch(req: FastifyRequest): boolean {
  const secret = process.env.INTERNAL_SECRET
  if (!secret) return false
  // Normalize header to string — Fastify can return string[] for duplicate headers
  const header = req.headers['x-internal-secret']
  const provided = Array.isArray(header) ? header[0] : header
  const matched =
    typeof provided === 'string' && timingSafeEqualStrings(provided, secret)
  if (!matched) {
    logger.warn(
      { path: req.url, ip: req.ip, signerHint: req.headers['x-signer-id'] },
      'Rejected key-custody request: internal secret mismatch',
    )
  }
  return matched
}

/** Bearer only. `GET /auth-check`'s guard, and deliberately no other route's. */
async function requireInternalSecret(req: FastifyRequest, reply: FastifyReply) {
  if (!process.env.INTERNAL_SECRET) {
    return reply.status(503).send({ error: 'Service misconfigured' })
  }
  if (!constantTimeSecretMatch(req)) {
    return reply.status(401).send({ error: 'Unauthorized' })
  }
}

/**
 * Bearer AND binding. Nothing here reads `x-signer-id`: that header exists only
 * so the limiter has a bucket key before the body is parsed, and the signer this
 * service acts on is a field of the body the binding already covers — a request
 * retargeted at another account changes the body, and so changes the hash.
 *
 * The failure REASON is logged and never returned: the caller learns 401 and
 * nothing about which half it got wrong.
 */
async function requireBoundInternalSecret(req: FastifyRequest, reply: FastifyReply) {
  const secret = process.env.INTERNAL_SECRET
  if (!secret) {
    return reply.status(503).send({ error: 'Service misconfigured' })
  }
  if (!constantTimeSecretMatch(req)) {
    return reply.status(401).send({ error: 'Unauthorized' })
  }

  const verdict = verifyInternalRequest(secret, req.headers[BINDING_HEADER], {
    method: req.method,
    path: req.url,
    rawBody: rawBodyOf(req),
  })

  if (!verdict.ok) {
    logger.warn({ path: req.url, reason: verdict.reason }, 'Rejected unbound key-custody request')
    return reply.status(401).send({ error: 'Unauthorized' })
  }
}

const signerTypeEnum = z.enum(['account', 'publication']).default('account')

export const SignEventSchema = z.object({
  signerId: z.string().uuid().optional(),
  signerType: signerTypeEnum,
  accountId: z.string().uuid().optional(),  // backwards compat
  event: z.object({
    kind: z.number().int(),
    content: z.string(),
    tags: z.array(z.array(z.string())),
    created_at: z.number().int().optional(),
  }),
}).refine(d => d.signerId || d.accountId, { message: 'signerId or accountId required' })

/** The same event shape as `SignEventSchema`, N of them, one signer (CA-A8).
 *  500 is the DM decrypt batch's cap and the gateway client's chunk size. */
export const SignEventBatchSchema = z.object({
  signerId: z.string().uuid().optional(),
  signerType: signerTypeEnum,
  accountId: z.string().uuid().optional(),  // backwards compat
  events: z.array(z.object({
    kind: z.number().int(),
    content: z.string(),
    tags: z.array(z.array(z.string())),
    created_at: z.number().int().optional(),
  })).min(1).max(500),
}).refine(d => d.signerId || d.accountId, { message: 'signerId or accountId required' })

// `actorAccountId` is REQUIRED on the two routes that open something already
// written (L6.6): who ASKED, as against whose key was used. Required and not
// optional, because an optional audit field is a field a caller forgets — and
// the row it produces would then say "somebody" about an act the whole table
// exists to attribute. It is the caller's claim, not a proof; the gateway is
// inside the mesh and has already authorised the session (S15's binding is
// what makes it the gateway speaking).
export const UnwrapKeySchema = z.object({
  signerId: z.string().uuid().optional(),
  signerType: signerTypeEnum,
  accountId: z.string().uuid().optional(),  // backwards compat
  actorAccountId: z.string().uuid(),
  encryptedKey: z.string().min(1),
}).refine(d => d.signerId || d.accountId, { message: 'signerId or accountId required' })

export const ExportKeySchema = z.object({
  signerId: z.string().uuid().optional(),
  signerType: signerTypeEnum,
  accountId: z.string().uuid().optional(),  // backwards compat
}).refine(d => d.signerId || d.accountId, { message: 'signerId or accountId required' })

const HEX64_RE = /^[0-9a-f]{64}$/

const Nip44EncryptSchema = z.object({
  signerId: z.string().uuid().optional(),
  signerType: signerTypeEnum,
  accountId: z.string().uuid().optional(),  // backwards compat
  recipientPubkey: z.string().regex(HEX64_RE),
  plaintext: z.string().min(1),
}).refine(d => d.signerId || d.accountId, { message: 'signerId or accountId required' })

const Nip44EncryptBatchSchema = z.object({
  signerId: z.string().uuid().optional(),
  signerType: signerTypeEnum,
  accountId: z.string().uuid().optional(),  // backwards compat
  recipientPubkeys: z.array(z.string().regex(HEX64_RE)).min(1).max(64),
  plaintext: z.string().min(1),
}).refine(d => d.signerId || d.accountId, { message: 'signerId or accountId required' })

const Nip44DecryptSchema = z.object({
  signerId: z.string().uuid().optional(),
  signerType: signerTypeEnum,
  accountId: z.string().uuid().optional(),  // backwards compat
  actorAccountId: z.string().uuid(),        // L6.6 — see UnwrapKeySchema
  senderPubkey: z.string().regex(HEX64_RE),
  ciphertext: z.string().min(1),
}).refine(d => d.signerId || d.accountId, { message: 'signerId or accountId required' })

const Nip44DecryptBatchSchema = z.object({
  signerId: z.string().uuid().optional(),
  signerType: signerTypeEnum,
  accountId: z.string().uuid().optional(),  // backwards compat
  actorAccountId: z.string().uuid(),        // L6.6 — see UnwrapKeySchema
  items: z.array(z.object({
    senderPubkey: z.string().regex(HEX64_RE),
    ciphertext: z.string().min(1),
  })).min(1).max(500),
}).refine(d => d.signerId || d.accountId, { message: 'signerId or accountId required' })

/** Resolve signerId from either signerId or legacy accountId */
export function resolveSignerId(data: { signerId?: string; accountId?: string }): string {
  return data.signerId || data.accountId!
}

export async function keypairRoutes(app: FastifyInstance) {

  // ---------------------------------------------------------------------------
  // GET /api/v1/auth-check
  //
  // The gateway's boot-time secret-parity probe. Does nothing and says nothing:
  // reaching this handler proves the caller holds the same INTERNAL_SECRET this
  // service verifies against, so the 200 IS the parity proof and the 401 IS the
  // mismatch. Discloses nothing derived from the secret — the guard already
  // answers the question, so an echoed hash would be exposure for no gain.
  // Spec: gateway/src/lib/internal-parity.ts.
  // ---------------------------------------------------------------------------

  // NO `config.rateLimit`, deliberately, and with `global: false` that means no
  // limit at all: a 429 here is "unreachable" to `classifyParityStatus`, so it
  // is correctly not fatal — but it leaves the peer reading "never confirmed",
  // the third state the probe exists to keep distinct from "fine", degraded by
  // an unrelated burst of signing. Rate-limiting a liveness probe is the wrong
  // shape whichever bucket it lands in.
  app.get('/auth-check', { preHandler: requireInternalSecret }, async (_req, reply) => {
    return reply.status(200).send({ ok: true })
  })

  // ---------------------------------------------------------------------------
  // POST /api/v1/keypairs/generate
  //
  // Generates a new Nostr keypair. Returns the public key and the
  // encrypted private key for storage in the accounts table.
  // ---------------------------------------------------------------------------

  app.post('/keypairs/generate', { config: generateBudget, preHandler: requireBoundInternalSecret }, async (_req, reply) => {
    try {
      const keypair = generateKeypair()
      return reply.status(201).send(keypair)
    } catch (err) {
      logger.error({ err }, 'Keypair generation failed')
      return reply.status(500).send({ error: 'Keypair generation failed' })
    }
  })

  // ---------------------------------------------------------------------------
  // POST /api/v1/keypairs/sign
  //
  // Signs a Nostr event template with the account's custodial private key.
  // ---------------------------------------------------------------------------

  app.post('/keypairs/sign', { config: signerBudget, preHandler: requireBoundInternalSecret }, async (req, reply) => {
    const parsed = SignEventSchema.safeParse(req.body)
    if (!parsed.success) {
      return reply.status(400).send(zodValidationError(parsed.error))
    }

    const { event, signerType } = parsed.data
    const signerId = resolveSignerId(parsed.data)

    try {
      const eventTemplate = {
        kind: event.kind,
        content: event.content,
        tags: event.tags,
        created_at: event.created_at ?? Math.floor(Date.now() / 1000),
      }

      const signed = await signEvent(signerId, eventTemplate, signerType)

      logger.info({ signerId, signerType, eventKind: event.kind, eventId: signed.id }, 'Event signed')

      return reply.status(200).send({
        id: signed.id,
        pubkey: signed.pubkey,
        sig: signed.sig,
        kind: signed.kind,
        content: signed.content,
        tags: signed.tags,
        created_at: signed.created_at,
      })
    } catch (err) {
      logger.error({ err, signerId, signerType }, 'Event signing failed')
      return reply.status(500).send({ error: 'Signing failed' })
    }
  })

  // ---------------------------------------------------------------------------
  // POST /api/v1/keypairs/sign-batch
  //
  // N event templates, one signer, one key decryption, one budget slot
  // (CA-A8). The suspension and account-deletion paths tombstone every piece
  // a member published, and at one `/sign` per piece they walked into that
  // route's 120/min per-signer budget on the 121st — the gateway threw and the
  // suspension never happened. Positional: `signed[i]` is `events[i]`.
  // All-or-nothing: the input is validated whole and signing is local
  // arithmetic, so there is no per-item failure to report.
  // ---------------------------------------------------------------------------

  app.post('/keypairs/sign-batch', { config: signBatchBudget, preHandler: requireBoundInternalSecret }, async (req, reply) => {
    const parsed = SignEventBatchSchema.safeParse(req.body)
    if (!parsed.success) {
      return reply.status(400).send(zodValidationError(parsed.error))
    }

    const { events, signerType } = parsed.data
    const signerId = resolveSignerId(parsed.data)
    const now = Math.floor(Date.now() / 1000)

    try {
      const signed = await signEventsBatch(
        signerId,
        events.map(e => ({
          kind: e.kind,
          content: e.content,
          tags: e.tags,
          created_at: e.created_at ?? now,
        })),
        signerType,
      )

      logger.info({ signerId, signerType, count: signed.length }, 'Events batch-signed')

      return reply.status(200).send({
        signed: signed.map(s => ({
          id: s.id,
          pubkey: s.pubkey,
          sig: s.sig,
          kind: s.kind,
          content: s.content,
          tags: s.tags,
          created_at: s.created_at,
        })),
      })
    } catch (err) {
      logger.error({ err, signerId, signerType, count: events.length }, 'Event batch signing failed')
      return reply.status(500).send({ error: 'Signing failed' })
    }
  })

  // ---------------------------------------------------------------------------
  // POST /api/v1/keypairs/unwrap
  //
  // Decrypts a NIP-44 wrapped content key using the reader's private key.
  // The key-service wrapped the content key to the reader's pubkey; this
  // reverses that using the reader's custodial private key.
  // ---------------------------------------------------------------------------

  app.post('/keypairs/unwrap', { config: signerBudget, preHandler: requireBoundInternalSecret }, async (req, reply) => {
    const parsed = UnwrapKeySchema.safeParse(req.body)
    if (!parsed.success) {
      return reply.status(400).send(zodValidationError(parsed.error))
    }

    const { encryptedKey, signerType, actorAccountId } = parsed.data
    const signerId = resolveSignerId(parsed.data)

    try {
      const contentKeyBase64 = await unwrapKey(signerId, encryptedKey, signerType)

      // BEFORE the reply, so the row is down before the key goes out. A throw
      // here answers 500 and the caller is given nothing — see access-log.ts.
      await recordKeyAccess({
        accountId: signerId,
        purpose: 'paywall_unwrap',
        actorAccountId,
        signerType,
      })

      logger.debug({ signerId, signerType }, 'Content key unwrapped')

      return reply.status(200).send({ contentKeyBase64 })
    } catch (err) {
      logger.error({ err, signerId, signerType }, 'Key unwrapping failed')
      return reply.status(500).send({ error: 'Key unwrapping failed' })
    }
  })

  // ---------------------------------------------------------------------------
  // POST /api/v1/keypairs/export
  //
  // Returns the owner's decrypted Nostr private key (hex + nsec) so the gateway
  // can include it in the authenticated owner's migration export. The gateway
  // is responsible for authorising the caller as the owner of signerId; this
  // service trusts the internal secret. The key is never logged.
  // ---------------------------------------------------------------------------

  app.post('/keypairs/export', { config: exportBudget, preHandler: requireBoundInternalSecret }, async (req, reply) => {
    const parsed = ExportKeySchema.safeParse(req.body)
    if (!parsed.success) {
      return reply.status(400).send(zodValidationError(parsed.error))
    }

    const { signerType } = parsed.data
    const signerId = resolveSignerId(parsed.data)

    try {
      const exported = await exportSecretKey(signerId, signerType)
      logger.info({ signerId, signerType }, 'Secret key exported')
      return reply.status(200).send(exported)
    } catch (err) {
      logger.error({ err, signerId, signerType }, 'Secret key export failed')
      return reply.status(500).send({ error: 'Export failed' })
    }
  })

  // ---------------------------------------------------------------------------
  // POST /api/v1/keypairs/nip44-encrypt
  //
  // NIP-44 encrypt plaintext using the account's private key and a recipient
  // public key. Used by the gateway for DM E2E encryption.
  // ---------------------------------------------------------------------------

  app.post('/keypairs/nip44-encrypt', { config: signerBudget, preHandler: requireBoundInternalSecret }, async (req, reply) => {
    const parsed = Nip44EncryptSchema.safeParse(req.body)
    if (!parsed.success) {
      return reply.status(400).send(zodValidationError(parsed.error))
    }

    const { recipientPubkey, plaintext, signerType } = parsed.data
    const signerId = resolveSignerId(parsed.data)

    try {
      const ciphertext = await nip44Encrypt(signerId, recipientPubkey, plaintext, signerType)
      logger.debug({ signerId, signerType }, 'NIP-44 encrypted')
      return reply.status(200).send({ ciphertext })
    } catch (err) {
      logger.error({ err, signerId, signerType }, 'NIP-44 encryption failed')
      return reply.status(500).send({ error: 'Encryption failed' })
    }
  })

  // ---------------------------------------------------------------------------
  // POST /api/v1/keypairs/nip44-encrypt-batch
  //
  // NIP-44 encrypt the same plaintext for N recipients in one call. Used by
  // the gateway DM send path for group conversations — decrypts the sender's
  // private key once instead of N times.
  // ---------------------------------------------------------------------------

  app.post('/keypairs/nip44-encrypt-batch', { config: signerBudget, preHandler: requireBoundInternalSecret }, async (req, reply) => {
    const parsed = Nip44EncryptBatchSchema.safeParse(req.body)
    if (!parsed.success) {
      return reply.status(400).send(zodValidationError(parsed.error))
    }

    const { recipientPubkeys, plaintext, signerType } = parsed.data
    const signerId = resolveSignerId(parsed.data)

    try {
      const ciphertexts = await nip44EncryptBatch(signerId, recipientPubkeys, plaintext, signerType)
      logger.debug({ signerId, signerType, count: recipientPubkeys.length }, 'NIP-44 batch encrypted')
      return reply.status(200).send({ ciphertexts })
    } catch (err) {
      logger.error({ err, signerId, signerType }, 'NIP-44 batch encryption failed')
      return reply.status(500).send({ error: 'Encryption failed' })
    }
  })

  // ---------------------------------------------------------------------------
  // POST /api/v1/keypairs/nip44-decrypt
  //
  // NIP-44 decrypt ciphertext using the account's private key and the sender's
  // public key. Used by the gateway for DM E2E decryption.
  // ---------------------------------------------------------------------------

  app.post('/keypairs/nip44-decrypt', { config: signerBudget, preHandler: requireBoundInternalSecret }, async (req, reply) => {
    const parsed = Nip44DecryptSchema.safeParse(req.body)
    if (!parsed.success) {
      return reply.status(400).send(zodValidationError(parsed.error))
    }

    const { senderPubkey, ciphertext, signerType, actorAccountId } = parsed.data
    const signerId = resolveSignerId(parsed.data)

    try {
      const plaintext = await nip44Decrypt(signerId, senderPubkey, ciphertext, signerType)

      // BEFORE the reply — see access-log.ts.
      await recordKeyAccess({
        accountId: signerId,
        purpose: 'dm_decrypt',
        actorAccountId,
        signerType,
      })

      logger.debug({ signerId, signerType }, 'NIP-44 decrypted')
      return reply.status(200).send({ plaintext })
    } catch (err) {
      logger.error({ err, signerId, signerType }, 'NIP-44 decryption failed')
      return reply.status(500).send({ error: 'Decryption failed' })
    }
  })

  // ---------------------------------------------------------------------------
  // POST /api/v1/keypairs/nip44-decrypt-batch
  //
  // N messages, one key decryption, one round trip. Built for the account
  // export (L7.1), which hands a member back their whole message history: at
  // one hop per message that history hits this service's per-signer budget
  // (120/min) partway through and the rest of the archive arrives as failures.
  //
  // TWO THINGS IT DOES NOT CHANGE. The AUDIT is per message, not per call: one
  // `key_access_log` row goes down for every plaintext this reply carries,
  // before it carries it, exactly as the single route does — a batch is a
  // convenience of transport and the table records disclosures, not requests.
  // And a batch is not a transaction: an unreadable ciphertext yields
  // `plaintext: null` for that item and nothing else (the partial-outcome rule
  // — a failure in one unit is a fact about that unit), and the rows are
  // written only for the items that actually decrypted, so the log never
  // claims a disclosure that did not happen.
  // ---------------------------------------------------------------------------

  app.post('/keypairs/nip44-decrypt-batch', { config: signerBudget, preHandler: requireBoundInternalSecret }, async (req, reply) => {
    const parsed = Nip44DecryptBatchSchema.safeParse(req.body)
    if (!parsed.success) {
      return reply.status(400).send(zodValidationError(parsed.error))
    }

    const { items, signerType, actorAccountId } = parsed.data
    const signerId = resolveSignerId(parsed.data)

    try {
      const results = await nip44DecryptBatch(
        signerId,
        items.map(i => ({ senderPubkeyHex: i.senderPubkey, ciphertext: i.ciphertext })),
        signerType,
      )

      // BEFORE the reply, one row per plaintext, all in one statement — see
      // access-log.ts. One INSERT rather than a loop: a round trip per message
      // made a 500-message inbox 500 serial writes, and a parallel fan-out
      // would spend the pool this service shares with everything else.
      const disclosed = results.filter(r => r.plaintext !== null).length
      await recordKeyAccess({
        accountId: signerId,
        purpose: 'dm_decrypt',
        actorAccountId,
        signerType,
        count: disclosed,
      })

      logger.debug({ signerId, signerType, count: items.length, disclosed }, 'NIP-44 batch decrypted')
      return reply.status(200).send({ results })
    } catch (err) {
      logger.error({ err, signerId, signerType }, 'NIP-44 batch decryption failed')
      return reply.status(500).send({ error: 'Decryption failed' })
    }
  })
}
