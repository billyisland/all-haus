import type { FastifyInstance } from 'fastify'
import { getPublicKey } from 'nostr-tools'
import { pool } from '@platform-pub/shared/db/client.js'
import { requireAuth } from '../middleware/auth.js'
import logger from '@platform-pub/shared/lib/logger.js'
import { loadSettlementReceipt } from '@platform-pub/shared/lib/settlement-receipt.js'

// =============================================================================
// Receipt Routes
//
// GET /platform-pubkey  — Public. Returns the platform service pubkey so that
//                         other hosts can verify portable receipts offline using
//                         verifyEvent() from nostr-tools.
//
// GET /receipts/export  — Auth required. Returns all portable receipt tokens
//                         for the authenticated reader as an array of signed
//                         Nostr event objects. Each token is verifiable against
//                         the platform pubkey.
//
// Receipt portability model:
//   1. Reader exports receipts from this host (GET /receipts/export)
//   2. Reader presents receipts to another host
//   3. Other host fetches this host's signing pubkey (GET /platform-pubkey)
//   4. Other host calls verifyEvent(receipt) and checks receipt.pubkey matches
//   5. Other host checks receipt tags: article event ID, reader pubkey, amount
//
// GET /my/receipts/:settlementId
//                       — Auth required. The per-settlement receipt Reader Terms
//                         5.2 promises: the pieces the charge covered, the
//                         Writers concerned, and what was paid for each. See its
//                         own header below.
// =============================================================================

// A path parameter that is not a uuid names nothing — see the route below.
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

function getPlatformPubkeyHex(): string {
  const privkeyHex = process.env.PLATFORM_SERVICE_PRIVKEY
  if (!privkeyHex) throw new Error('PLATFORM_SERVICE_PRIVKEY not set')
  const privkey = Uint8Array.from(Buffer.from(privkeyHex, 'hex'))
  return getPublicKey(privkey)
}


// =============================================================================
// GET /my/receipts/:settlementId — the receipt for one card charge
//
// Reader Terms 5.2's receipt. The QUESTION — what did this charge cover — has
// one home, `shared/src/lib/settlement-receipt.ts`, because the email the
// settlement confirm sends and the page the reader opens are two surfaces on one
// fact: two copies of that query would drift, and the divergence would be
// visible only to somebody holding the email and the page side by side. Read
// that file's header for the rules the receipt obeys (the Writer named as
// seller, `chargeable_pence` and never the list price, and why the itemised
// total need not equal the charge).
//
// This route is the reader's own and nobody else's: the ownership term is in the
// loader's WHERE clause, and a settlement that is not theirs answers exactly as
// one that does not exist.
// =============================================================================

export async function receiptRoutes(app: FastifyInstance) {
  // ---------------------------------------------------------------------------
  // GET /platform-pubkey
  //
  // Public endpoint. Returns the platform's Nostr service pubkey (hex).
  // Other hosts use this to verify exported receipts.
  // ---------------------------------------------------------------------------

  app.get('/platform-pubkey', async (_req, reply) => {
    try {
      const pubkey = getPlatformPubkeyHex()
      return reply.status(200).send({ pubkey })
    } catch (err) {
      logger.error({ err }, 'Failed to derive platform pubkey')
      return reply.status(500).send({ error: 'Internal error' })
    }
  })

  // ---------------------------------------------------------------------------
  // GET /receipts/export
  //
  // Returns all portable receipt tokens for the authenticated reader.
  // Each receipt is a signed Nostr kind 9901 event JSON object containing:
  //   - ['e', articleEventId]   — the article that was read
  //   - ['p', writerPubkey]     — the writer
  //   - ['reader', readerPubkey] — the reader (actual pubkey, not hash)
  //   - ['amount', pence, 'GBP'] — amount charged
  //   - ['gate', 'passed']
  //
  // The event is signed by the platform service key and verifiable offline.
  // ---------------------------------------------------------------------------

  app.get('/receipts/export', { preHandler: requireAuth }, async (req, reply) => {
    const readerId = req.session!.sub

    try {
      const { rows } = await pool.query<{ receipt_token: string; read_at: Date }>(
        `SELECT receipt_token, read_at
         FROM read_events
         WHERE reader_id = $1
           AND receipt_token IS NOT NULL
         ORDER BY read_at ASC`,
        [readerId]
      )

      // ONE BAD TOKEN MUST NOT COST THE READER EVERY OTHER ONE. `rows.map(JSON.parse)`
      // throws on the first unparseable row, which the catch below turns into a
      // 500 — so a single corrupt `receipt_token` anywhere in a reader's history
      // makes the whole export permanently unavailable to them, with an error
      // that says nothing about which row or that the rest are fine. These are
      // the reader's own portable proofs of what they paid for; refusing to hand
      // over ninety-nine of them because the hundredth is malformed is the worst
      // available answer.
      //
      // So each row is parsed on its own and a bad one is skipped — and COUNTED,
      // never silently dropped. A short export that reads as a complete one is
      // the reassuring absence this repo keeps meeting: `skipped` ships beside
      // `count` so a reader (and a support request) can tell a reader with four
      // receipts from a reader with five, one of which we could not read.
      const receipts: unknown[] = []
      let skipped = 0
      for (const r of rows) {
        try {
          receipts.push(JSON.parse(r.receipt_token))
        } catch (err) {
          skipped += 1
          logger.error(
            { err, readerId, readAt: r.read_at },
            'Receipt export: unparseable receipt_token, skipped',
          )
        }
      }

      return reply.status(200).send({
        platformPubkey: getPlatformPubkeyHex(),
        count: receipts.length,
        skipped,
        receipts,
      })
    } catch (err) {
      logger.error({ err, readerId }, 'Failed to export receipts')
      return reply.status(500).send({ error: 'Internal error' })
    }
  })

  // ---------------------------------------------------------------------------
  // GET /my/receipts/:settlementId — see the header above.
  // ---------------------------------------------------------------------------

  app.get<{ Params: { settlementId: string } }>(
    '/my/receipts/:settlementId',
    { preHandler: requireAuth },
    async (req, reply) => {
      const readerId = req.session!.sub
      const { settlementId } = req.params

      // A settlement id is a uuid. A malformed one is a path that names no
      // resource, not a bad request about one — and answering 400 would tell a
      // stranger their guess was the right SHAPE.
      if (!UUID_RE.test(settlementId)) {
        return reply.status(404).send({ error: 'not_found' })
      }

      try {
        const receipt = await loadSettlementReceipt(settlementId, readerId)
        if (!receipt) {
          return reply.status(404).send({ error: 'not_found' })
        }
        return reply.status(200).send(receipt)
      } catch (err) {
        logger.error({ err, readerId, settlementId }, 'Failed to build settlement receipt')
        return reply.status(500).send({ error: 'Internal error' })
      }
    },
  )
}
