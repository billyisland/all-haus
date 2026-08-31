import { requireEnv } from '@platform-pub/shared/lib/env.js'
import logger from '@platform-pub/shared/lib/logger.js'

export const KEY_SERVICE_URL = requireEnv('KEY_SERVICE_URL')
export const PAYMENT_SERVICE_URL = requireEnv('PAYMENT_SERVICE_URL')

const INTERNAL_SECRET = requireEnv('INTERNAL_SECRET')

export { UUID_RE } from '../../lib/uuid.js'

// =============================================================================
// Generic service proxy helper
// =============================================================================

export async function proxyToService(
  url: string,
  method: string,
  req: any,
  reply: any
): Promise<void> {
  try {
    const headers: Record<string, string> = {
      'Content-Type': 'application/json',
      // Upstream internal services trust the identity headers below only from
      // the gateway; the secret is what proves this hop is the gateway.
      'x-internal-secret': INTERNAL_SECRET,
    }

    // Forward auth headers
    if (req.headers['x-reader-id']) headers['x-reader-id'] = req.headers['x-reader-id'] as string
    if (req.headers['x-reader-pubkey']) headers['x-reader-pubkey'] = req.headers['x-reader-pubkey'] as string
    if (req.headers['x-writer-id']) headers['x-writer-id'] = req.headers['x-writer-id'] as string

    const fetchOpts: RequestInit = {
      method,
      headers,
      // Bound the proxy hop — a hung upstream becomes a 502, not a hung client.
      signal: AbortSignal.timeout(15_000),
    }
    if (method !== 'GET' && method !== 'HEAD' && req.body) {
      fetchOpts.body = JSON.stringify(req.body)
    }

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
    return reply.status(502).send({ error: 'Upstream service error' })
  }
}
