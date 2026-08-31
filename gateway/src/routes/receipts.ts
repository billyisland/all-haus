import type { FastifyInstance } from 'fastify'
import { getPublicKey } from 'nostr-tools'
import { pool } from '@platform-pub/shared/db/client.js'
import { requireAuth } from '../middleware/auth.js'
import logger from '@platform-pub/shared/lib/logger.js'

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
// =============================================================================

function getPlatformPubkeyHex(): string {
  const privkeyHex = process.env.PLATFORM_SERVICE_PRIVKEY
  if (!privkeyHex) throw new Error('PLATFORM_SERVICE_PRIVKEY not set')
  const privkey = Uint8Array.from(Buffer.from(privkeyHex, 'hex'))
  return getPublicKey(privkey)
}

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

      const receipts = rows.map(r => JSON.parse(r.receipt_token))

      return reply.status(200).send({
        platformPubkey: getPlatformPubkeyHex(),
        count: receipts.length,
        receipts,
      })
    } catch (err) {
      logger.error({ err, readerId }, 'Failed to export receipts')
      return reply.status(500).send({ error: 'Internal error' })
    }
  })
}
