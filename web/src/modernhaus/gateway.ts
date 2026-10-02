// =============================================================================
// modernhaus — the ONE gateway client (MODERNHAUS-ADR §D1.4).
//
// Every read and write modernhaus makes goes through `call`. It forwards the
// viewer's `Cookie` and `X-Forwarded-For` verbatim, so the gateway sees the
// same session and derives the same `req.ip` as it does for the full site's
// `/api` calls (§R2.3); it never caches, because every answer is per-viewer;
// and it hands back every `Set-Cookie` the gateway sent, for the response to
// copy on.
//
// A NORMAL RETURN NEVER MEANS "WE ARE BROKEN" (root CLAUDE.md). A fetch that
// throws, and a 2xx whose body is not JSON, are re-thrown as a `GatewayFault`
// — never mapped to a status, never to null, never to "signed out". A 5xx is
// returned as the status it is, so the one caller that must read one (the
// unlock's post-payment 502, E5) can; every other caller passes the answer
// through `must`, which turns it into the fault.
//
// Paths are built with the `path` tag, which ENCODES every interpolation.
// Next hands a route param over DECODED, so `%2F..%2Fadmin` would otherwise
// arrive as `../admin` and undici would normalise it into a different gateway
// path (security.md; `web/tests/ssr-fetch-encoding.test.ts` is the same rule
// for the full site's pages).
// =============================================================================

const GATEWAY =
  process.env.GATEWAY_INTERNAL_URL ?? process.env.GATEWAY_URL ?? 'http://localhost:3000'

const API = `${GATEWAY}/api/v1`

/** The request-scoped facts every gateway call carries. */
export interface GatewayContext {
  cookie: string | null
  forwardedFor: string | null
  /** Every `Set-Cookie` any call in this request received, in order. The
   *  response copies them all on — a read can refresh the session too
   *  (`requireAuth` re-issues past its half-life), not only a sign-in. */
  setCookies: string[]
}

export interface GatewayAnswer<T = unknown> {
  status: number
  body: T | null
  setCookies: string[]
}

/** A fault of ours: the gateway could not be reached, or answered nonsense. */
export class GatewayFault extends Error {
  constructor(message: string, options?: { cause?: unknown }) {
    super(message, options)
    this.name = 'GatewayFault'
  }
}

/**
 * A gateway path with every interpolated value encoded as ONE segment or one
 * query value. Use it for every path that carries anything from a request.
 */
export function path(strings: TemplateStringsArray, ...values: Array<string | number>): string {
  let out = strings[0]
  values.forEach((v, i) => {
    out += encodeURIComponent(String(v)) + strings[i + 1]
  })
  return out
}

/** A query string from the defined entries only, leading `?` included. */
export function query(params: Record<string, string | number | undefined | null>): string {
  const q = new URLSearchParams()
  for (const [k, v] of Object.entries(params)) {
    if (v !== undefined && v !== null && v !== '') q.set(k, String(v))
  }
  const s = q.toString()
  return s ? `?${s}` : ''
}

export type Method = 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE'

export async function call<T = unknown>(
  ctx: GatewayContext,
  method: Method,
  apiPath: string,
  opts: { json?: unknown; form?: FormData } = {},
): Promise<GatewayAnswer<T>> {
  const headers: Record<string, string> = { accept: 'application/json' }
  if (ctx.cookie) headers.cookie = ctx.cookie
  if (ctx.forwardedFor) headers['x-forwarded-for'] = ctx.forwardedFor
  let body: string | FormData | undefined
  if (opts.form !== undefined) {
    // A REBUILT multipart body (§D1.4): the caller puts in only the parts the
    // route reads, never the member's whole form. No content-type is set, so
    // fetch writes the boundary.
    body = opts.form
  } else if (opts.json !== undefined) {
    headers['content-type'] = 'application/json'
    body = JSON.stringify(opts.json)
  }

  let res: Response
  try {
    res = await fetch(`${API}${apiPath}`, { method, headers, body, cache: 'no-store' })
  } catch (err) {
    throw new GatewayFault(`gateway unreachable: ${method} ${apiPath}`, { cause: err })
  }

  const text = await res.text()
  let parsed: unknown = null
  if (text) {
    try {
      parsed = JSON.parse(text)
    } catch (err) {
      // A refusal with a non-JSON body is still a refusal (a proxy's 413 page,
      // say). A SUCCESS we cannot read is not a success.
      if (res.ok) {
        throw new GatewayFault(`gateway answered ${res.status} with non-JSON: ${method} ${apiPath}`, {
          cause: err,
        })
      }
    }
  }

  const setCookies = res.headers.getSetCookie()
  ctx.setCookies.push(...setCookies)
  return { status: res.status, body: parsed as T | null, setCookies }
}

/** The answer, or the fault page if it is a 5xx. */
export function must<T>(answer: GatewayAnswer<T>, what: string): GatewayAnswer<T> {
  if (answer.status >= 500) throw new GatewayFault(`gateway ${answer.status}: ${what}`)
  return answer
}

/** A 2xx body, or the fault page. For reads whose only other answer is a fault. */
export function okBody<T>(answer: GatewayAnswer<T>, what: string): T {
  must(answer, what)
  if (answer.status < 200 || answer.status >= 300 || answer.body === null) {
    throw new GatewayFault(`gateway ${answer.status}: ${what}`)
  }
  return answer.body
}
