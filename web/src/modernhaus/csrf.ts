import { randomBytes, timingSafeEqual } from 'node:crypto'

// =============================================================================
// modernhaus — CSRF: a double-submit token, plus the origin headers where the
// browser sends them (MODERNHAUS-ADR §D1.6).
//
// The gateway's implicit CSRF defence is that it speaks only JSON, which a
// cross-site HTML form cannot send. modernhaus's door turns form bodies into
// JSON, so it reopens that door and has to close it itself (§R1.1.1).
//
// THE TOKEN is 32 random bytes in a cookie, repeated in every form's hidden
// `_csrf` field. A cross-site page can neither read nor set a `__Host-` cookie,
// so it cannot make the two agree. `SameSite=Lax` alone was not enough: it is
// same-SITE, not same-origin, and text browsers (lynx, w3m), a real part of
// this register's audience, send neither `Origin` nor `Sec-Fetch-Site` — so
// for them the token is the whole defence (§R2.4).
//
// THE ORIGIN is the request's own (`X-Forwarded-Proto` + `Host`, both set by
// nginx), not `APP_URL`, which the web container is not given. A browser
// cannot forge either header on a cross-site request, and the `Host` it sends
// is the site it is talking to.
//
// `__Host-` requires `Secure`, which a plain-http dev request cannot carry, so
// over http the cookie is plain `mh_csrf` — decided per request, and the check
// reads the name the same request would have been given.
// =============================================================================

export const CSRF_FIELD = '_csrf'

export function isHttps(req: Request): boolean {
  const proto = req.headers.get('x-forwarded-proto')
  if (proto) return proto.split(',')[0].trim() === 'https'
  return new URL(req.url).protocol === 'https:'
}

export function csrfCookieName(req: Request): string {
  return isHttps(req) ? '__Host-mh_csrf' : 'mh_csrf'
}

/** The request's own origin, as the browser addressed it. */
export function requestOrigin(req: Request): string {
  const host = req.headers.get('host') ?? new URL(req.url).host
  return `${isHttps(req) ? 'https' : 'http'}://${host}`
}

export function readCookie(req: Request, name: string): string | null {
  const header = req.headers.get('cookie')
  if (!header) return null
  for (const part of header.split(';')) {
    const eq = part.indexOf('=')
    if (eq === -1) continue
    if (part.slice(0, eq).trim() === name) return part.slice(eq + 1).trim()
  }
  return null
}

const TOKEN_RE = /^[A-Za-z0-9_-]{43}$/

/**
 * The viewer's token, minting one when the request carried none (or a
 * malformed one). `setCookie` is present exactly when a new one was minted.
 */
export function ensureCsrfToken(req: Request): { token: string; setCookie: string | null } {
  const name = csrfCookieName(req)
  const existing = readCookie(req, name)
  if (existing && TOKEN_RE.test(existing)) return { token: existing, setCookie: null }
  const token = randomBytes(32).toString('base64url')
  const attrs = ['Path=/', 'HttpOnly', 'SameSite=Lax']
  if (isHttps(req)) attrs.push('Secure')
  return { token, setCookie: `${name}=${token}; ${attrs.join('; ')}` }
}

function sameToken(a: string, b: string): boolean {
  const x = Buffer.from(a)
  const y = Buffer.from(b)
  return x.length === y.length && timingSafeEqual(x, y)
}

export type CsrfRefusal = 'no_cookie' | 'mismatch' | 'cross_site' | 'wrong_origin'

/** Null when the write may run; otherwise why it may not. */
export function checkCsrf(req: Request, submitted: string | null): CsrfRefusal | null {
  const cookie = readCookie(req, csrfCookieName(req))
  if (!cookie || !TOKEN_RE.test(cookie)) return 'no_cookie'
  if (!submitted || !sameToken(cookie, submitted)) return 'mismatch'
  const site = req.headers.get('sec-fetch-site')
  if (site !== null && site !== 'same-origin') return 'cross_site'
  const origin = req.headers.get('origin')
  if (origin !== null && origin !== requestOrigin(req)) return 'wrong_origin'
  return null
}
