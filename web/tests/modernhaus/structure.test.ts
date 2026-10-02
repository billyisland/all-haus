import { describe, it, expect } from 'vitest'
import { readdirSync, readFileSync, statSync, existsSync } from 'node:fs'
import path from 'node:path'
import { ROUTE_ERRORS, ROUTE_SENTENCES, SUBSCRIBE_REFUSALS } from '../../src/modernhaus/outcomes'

// =============================================================================
// modernhaus's STRUCTURE, read off the files (MODERNHAUS-ADR §D1.9).
//
// 1. NO CLIENT MODULES. A route handler cannot render a `'use client'`
//    component, and the attempt fails at RUNTIME, not at build — so the import
//    graph of everything modernhaus loads is walked and any client module in it
//    fails here instead.
// 2. `react-dom/server` is imported DYNAMICALLY only: a static import fails
//    `next build` inside the App Router (§R2.2).
// 3. Every route file is `force-dynamic`: without it Next may build a GET
//    handler as a static file and serve one viewer's page to everyone.
// 4. THE CONTRACT PIN (testing.md: a type is not a contract). Every gateway
//    path modernhaus calls is read out of its source and found registered in
//    `gateway/src/routes/**`; every route-specific refusal code is found in the
//    gateway file said to send it. Each pin asserts it FOUND something, since a
//    renamed file or a changed call shape would otherwise pass by testing
//    nothing.
// =============================================================================

const WEB = path.resolve(__dirname, '..', '..')
const SRC = path.join(WEB, 'src')
const MH = path.join(SRC, 'modernhaus')
const APP_MH = path.join(SRC, 'app', 'modernhaus')
const GATEWAY_ROUTES = path.resolve(WEB, '..', 'gateway', 'src', 'routes')

function walk(dir: string, re: RegExp, out: string[] = []): string[] {
  for (const name of readdirSync(dir)) {
    const p = path.join(dir, name)
    if (statSync(p).isDirectory()) walk(p, re, out)
    else if (re.test(name)) out.push(p)
  }
  return out
}

/** Comments out, so a pin reads CODE (uk-dates.test.ts learnt this). */
function code(src: string): string {
  return src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/.*$/gm, '$1')
}

function resolveImport(from: string, spec: string): string | null {
  let base: string
  if (spec.startsWith('@/')) base = path.join(SRC, spec.slice(2))
  else if (spec.startsWith('.')) base = path.resolve(path.dirname(from), spec)
  else return null // a package
  for (const cand of [base, `${base}.ts`, `${base}.tsx`, path.join(base, 'index.ts'), path.join(base, 'index.tsx')]) {
    if (existsSync(cand) && statSync(cand).isFile()) return cand
  }
  throw new Error(`unresolved import ${spec} from ${from}`)
}

// `import x from 'y'`, `export { x } from 'y'` and a bare `import 'y'`; a
// type-only import is erased at build and loads nothing.
const IMPORT_RE = /(?:^|\n)\s*(?:(?:import|export)\s+(?!type\b)[^'"]*?from\s+|import\s+)['"]([^'"]+)['"]/g

function graph(entries: string[]): Set<string> {
  const seen = new Set<string>()
  const stack = [...entries]
  while (stack.length) {
    const file = stack.pop()!
    if (seen.has(file)) continue
    seen.add(file)
    for (const m of readFileSync(file, 'utf8').matchAll(IMPORT_RE)) {
      const next = resolveImport(file, m[1])
      if (next) stack.push(next)
    }
  }
  return seen
}

const ROUTE_FILES = walk(APP_MH, /^route\.tsx?$/)
const MODULES = graph([...ROUTE_FILES, ...walk(MH, /\.tsx?$/)])

describe('modernhaus imports', () => {
  it('walked the graph it meant to', () => {
    expect(ROUTE_FILES.length).toBeGreaterThanOrEqual(15)
    // It reaches well outside modernhaus (lib/markdown, content/legal, …).
    expect([...MODULES].filter((f) => !f.startsWith(MH) && !f.startsWith(APP_MH)).length).toBeGreaterThan(5)
  })

  it('reaches no client module', () => {
    const client = [...MODULES].filter((f) => /^\s*['"]use client['"]/.test(readFileSync(f, 'utf8')))
    expect(client.map((f) => path.relative(SRC, f))).toEqual([])
  })

  it('imports react-dom/server dynamically only', () => {
    const offenders = [...MODULES].filter((f) =>
      /(?:^|\n)\s*import\s[^;]*?from\s+['"]react-dom\/server['"]/.test(readFileSync(f, 'utf8')),
    )
    expect(offenders).toEqual([])
    expect(readFileSync(path.join(MH, 'page.tsx'), 'utf8')).toContain("await import('react-dom/server')")
  })

  it('every JSX picture is lazy, so the served head carries no preload <link>', () => {
    // Next's vendored React (not the test runtime's) hoists a
    // `<link rel="preload" as="image">` into <head> for every <img> that is not
    // `loading="lazy"`. The ornament sweep renders with the test runtime and
    // cannot see it, so this reads the source instead (MODERNHAUS-ADR §E3.2).
    const imgs = walk(MH, /\.tsx$/).flatMap((f) =>
      [...code(readFileSync(f, 'utf8')).matchAll(/<img\b[^>]*>/g)].map((m) => ({ f, tag: m[0] })),
    )
    expect(imgs.length).toBeGreaterThan(0)
    for (const { f, tag } of imgs) expect(tag, path.relative(SRC, f)).toContain('loading="lazy"')
  })

  it('every route file is force-dynamic', () => {
    for (const f of ROUTE_FILES) {
      expect(code(readFileSync(f, 'utf8')), path.relative(SRC, f)).toContain("export const dynamic = 'force-dynamic'")
    }
  })
})

// ---------------------------------------------------------------------------
// The contract pin.
// ---------------------------------------------------------------------------

/** `(gw, 'GET', path\`/writers/${u}/notes\` + qs)` → ['GET', '/writers/:p/notes']. */
function modernhausCalls(): Array<{ method: string; route: string; file: string }> {
  const out: Array<{ method: string; route: string; file: string }> = []
  for (const f of walk(MH, /\.tsx?$/)) {
    const src = code(readFileSync(f, 'utf8'))
    // A call — `call(gw, …)` or `call(ctx.gw, …)` — and a simple registry
    // entry, whose method and path are two properties of one object.
    const shapes = [
      /\(\s*(?:\w+\.)?gw,\s*'([A-Z]+)',\s*(?:path)?(['`])(\/[^'`]*?)\2/g,
      /method:\s*'([A-Z]+)',[\s\S]{0,300}?path:\s*\([^)]*\)\s*=>\s*(?:path)?(['`])(\/[^'`]*?)\2/g,
    ]
    for (const re of shapes) {
      for (const m of src.matchAll(re)) {
        out.push({ method: m[1], route: m[3].replace(/\$\{[^}]*\}/g, ':p'), file: path.relative(SRC, f) })
      }
    }
  }
  return out
}

/** Every `app.<method>(…'/path'…)` the gateway registers, params normalised. */
function gatewayRoutes(): Set<string> {
  const routes = new Set<string>()
  for (const f of walk(GATEWAY_ROUTES, /\.ts$/)) {
    const src = code(readFileSync(f, 'utf8'))
    // The feeds plugin is mounted under /workspace (gateway/src/index.ts);
    // formulas.ts registers its public half without the prefix, so both
    // spellings are admitted for files under routes/feeds.
    const prefixes = f.includes(`${path.sep}feeds${path.sep}`) ? ['', '/workspace'] : ['']
    for (const m of src.matchAll(/app\.(get|post|put|patch|delete)\b[\s\S]{0,400}?\(\s*(['"`])(\/[^'"`\s]*)\2/g)) {
      for (const pre of prefixes) {
        routes.add(`${m[1].toUpperCase()} ${pre}${m[3].replace(/:[A-Za-z_]+/g, ':p')}`)
      }
    }
  }
  return routes
}

describe('the contract pin', () => {
  const calls = modernhausCalls()
  const routes = gatewayRoutes()

  it('found the calls and the routes (it is not vacuous)', () => {
    expect(calls.length).toBeGreaterThanOrEqual(60)
    expect(routes.size).toBeGreaterThan(100)
    expect(calls.map((c) => c.route)).toContain('/auth/me')
    // Both shapes are read: an orchestrated call and a simple entry.
    expect(calls.map((c) => `${c.method} ${c.route}`)).toEqual(
      expect.arrayContaining([
        'POST /auth/verify', 'POST /auth/login', 'POST /auth/logout', 'POST /waitlist',
        // E3: an orchestrated call, a secondary read and a simple entry each.
        'POST /sign-and-publish', 'GET /votes/tally', 'GET /thread/:p/top', 'PATCH /workspace/feeds/:p',
        // E4: the publish-now door, the multipart upload, a note's index and a draft's save.
        'POST /drafts/:p/publish', 'POST /media/upload', 'POST /notes', 'POST /drafts', 'DELETE /drafts/:p/schedule',
        // E5: the unlock's three steps, the arrival, the terms, a subscription, the tab.
        'POST /articles/:p/gate-pass', 'POST /unwrap-key', 'POST /articles/:p/arrival', 'POST /auth/accept-terms',
        'POST /subscriptions/:p', 'DELETE /subscriptions/:p', 'POST /my/tab/settle', 'GET /my/tab',
        'GET /my/account-statement', 'GET /my/receipts/:p', 'GET /receipts/export', 'PATCH /my/payout-preferences',
        'DELETE /auth/payment-method', 'POST /auth/upgrade-writer', 'GET /subscription-offers/redeem/:p',
      ]),
    )
  })

  for (const c of calls) {
    it(`${c.method} ${c.route} (${c.file}) is a gateway route`, () => {
      expect(routes.has(`${c.method} ${c.route}`)).toBe(true)
    })
  }

  it('every route SENTENCE this register carries under its own code is found, verbatim, in the file said to send it', () => {
    // E5: a settlement's outcomes, a card that would not detach, the subscribe
    // route's English refusals. A re-worded route fails here, not on a member.
    expect(Object.keys(ROUTE_SENTENCES).length).toBeGreaterThanOrEqual(13)
    for (const [code, { sentence, sentBy }] of Object.entries(ROUTE_SENTENCES)) {
      const src = readFileSync(path.resolve(WEB, '..', sentBy), 'utf8')
      expect(src.includes(sentence), `${code}: "${sentence}" in ${sentBy}`).toBe(true)
    }
  })

  it('every subscribe refusal this register maps is the code, status and message the route sends', () => {
    expect(Object.keys(SUBSCRIBE_REFUSALS).length).toBe(4)
    const terms = readFileSync(path.resolve(WEB, '..', 'gateway/src/lib/terms-gate.ts'), 'utf8')
    for (const [ours, r] of Object.entries(SUBSCRIBE_REFUSALS)) {
      const src = readFileSync(path.resolve(WEB, '..', r.sentBy), 'utf8')
      // The terms code rides a constant from its one home; the others are literal.
      const codeFound =
        src.includes(`'${r.error}'`) ||
        (r.error === 'reader_terms_required' && terms.includes(`READER_TERMS_REQUIRED = "${r.error}"`) && src.includes('READER_TERMS_REQUIRED'))
      expect(codeFound, `${ours}: ${r.error}`).toBe(true)
      expect(new RegExp(`status\\(${r.status}\\)[\\s\\S]{0,120}${r.error === 'reader_terms_required' ? 'READER_TERMS_REQUIRED' : r.error}`).test(src), `${ours}: ${r.status}`).toBe(true)
      if (r.message) expect(src.includes(r.message), `${ours}: message`).toBe(true)
    }
  })

  it('every route-specific refusal code is sent by the file named beside it', () => {
    for (const [code, { sentBy }] of Object.entries(ROUTE_ERRORS)) {
      const src = readFileSync(path.resolve(WEB, '..', sentBy), 'utf8')
      expect(src.includes(`"${code}"`) || src.includes(`'${code}'`), `${code} in ${sentBy}`).toBe(true)
    }
  })
})

// ---------------------------------------------------------------------------
// The response fields E3 reads, found in the route that sends them. A field
// nobody sends is a branch that never runs — a capped vote reading as counted,
// a locked piece drawing its conversation — and nothing else would say so.
// ---------------------------------------------------------------------------

describe('the fields E3, E4 and E5 read off the wire', () => {
  const ROOT = path.resolve(WEB, '..')
  const pins: Array<[string, string, RegExp]> = [
    ['gateway/src/routes/notifications.ts', 'the nav counts', /notificationCount:[\s\S]{0,80}dmCount:/],
    ['gateway/src/routes/votes.ts', 'a capped vote', /counted: false/],
    ['gateway/src/routes/votes.ts', 'the tally read', /send\(\{ tallies \}\)/],
    ['gateway/src/routes/votes.ts', 'my votes', /send\(\{ voteCounts \}\)/],
    ['gateway/src/routes/replies.ts', 'the locked piece', /paywallLocked: true/],
    ['gateway/src/routes/post-thread.ts', 'the foot at rest', /topLevel: page\.map[\s\S]{0,400}nextOffset:[\s\S]{0,200}totalReplies:/],
    ['gateway/src/routes/post-thread.ts', 'a thread still fetching', /hydrating/],
    ['gateway/src/routes/moderation.ts', 'the report priority', /status\(201\)\.send\(\{[\s\S]{0,80}priority,/],
    ['gateway/src/routes/external-items/interactions.ts', 'a reply not sent on', /crossPost = "not_sent"/],
    ['gateway/src/routes/feeds/crud.ts', 'a stale feed order', /status\(409\)/],
    ['gateway/src/routes/feeds/items.ts', 'the page token', /asOf: string/],
    // E4 — writing.
    ['gateway/src/routes/drafts.ts', 'a saved draft', /draftId: (?:result\.rows\[0\]|row)\.id/],
    ['gateway/src/routes/drafts.ts', 'a new row of its own', /newDraft: z\.literal\(true\)/],
    ['gateway/src/routes/drafts.ts', 'the drafts list', /drafts: rows\.map[\s\S]{0,200}draftId: r\.id[\s\S]{0,200}scheduledAt: r\.scheduled_at/],
    ['gateway/src/routes/drafts.ts', 'a draft read', /content: r\.content_raw[\s\S]{0,400}scheduledAt: r\.scheduled_at/],
    ['gateway/src/routes/drafts.ts', 'the published piece', /status\(201\)\.send\(\{\s*articleId: result\.articleId,\s*dTag: result\.dTag/],
    ['gateway/src/routes/drafts.ts', 'the sendEmail choice', /sendEmail: z\.boolean\(\)\.optional\(\)/],
    ['gateway/src/routes/media.ts', 'the picture address', /url: stored\.url/],
    ['gateway/src/routes/signing.ts', 'the signed event id', /sign-and-publish/],
    ['gateway/src/routes/articles/publish.ts', 'the paid half, for its writer', /contentPaywall,/],
    ['gateway/src/routes/tags.ts', 'an article’s tags', /send\(\{ tags: rows\.map/],
    // E5 — money.
    ['gateway/src/services/article-access/gate-pass.ts', 'the ciphertext on a gate pass', /ciphertext: keyResult\.body\.ciphertext/],
    ['key-custody/src/routes/keypairs.ts', 'the unwrapped content key', /send\(\{ contentKeyBase64 \}\)/],
    ['gateway/src/routes/articles/arrival.ts', 'the arrival’s own gate pass', /gatePass: result\.body/],
    ['gateway/src/routes/articles/gate-pass.ts', 'the gate pass’s refusals', /error: "article_misconfigured"[\s\S]{0,2000}error: READER_TERMS_REQUIRED/],
    ['gateway/src/routes/replies.ts', 'the viewer-scoped lock the gate reads as access', /checkArticleAccess\([\s\S]{0,800}paywallLocked: true/],
    ['gateway/src/routes/auth.ts', 'a moved text', /error: "terms_version_mismatch"/],
    ['gateway/src/routes/auth.ts', 'the open-accounts figures', /open: true, freeAllowancePence, arrivalGiftCapPence/],
    ['gateway/src/routes/my-account.ts', 'the tab’s two figures', /tabBalancePence: Number\([\s\S]{0,1200}refundDuePence: Number\(/],
    ['gateway/src/routes/my-account.ts', 'the settle outcomes', /settled: true,[\s\S]{0,800}reason: "below_minimum"/],
    ['gateway/src/routes/my-account.ts', 'the statement page', /entries: entriesResult\.rows,\s*totalEntries,\s*hasMore:/],
    ['gateway/src/routes/my-account.ts', 'the payout floor', /error: "threshold_below_platform_minimum",\s*platformThresholdPence:/],
    ['gateway/src/routes/receipts.ts', 'the export’s shortfall', /count: receipts\.length,\s*skipped,/],
    ['gateway/src/routes/subscriptions/writer.ts', 'a subscription check', /subscribed: true,\s*subscriptionId:/],
    ['shared/src/auth/accounts.ts', 'the Connect hand-off', /return \{ stripeConnectUrl: onboardingUrl \}/],
    // E6 — the rest.
    ['gateway/src/services/messages.ts', 'the inbox row', /lastMessageAt: r\.last_message_at[\s\S]{0,200}unreadCount: r\.unread_count/],
    ['gateway/src/services/messages.ts', 'a conversation page and its cursor', /data: \{ messages, nextCursor \}/],
    ['gateway/src/services/messages.ts', 'a message row', /counterpartyPubkey: r\.sender_id === userId[\s\S]{0,120}contentEnc: r\.content_enc/],
    ['gateway/src/services/messages.ts', 'a conversation started or reused', /data: \{ conversationId \}/],
    ['gateway/src/routes/messages.ts', 'the decrypted batch', /send\(\{ results \}\)/],
    ['gateway/src/routes/messages.ts', 'a like toggled', /send\(\{ liked: result\.data\.reacted \}\)/],
    ['gateway/src/routes/messages.ts', 'the link refusal', /error: DM_LINKS_REFUSED, message: DM_NO_LINKS_MESSAGE/],
    ['gateway/src/routes/social.ts', 'the viewer’s relation', /"\/my\/relations\/:userId"/],
    ['gateway/src/routes/writers.ts', 'the relation on a profile', /\.\.\.\(viewer \? \{ viewer \} : \{\}\)/],
    ['gateway/src/routes/linked-accounts.ts', 'the network hand-off', /authorizeUrl: buildMastodonAuthorizeUrl/],
    ['gateway/src/routes/linked-accounts.ts', 'the import capabilities', /followImportProtocols: followImportEnabled\(\)[\s\S]{0,1200}followImportOpml: followImportEnabled\(\)/],
    ['gateway/src/routes/follow-imports.ts', 'an OPML upload’s runs and plan', /runs: created\.map[\s\S]{0,1400}plan: \{/],
    ['gateway/src/routes/reading-log.ts', 'the log’s paging and window', /hasMore: \(more\.rowCount \?\? 0\) > 0,\s*retentionDays:/],
    ['gateway/src/routes/reading-positions.ts', 'the log switch', /readingLogEnabled: rows\[0\]\.reading_log_enabled/],
    ['gateway/src/routes/reading-log.ts', 'the log cleared', /deleted: rowCount \?\? 0/],
    ['gateway/src/routes/library.ts', 'a library row', /acquiredAt: r\.acquired_at\.toISOString\(\)[\s\S]{0,200}dTag: r\.nostr_d_tag/],
    ['gateway/src/routes/articles/manage.ts', 'a writer’s piece', /repliesEnabled: r\.comments_enabled[\s\S]{0,200}netEarningsPence: r\.net_earnings_pence/],
    ['gateway/src/routes/gift-links.ts', 'the gift links', /giftLinks: rows\.map/],
    ['gateway/src/routes/subscriptions/settings.ts', 'the welcome message', /send\(\{ message: rows\[0\]\.subscription_welcome_message \}\)/],
    ['gateway/src/routes/feeds/formulas.ts', 'a redeemed feed', /status\(201\)\.send\(result\)/],
    ['gateway/src/routes/privacy-preferences.ts', 'the three switches', /discoveryEnabled: z\.boolean\(\)\.optional\(\)[\s\S]{0,200}discoverableByEmail: z\.boolean\(\)\.optional\(\)/],
    ['gateway/src/routes/export.ts', 'a spent export link', /error: 'step_up_invalid'/],
  ]
  for (const [file, what, re] of pins) {
    it(`${what} (${file})`, () => {
      expect(re.test(readFileSync(path.join(ROOT, file), 'utf8'))).toBe(true)
    })
  }
})

// ---------------------------------------------------------------------------
// DIRECT MESSAGES ARE TEXT ONLY IN ALL THREE HALVES (security.md). This
// register is a third renderer; it must not become the one that turns a
// message into a link. Read with comments stripped: the rule's own words
// would otherwise satisfy a grep for them.
// ---------------------------------------------------------------------------

describe('a direct message is never linked', () => {
  it('the thread page renders bodies as text and never asks for links', () => {
    const src = code(readFileSync(path.join(MH, 'pages', 'messages.tsx'), 'utf8'))
    expect(src).toContain('<TextParagraphs text={m.content} />')
    expect(src).not.toMatch(/linkify/)
    expect(src).not.toMatch(/dangerouslySetInnerHTML/)
  })
})
