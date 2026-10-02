import { requireEnv } from '@platform-pub/shared/lib/env.js'
import logger from '@platform-pub/shared/lib/logger.js'

export const KEY_SERVICE_URL = requireEnv('KEY_SERVICE_URL')
export const PAYMENT_SERVICE_URL = requireEnv('PAYMENT_SERVICE_URL')

// Module-level on purpose: this file is on the gateway's boot path, so it is one
// of the two places the process refuses to start without the secret. Callers
// OFF the boot path use `internalSecret()` instead — never
// `process.env.INTERNAL_SECRET ?? ''`, which is a broken deployment wearing an
// authorisation failure's clothes.
const INTERNAL_SECRET = requireEnv('INTERNAL_SECRET')

export { UUID_RE } from '../../lib/uuid.js'

// =============================================================================
// Generic service proxy helper
// =============================================================================

/**
 * Extra headers to send with a proxied call, computed from the EXACT bytes this
 * helper is about to send as the body (MIRROR-AUDIT §3 *Security*, S16).
 *
 * It is a callback and not a plain object because the per-request binding hashes
 * raw bytes, and the caller does not have them: the body is serialised here, and
 * `JSON.parse` → `JSON.stringify` is not the identity function, so a caller that
 * stringified `req.body` a second time to hash it would produce a tag for
 * something subtly other than what went out — and the symptom would be
 * publishing failing at a rate nobody could reproduce.
 */
export type ProxyBinder = (rawBody: string) => Record<string, string>

export async function proxyToService(
  url: string,
  method: string,
  req: any,
  reply: any,
  bind?: ProxyBinder
): Promise<void> {
  try {
    const headers: Record<string, string> = {
      'Content-Type': 'application/json',
      // Upstream internal services trust the identity headers below only from
      // the gateway; the secret is what proves this hop is the gateway. For
      // key-service that is no longer sufficient on its own — see `bind`.
      'x-internal-secret': INTERNAL_SECRET,
    }

    // Serialised ONCE, then both hashed and sent.
    const rawBody =
      method !== 'GET' && method !== 'HEAD' && req.body
        ? JSON.stringify(req.body)
        : ''

    if (bind) {
      // The binder is the SOLE source of identity headers when it is present,
      // and that is not tidiness — it is what keeps "what we sent" and "what we
      // bound" the same set by construction. The blind forward below passes
      // through whatever the BROWSER put on the request, so on the `/key` route
      // (which injects only `x-reader-id`) a client could add an `x-writer-id`
      // of its own: key-service would read it into the subject tuple, the
      // gateway would not have bound it, and every such request would 401 —
      // a client-triggerable outage on a paywall path, arriving as an
      // authorisation failure nobody could reproduce.
      Object.assign(headers, bind(rawBody))
    } else {
      // Forward auth headers
      if (req.headers['x-reader-id']) headers['x-reader-id'] = req.headers['x-reader-id'] as string
      if (req.headers['x-reader-pubkey']) headers['x-reader-pubkey'] = req.headers['x-reader-pubkey'] as string
      if (req.headers['x-writer-id']) headers['x-writer-id'] = req.headers['x-writer-id'] as string
    }

    const fetchOpts: RequestInit = {
      method,
      headers,
      // Bound the proxy hop — a hung upstream becomes a 502, not a hung client.
      signal: AbortSignal.timeout(15_000),
    }
    if (rawBody) fetchOpts.body = rawBody

    const res = await fetch(url, fetchOpts)
    const body = await res.json().catch(() => null)

    // AN UPSTREAM REFUSAL MUST LEAVE A FOOTPRINT — the same defect 3dc8949a
    // fixed in callPaymentService (admin-dashboard.ts), which this helper still
    // had. The status and body go straight to the browser and the catch below
    // only fires when `fetch` itself throws, so a 403 or 500 from key-service or
    // payment-service reached the caller having written NOTHING to the gateway
    // log. That is how an INTERNAL_SERVICE_TOKEN mismatch survived on prod
    // (2026-08-07): every proxied call was refused, paywalled unlocks among
    // them, and no log line anywhere named the status.
    if (res.status < 200 || res.status >= 300) {
      logger.warn(
        { url, method, status: res.status, body },
        'Service proxy returned non-2xx — check INTERNAL_SECRET parity between the gateway and this service if this is a 401/403'
      )
    }

    return reply.status(res.status).send(body)
  } catch (err) {
    logger.error({ err, url, method }, 'Service proxy failed')
    return reply.status(502).send({ error: 'Something went wrong at our end. Please try again.' })
  }
}
