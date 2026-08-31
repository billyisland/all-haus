import type { FastifyInstance } from 'fastify'
import { pool } from '@platform-pub/shared/db/client.js'
import { requireAuth } from '../middleware/auth.js'
import { verifySession } from '@platform-pub/shared/auth/session.js'
import { exportSecretKey } from '../lib/key-custody-client.js'
import logger from '@platform-pub/shared/lib/logger.js'

// =============================================================================
// Author Migration Export
//
// GET /account/export — auth required (writer only)
//
// Returns a portable bundle of all data a writer needs to leave the platform
// and re-host their content elsewhere:
//
//   account       — Nostr pubkey + secret key (hex + nsec), username, display
//                   name. The secret key is the migration anchor: it lets the
//                   writer re-sign and re-host their identity off-platform
//                   (NETWORK-CONCIERGE-ADR §4 "export-mandatory").
//   articles      — list of published articles with nostrEventId + dTag so the
//                   writer can re-fetch the signed events from the relay
//   contentKeys   — each paywalled article's content key wrapped with NIP-44
//                   to the writer's own pubkey (decrypt with writer's privkey
//                   to get the raw 32-byte key, then use algorithm to decrypt)
//   receiptWhitelist — per-article list of reader Nostr pubkeys who have paid
//                   (another host can honour these readers without re-charging)
//
// The Nostr events themselves (profile kind 0, follow list kind 3, articles
// kind 30023) are published to the relay and can be fetched by the client
// using the writer's pubkey — they are not duplicated here.
// =============================================================================

const KEY_SERVICE_URL = process.env.KEY_SERVICE_URL ?? 'http://localhost:3002'
const INTERNAL_SECRET = process.env.INTERNAL_SECRET ?? ''

interface ExportedKey {
  articleId: string
  nostrEventId: string
  dTag: string
  title: string
  algorithm: string
  encryptedKey: string
}

async function fetchExportedKeys(writerId: string, writerPubkey: string): Promise<ExportedKey[]> {
  // key-service mounts keyRoutes under /api/v1 (key-service/src/index.ts) —
  // the unprefixed path 404s (§0f-19; every other gateway caller carries it).
  const res = await fetch(`${KEY_SERVICE_URL}/api/v1/writers/export-keys`, {
    headers: {
      'x-writer-id': writerId,
      'x-writer-pubkey': writerPubkey,
      'x-internal-secret': INTERNAL_SECRET,
    },
  })

  if (!res.ok) {
    const body = await res.json().catch(() => null) as { error?: string } | null
    throw new Error(`Key export failed: ${res.status} — ${body?.error ?? 'unknown'}`)
  }

  const body = await res.json() as { keys: ExportedKey[] }
  return body.keys
}

export async function exportRoutes(app: FastifyInstance) {

  // ---------------------------------------------------------------------------
  // GET /account/export
  //
  // Returns the writer's full migration bundle as a JSON object.
  // The client (or writer's tools) can use this to migrate to another host.
  // ---------------------------------------------------------------------------

  // Tight per-route rate limit: the bundle carries the decrypted root Nostr
  // secret key, so a stolen session cookie must not be able to hammer this
  // path quietly. Legitimate use is a handful of exports, ever.
  //
  // Key the bucket on the authenticated account, not @fastify/rate-limit's
  // default req.ip: behind nginx every request shares the proxy IP, so an IP
  // key would (a) make all users share one 5/hour bucket — one exporter could
  // DoS everyone — and (b) let a stolen cookie from a fresh source IP get its
  // own bucket. keyGenerator runs at onRequest (before the requireAuth
  // preHandler), so we re-derive the session here; it falls back to IP for the
  // unauthenticated case, which requireAuth then rejects with 401 anyway.
  app.get('/account/export', {
    preHandler: requireAuth,
    config: {
      rateLimit: {
        max: 5,
        timeWindow: '1 hour',
        keyGenerator: async (req) => {
          try {
            const session = await verifySession(req)
            if (session?.sub) return `export:acct:${session.sub}`
          } catch {
            // fall through to IP
          }
          return `export:ip:${req.ip}`
        },
      },
    },
  }, async (req, reply) => {
    const writerId = req.session!.sub

    // Fetch writer's account
    const accountRow = await pool.query<{
      nostr_pubkey: string
      username: string | null
      display_name: string | null
      has_keypair: boolean
    }>(
      `SELECT nostr_pubkey, username, display_name,
              nostr_privkey_enc IS NOT NULL AS has_keypair
       FROM accounts
       WHERE id = $1 AND status = 'active'`,
      [writerId]
    )

    if (accountRow.rows.length === 0) {
      return reply.status(403).send({ error: 'Account not found' })
    }

    const account = accountRow.rows[0]

    // Fetch all published (non-deleted) articles for this writer
    const articlesRow = await pool.query<{
      id: string
      nostr_event_id: string
      nostr_d_tag: string
      title: string
      access_mode: string
      price_pence: number | null
      published_at: Date
    }>(
      `SELECT id, nostr_event_id, nostr_d_tag, title, access_mode, price_pence, published_at
       FROM articles
       WHERE writer_id = $1
         AND deleted_at IS NULL
       ORDER BY published_at DESC`,
      [writerId]
    )

    // Fetch receipt whitelist: distinct reader pubkeys per article for this writer
    // Only includes readers where the portable receipt was stored (reader_pubkey IS NOT NULL)
    const whitelistRow = await pool.query<{
      article_id: string
      reader_pubkeys: string[]
    }>(
      `SELECT article_id, array_agg(DISTINCT reader_pubkey) AS reader_pubkeys
       FROM read_events
       WHERE writer_id = $1
         AND reader_pubkey IS NOT NULL
       GROUP BY article_id`,
      [writerId]
    )

    const whitelistByArticle = new Map(
      whitelistRow.rows.map(r => [r.article_id, r.reader_pubkeys])
    )

    // Fetch content keys from key-service (wrapped to writer's own pubkey)
    let contentKeys: ExportedKey[] = []
    try {
      contentKeys = await fetchExportedKeys(writerId, account.nostr_pubkey)
    } catch (err) {
      logger.error({ err, writerId }, 'Failed to export content keys from key-service')
      return reply.status(502).send({ error: 'Failed to retrieve content keys' })
    }

    // Fetch the writer's own Nostr secret key (the migration anchor). Fail the
    // whole export rather than ship a keyless "full account export" — the key is
    // the one thing the writer can't recover from anywhere else. An account with
    // no custodial keypair at all (legacy/edge rows: nostr_privkey_enc IS NULL)
    // is a distinct, permanent condition — report it as such rather than as a
    // retryable upstream 502 (key-custody returns an undifferentiated 500 for
    // both, so the precondition is checked here against the shared DB).
    if (!account.has_keypair) {
      logger.warn({ writerId }, 'Export refused: account has no custodial keypair')
      return reply.status(409).send({ error: 'Account has no custodial keypair to export' })
    }
    let secretKey: { privkeyHex: string; nsec: string }
    try {
      secretKey = await exportSecretKey(writerId, 'account')
    } catch (err) {
      logger.error({ err, writerId }, 'Failed to export secret key from key-custody')
      return reply.status(502).send({ error: 'Failed to retrieve account key' })
    }

    const contentKeysByArticleId = new Map(contentKeys.map(k => [k.articleId, k]))

    // Build articles list with key info merged in
    const articles = articlesRow.rows.map(a => {
      const keyInfo = contentKeysByArticleId.get(a.id)
      const readerPubkeys = whitelistByArticle.get(a.id) ?? []
      return {
        articleId: a.id,
        nostrEventId: a.nostr_event_id,
        dTag: a.nostr_d_tag,
        title: a.title,
        accessMode: a.access_mode,
        isPaywalled: a.access_mode === 'paywalled',
        pricePence: a.price_pence ?? 0,
        publishedAt: a.published_at.toISOString(),
        // Content key info — present only for paywalled articles
        ...(keyInfo && {
          algorithm: keyInfo.algorithm,
          encryptedKey: keyInfo.encryptedKey,  // NIP-44 wrapped to writer's own pubkey
        }),
        // Reader pubkeys who have paid (for receipt whitelisting on another host)
        readerPubkeys,
      }
    })

    logger.info(
      { writerId, articleCount: articles.length, keyCount: contentKeys.length },
      'Author migration export'
    )

    return reply.status(200).send({
      version: 1,
      exportedAt: new Date().toISOString(),
      account: {
        nostrPubkey: account.nostr_pubkey,
        nostrPrivkeyHex: secretKey.privkeyHex,
        nostrPrivkeyNsec: secretKey.nsec,
        username: account.username,
        displayName: account.display_name,
      },
      articles,
      // Summary counts for quick validation
      summary: {
        totalArticles: articles.length,
        paywallArticles: articles.filter(a => a.isPaywalled).length,
        contentKeysExported: contentKeys.length,
        uniqueReaders: new Set(articles.flatMap(a => a.readerPubkeys)).size,
      },
    })
  })
}
