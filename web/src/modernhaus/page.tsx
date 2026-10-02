import type { ReactElement } from 'react'
import { call, GatewayFault, type GatewayContext } from './gateway'
import { ensureCsrfToken } from './csrf'
import { htmlResponse, redirectResponse } from './respond'
import { outcomeFromQuery, safeReturn, GENERIC_FAULT, type Outcome } from './outcomes'
import { Document, type Viewer, type UnreadCounts, type ViewerMoney, type ViewerTerms } from './html'

// =============================================================================
// modernhaus — the GET pipeline every page runs (MODERNHAUS-ADR §D1.2, §D2.2).
//
//   1. Mint the CSRF cookie if the viewer has none, so the page's forms work.
//   2. Read `/auth/me`, the shell's ONE primary read. 401/403/404 are the
//      route's own "no usable session" and mean signed out; a throw or a 5xx is
//      the fault page — never "signed out" (root CLAUDE.md: a normal return
//      never also means "we are broken").
//   3. A member with no age declaration is sent to the age step first, before
//      any loader runs, mirroring `requireAuth`'s server-side refusal. The age
//      page itself is the one page that opts out.
//   4. Run the page's loader, then render its body inside the shell.
//
// A loader returns a body, a redirect or "not found"; it throws `GatewayFault`
// for a fault, and the pipeline — not the page — turns that into the 500.
// =============================================================================

export interface PageRequest<P> {
  req: Request
  url: URL
  params: P
  gw: GatewayContext
  viewer: Viewer | null
  csrf: string
}

export type PageResult =
  | {
      kind: 'page'
      title: string
      body: ReactElement
      twin: string | null
      status?: number
      heading?: boolean
    }
  | { kind: 'redirect'; location: string }
  | { kind: 'not_found' }

export const notFound: PageResult = { kind: 'not_found' }

export async function renderHtml(element: ReactElement): Promise<string> {
  // A static import of react-dom/server fails `next build` inside the App
  // Router; a dynamic one builds and runs (§R2.2, proven by probe).
  const { renderToStaticMarkup } = await import('react-dom/server')
  return `<!doctype html>${renderToStaticMarkup(element)}`
}

export function gatewayContext(req: Request): GatewayContext {
  return {
    cookie: req.headers.get('cookie'),
    forwardedFor: req.headers.get('x-forwarded-for'),
    setCookies: [],
  }
}

interface MeBody {
  id: string
  username: string | null
  displayName: string | null
  ageDeclaredAt: string | null
  pubkey?: string | null
  hasPaymentMethod?: unknown
  cardActionRequiredAt?: unknown
  freeAllowanceRemainingPence?: unknown
  stripeConnectKycComplete?: unknown
  terms?: unknown
  canWrite?: unknown
  writerApplication?: unknown
}

/** The four money facts, or undefined if any is missing or mistyped. */
function moneyOf(me: MeBody): ViewerMoney | undefined {
  const allowance = Number(me.freeAllowanceRemainingPence)
  if (
    typeof me.hasPaymentMethod !== 'boolean' ||
    !(me.cardActionRequiredAt === null || typeof me.cardActionRequiredAt === 'string') ||
    me.freeAllowanceRemainingPence === null ||
    me.freeAllowanceRemainingPence === undefined ||
    !Number.isFinite(allowance) ||
    typeof me.stripeConnectKycComplete !== 'boolean'
  ) {
    return undefined
  }
  return {
    hasPaymentMethod: me.hasPaymentMethod,
    cardActionRequiredAt: me.cardActionRequiredAt,
    freeAllowanceRemainingPence: allowance,
    stripeConnectKycComplete: me.stripeConnectKycComplete,
  }
}

function termsStateOf(v: unknown): ViewerTerms | undefined {
  if (!v || typeof v !== 'object') return undefined
  const t = v as { version?: unknown; current?: unknown; isCurrent?: unknown }
  if (typeof t.current !== 'string' || typeof t.isCurrent !== 'boolean') return undefined
  if (!(t.version === null || typeof t.version === 'string')) return undefined
  return { version: t.version, current: t.current, isCurrent: t.isCurrent }
}

function termsOf(me: MeBody): Viewer['terms'] {
  const t = me.terms as { reader?: unknown; writer?: unknown } | undefined
  const reader = termsStateOf(t?.reader)
  const writer = termsStateOf(t?.writer)
  return reader && writer ? { reader, writer } : undefined
}

/** The viewer, or null when signed out. Throws on a fault. */
export async function loadViewer(gw: GatewayContext): Promise<Viewer | null> {
  const me = await call<MeBody>(gw, 'GET', '/auth/me')
  if (me.status === 401 || me.status === 403 || me.status === 404) return null
  if (me.status !== 200 || !me.body || typeof me.body.id !== 'string') {
    throw new GatewayFault(`/auth/me answered ${me.status}`)
  }
  // `=== undefined` is a stale or renamed field, and it must not read as
  // "declared": the web's AgeGate learnt that `undefined !== null` fails OPEN
  // (security.md, the age rule). Treat it as a fault instead.
  if (me.body.ageDeclaredAt === undefined) throw new GatewayFault('/auth/me carried no ageDeclaredAt')
  return {
    id: me.body.id,
    username: me.body.username,
    displayName: me.body.displayName,
    ageDeclaredAt: me.body.ageDeclaredAt,
    pubkey: typeof me.body.pubkey === 'string' ? me.body.pubkey : null,
    money: moneyOf(me.body),
    terms: termsOf(me.body),
    canWrite: me.body.canWrite === true,
    writerApplication: applicationOf(me.body.writerApplication),
  }
}

/** `{ appliedAt }` when the payload carries one in that shape, else null. */
function applicationOf(v: unknown): Viewer['writerApplication'] {
  if (!v || typeof v !== 'object') return null
  const appliedAt = (v as { appliedAt?: unknown }).appliedAt
  return typeof appliedAt === 'string' ? { appliedAt } : null
}

/**
 * The nav's counts — a SECONDARY read (§D2.2). Any failure is null, which
 * renders the links with no count: an outage must not read as "(0)".
 */
export async function loadUnreadCounts(gw: GatewayContext): Promise<UnreadCounts | null> {
  try {
    const a = await call<{ notificationCount?: unknown; dmCount?: unknown }>(gw, 'GET', '/unread-counts')
    if (a.status !== 200 || !a.body) return null
    const n = Number(a.body.notificationCount)
    const m = Number(a.body.dmCount)
    if (!Number.isFinite(n) || !Number.isFinite(m)) return null
    return { notifications: n, messages: m }
  } catch (err) {
    console.warn('[modernhaus] unread counts unavailable', err instanceof GatewayFault ? err.message : err)
    return null
  }
}

function cookiesFor(csrfCookie: string | null, gw: GatewayContext): string[] {
  return csrfCookie ? [csrfCookie, ...gw.setCookies] : [...gw.setCookies]
}

export async function faultResponse(status: number, cookies: string[]): Promise<Response> {
  const html = await renderHtml(
    <Document title="Something went wrong" viewer="unknown" twin={null} outcome={null}>
      <p>{GENERIC_FAULT}</p>
    </Document>,
  )
  return htmlResponse(html, status, cookies)
}

async function notFoundResponse(viewer: Viewer | null, csrf: string, cookies: string[]): Promise<Response> {
  const html = await renderHtml(
    <Document title="Not found" viewer={viewer} twin={null} outcome={null} csrf={csrf}>
      <p>There is nothing at this address.</p>
      <p>
        <a href="/modernhaus">Go to the start</a>
      </p>
    </Document>,
  )
  return htmlResponse(html, 404, cookies)
}

/**
 * A whole page from outside the GET pipeline: the door re-renders a form with
 * what was typed (a 400 carrying the gateway's sentence, §D2.5.3) this way.
 */
export async function documentResponse(opts: {
  title: string
  viewer: Viewer | null
  csrf: string
  twin: string | null
  outcome: Outcome | null
  body: ReactElement
  status: number
  cookies: string[]
  /** False for a page whose body carries its own `<h1>` (the unlock's article). */
  heading?: boolean
  counts?: UnreadCounts | null
}): Promise<Response> {
  const html = await renderHtml(
    <Document
      title={opts.title}
      viewer={opts.viewer}
      twin={opts.twin}
      outcome={opts.outcome}
      csrf={opts.csrf}
      heading={opts.heading}
      counts={opts.counts ?? null}
    >
      {opts.body}
    </Document>,
  )
  return htmlResponse(html, opts.status, opts.cookies)
}

/** Where the age step sends a member who arrived on `path`. */
export function ageStepLocation(url: URL): string {
  const back = safeReturn(url.pathname + url.search)
  return back && back !== '/modernhaus/age' && !back.startsWith('/modernhaus/age?')
    ? `/modernhaus/age?return=${encodeURIComponent(back)}`
    : '/modernhaus/age'
}

type RouteArgs<P> = { params: P }

export interface PageOptions {
  /** The age page alone: an undeclared member must be able to reach it. */
  allowUndeclared?: boolean
}

/** A GET route handler for one modernhaus page. */
export function modernhausPage<P = Record<string, never>>(
  load: (r: PageRequest<P>) => Promise<PageResult>,
  opts: PageOptions = {},
): (req: Request, args: RouteArgs<P>) => Promise<Response> {
  return async (req, args) => {
    const { token, setCookie } = ensureCsrfToken(req)
    const gw = gatewayContext(req)
    let viewer: Viewer | null = null
    try {
      viewer = await loadViewer(gw)
      const url = new URL(req.url)
      if (viewer && viewer.ageDeclaredAt === null && !opts.allowUndeclared) {
        return redirectResponse(ageStepLocation(url), cookiesFor(setCookie, gw))
      }

      // The counts are read beside the page, never before it, and a page that
      // redirects or 404s simply does not show them.
      const [result, counts] = await Promise.all([
        load({ req, url, params: args.params, gw, viewer, csrf: token }),
        viewer ? loadUnreadCounts(gw) : Promise.resolve(null),
      ])

      if (result.kind === 'redirect') return redirectResponse(result.location, cookiesFor(setCookie, gw))
      if (result.kind === 'not_found') return notFoundResponse(viewer, token, cookiesFor(setCookie, gw))

      const html = await renderHtml(
        <Document
          title={result.title}
          viewer={viewer}
          twin={result.twin}
          outcome={outcomeFromQuery(url.searchParams)}
          heading={result.heading}
          csrf={token}
          counts={counts}
        >
          {result.body}
        </Document>,
      )
      return htmlResponse(html, result.status ?? 200, cookiesFor(setCookie, gw))
    } catch (err) {
      // Logged with its cause; the member reads one fixed sentence. The detail
      // is the operator's (security.md: a fault of ours answers a fixed message).
      // The PATH only: a query can carry a one-use token (verify, export).
      console.error('[modernhaus] page fault', new URL(req.url).pathname, err)
      return faultResponse(500, cookiesFor(setCookie, gw))
    }
  }
}
