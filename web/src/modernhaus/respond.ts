// =============================================================================
// modernhaus — every response is built here (MODERNHAUS-ADR §D1.5).
//
// Pages never set headers. Every modernhaus answer carries the same four:
//
//   - `Cache-Control: private, no-store, no-transform` — every page is per
//     viewer, and paywalled plaintext is served here from E5, so nothing may be
//     stored anywhere; `no-transform` asks the CDN not to rewrite the HTML
//     (§R2.10.3).
//   - Its own CSP, `default-src 'none'`: no script, no style, no frame, no
//     font, no fetch. nginx adds the site CSP too, and two CSPs are both
//     enforced, so anything a CDN injects cannot run. `img-src https: data:`
//     is the one allowance, for pictures that are content.
//   - `Referrer-Policy: same-origin`.
//   - `Content-Type: text/html; charset=utf-8` (downloads, E5, differ).
// =============================================================================

export const CSP =
  "default-src 'none'; img-src https: data:; form-action 'self'; frame-ancestors 'none'; base-uri 'none'"

export function baseHeaders(): Headers {
  const h = new Headers()
  h.set('Cache-Control', 'private, no-store, no-transform')
  h.set('Content-Security-Policy', CSP)
  h.set('Referrer-Policy', 'same-origin')
  return h
}

function withCookies(h: Headers, cookies: readonly string[]): Headers {
  for (const c of cookies) h.append('Set-Cookie', c)
  return h
}

export function htmlResponse(html: string, status: number, cookies: readonly string[]): Response {
  const h = withCookies(baseHeaders(), cookies)
  h.set('Content-Type', 'text/html; charset=utf-8')
  return new Response(html, { status, headers: h })
}

/** A 303 to a path WE built or validated. Never pass it a value off the request. */
export function redirectResponse(location: string, cookies: readonly string[]): Response {
  const h = withCookies(baseHeaders(), cookies)
  h.set('Location', location)
  return new Response(null, { status: 303, headers: h })
}

/**
 * A download (§D1.5): the gateway's JSON, as a file. The same fixed headers as
 * a page, and `no-store` above all — it is the member's own data.
 */
export function downloadResponse(body: string, filename: string, cookies: readonly string[]): Response {
  const h = withCookies(baseHeaders(), cookies)
  h.set('Content-Type', 'application/json; charset=utf-8')
  h.set('Content-Disposition', `attachment; filename="${filename.replace(/[^A-Za-z0-9._-]/g, '_')}"`)
  return new Response(body, { status: 200, headers: h })
}
