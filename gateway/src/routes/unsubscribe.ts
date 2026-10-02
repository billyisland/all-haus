import type { FastifyInstance } from 'fastify'
import { pool } from '@platform-pub/shared/db/client.js'
import { verifyUnsubscribeToken } from '@platform-pub/shared/lib/publish-email-template.js'
import { requireEnv } from '@platform-pub/shared/lib/env.js'
import { renderPage } from '@platform-pub/shared/lib/email/layout.js'
import { unsubscribePage, type UnsubscribeOutcome } from '@platform-pub/shared/lib/email/templates/pages.js'
import { siteUrl } from '@platform-pub/shared/lib/email/format.js'
import logger from '@platform-pub/shared/lib/logger.js'
import { gatewayErrorHandler } from '../lib/error-handler.js'

// =============================================================================
// Email Unsubscribe Route
//
// GET  /email/unsubscribe?aid=X&tid=Y&type=Z&token=T — CONFIRMS, changes nothing
// POST /email/unsubscribe?aid=X&tid=Y&type=Z&token=T — ACTS
//
// The link in a publish email opens the GET, which verifies the HMAC-signed
// token and asks. The GET used to act, and a mail link scanner (Outlook
// SafeLinks and its kind) opens every link in every message it screens — so
// people were being unsubscribed by their own mail server (CA-D4).
//
// The POST is two doors on one handler: the confirm page's button, and RFC 8058
// one-click — the `List-Unsubscribe` header `renderEmail` puts on the message,
// which a mail client POSTs to (body `List-Unsubscribe=One-Click`, url-encoded
// or multipart) and which MUST act with no further page. So the POST never
// reads its body: the signed query string is the whole of the authority.
//
// Every outcome renders a page in the email look
// (`shared/src/lib/email/templates/pages.ts`).
// =============================================================================

const READER_HASH_KEY = requireEnv('READER_HASH_KEY')

// Only a SUBSCRIPTION carries `notify_on_publish` and only a subscription's
// token is ever minted (`publish-emails.ts`). The route also accepted `follow`
// and `publication_follow` and UPDATEd a `notify_on_publish` column neither
// table has — unreachable without a forged token, and a 500 if reached — so
// both arms went with CA-D4. A follow that grows publish emails adds its
// column, its minter and its arm here together.
type TargetType = 'subscription'
const TARGET_TYPES: readonly string[] = ['subscription']

type UnsubscribeQuery = { aid?: string; tid?: string; type?: string; token?: string }

// One bucket per client address for both methods: 10/min is far above what a
// person does and well below what a scanner sweeping a mailbox does. The
// gateway runs with `trustProxy: 1`, so `req.ip` is the client, not nginx.
const routeConfig = { rateLimit: { max: 10, timeWindow: '1 minute' } }

function htmlPage(outcome: UnsubscribeOutcome): string {
  const page = unsubscribePage(outcome)
  return renderPage(page.heading, page.blocks)
}

type Verified = { aid: string; tid: string; type: TargetType; token: string }

/** The signed query, or the page that refuses it. Shared by both methods, so
 *  the confirm page can never offer a button the POST would then refuse. */
function verify(
  q: UnsubscribeQuery,
  ip: string,
): { ok: true; v: Verified } | { ok: false; status: number; outcome: UnsubscribeOutcome } {
  const { aid, tid, type, token } = q
  if (!aid || !tid || !type || !token) {
    return { ok: false, status: 400, outcome: { kind: 'missing_params' } }
  }
  if (!TARGET_TYPES.includes(type)) {
    return { ok: false, status: 400, outcome: { kind: 'unknown_type' } }
  }
  if (!verifyUnsubscribeToken(token, aid, tid, type as TargetType, READER_HASH_KEY)) {
    logger.warn({ aid, tid, type, ip }, 'Invalid unsubscribe token')
    return { ok: false, status: 403, outcome: { kind: 'bad_token' } }
  }
  return { ok: true, v: { aid, tid, type: type as TargetType, token } }
}

/** The writer's name, for the page. Best-effort. */
async function targetName(v: Verified): Promise<string> {
  try {
    const { rows } = await pool.query<{ display_name: string | null; username: string }>(
      `SELECT display_name, username FROM accounts WHERE id = $1`, [v.tid]
    )
    if (rows.length > 0) return rows[0].display_name ?? rows[0].username
  } catch { /* best-effort name lookup */ }
  return 'this writer'
}

/** Set notify_on_publish = false on the subscription; true if a row changed. */
async function unsubscribe(v: Verified): Promise<boolean> {
  const result = await pool.query(
    `UPDATE subscriptions SET notify_on_publish = false, updated_at = now()
     WHERE reader_id = $1 AND writer_id = $2 AND status = 'active' AND notify_on_publish = true
     RETURNING id`,
    [v.aid, v.tid]
  )
  return (result.rowCount ?? 0) > 0
}

export async function unsubscribeRoutes(app: FastifyInstance) {
  // A one-click POST arrives url-encoded (or multipart, which the root
  // `@fastify/multipart` registration already accepts). Scoped to this plugin:
  // nothing else on the gateway takes a form body. The body is never read.
  app.addContentTypeParser(
    'application/x-www-form-urlencoded',
    { parseAs: 'string', bodyLimit: 1024 },
    (_req, _body, done) => done(null, {}),
  )

  // The limiter throws a 429 the gateway's funnel would answer as JSON; a person
  // who followed a link from an email is owed a page. Scoped to this plugin,
  // and everything that is not the limiter goes to the one funnel unchanged.
  app.setErrorHandler((err, req, reply) => {
    if ((err as { statusCode?: number }).statusCode === 429) {
      reply.type('text/html').status(429)
      return reply.send(htmlPage({ kind: 'rate_limited' }))
    }
    return gatewayErrorHandler(err, req, reply)
  })

  app.get<{ Querystring: UnsubscribeQuery }>(
    '/email/unsubscribe',
    { config: routeConfig },
    async (req, reply) => {
      const checked = verify(req.query, req.ip)
      if (!checked.ok) {
        reply.type('text/html').status(checked.status)
        return htmlPage(checked.outcome)
      }
      const v = checked.v
      const params = new URLSearchParams({ aid: v.aid, tid: v.tid, type: v.type, token: v.token })
      reply.type('text/html').status(200)
      return htmlPage({
        kind: 'confirm',
        targetName: await targetName(v),
        actionUrl: siteUrl(`/api/v1/email/unsubscribe?${params.toString()}`),
      })
    },
  )

  app.post<{ Querystring: UnsubscribeQuery }>(
    '/email/unsubscribe',
    { config: routeConfig },
    async (req, reply) => {
      const checked = verify(req.query, req.ip)
      if (!checked.ok) {
        reply.type('text/html').status(checked.status)
        return htmlPage(checked.outcome)
      }
      const v = checked.v

      let updated: boolean
      try {
        updated = await unsubscribe(v)
      } catch (err) {
        logger.error({ err, aid: v.aid, tid: v.tid, type: v.type }, 'Unsubscribe DB update failed')
        reply.type('text/html').status(500)
        return htmlPage({ kind: 'failed' })
      }

      logger.info({ aid: v.aid, tid: v.tid, type: v.type, updated }, 'Unsubscribe processed')
      reply.type('text/html').status(200)
      return htmlPage({ kind: 'done', targetName: await targetName(v) })
    },
  )
}
