import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import {
  admin,
  REPORT_ACTIONS,
  REPORT_CATEGORIES,
  isResolved,
} from '../src/lib/api/admin'

// =============================================================================
// The admin moderation client must speak the gateway's vocabulary.
//
// It did not, for as long as the page existed: it sent `remove|suspend|dismiss`
// against a zod enum of `no_action|remove_content|suspend_account`, so every
// action was a 400, and `?status=pending` against a route that reads only
// `?all=true`, so the Resolved tab returned the open list. Both typechecked —
// a hand-written string union is a claim about a server that nothing checks.
//
// Reads the gateway source rather than importing it, because there is no
// module path between the two workspaces (same reason, and same shape, as
// `volume-scale-parity.test.ts`). That is also why this test has to exist.
//
// THREE VOCABULARIES NOW, not one (L6.3/L6.4). The ACTIONS grew from three to
// D7 §5's six-rung ladder, the CATEGORIES from four to D1 §9.2's twelve
// priority offences, and `report_status` gained a fifth value because `warn`
// is neither a removal nor no action. Every one of them crosses the workspace
// boundary as a string, so every one of them is pinned against the file that
// owns it — the two enums against `schema.sql`, the two client arrays against
// the gateway's own source — and each pin asserts the match was FOUND, since a
// renamed constant otherwise makes this suite pass by testing nothing.
// =============================================================================

const MODERATION = join(__dirname, '../../gateway/src/routes/moderation.ts')
const TAXONOMY = join(__dirname, '../../gateway/src/lib/report-taxonomy.ts')
const SCHEMA = join(__dirname, '../../schema.sql')

function gatewaySource(): string {
  return readFileSync(MODERATION, 'utf8')
}

/** Pull a `const NAME = [ … ] as const` array of string literals out of TS. */
function constArray(src: string, name: string): string[] | null {
  const m = src.match(new RegExp(`const ${name} = \\[([\\s\\S]*?)\\] as const`))
  if (!m) return null
  return m[1]
    .split(',')
    .map((s) => s.trim().replace(/^['"]|['"]$/g, ''))
    .filter((s) => s.length > 0 && !s.startsWith('//'))
}

/** Pull an enum's values out of `schema.sql`. */
function sqlEnum(name: string): string[] | null {
  const schema = readFileSync(SCHEMA, 'utf8')
  const m = schema.match(
    new RegExp(`CREATE TYPE public\\.${name} AS ENUM \\(([\\s\\S]*?)\\);`)
  )
  if (!m) return null
  return m[1]
    .split(',')
    .map((s) => s.trim().replace(/^'|'$/g, ''))
    .filter(Boolean)
}

describe('admin report actions — parity with the gateway', () => {
  it('sends exactly the actions ResolveReportSchema accepts', () => {
    const src = gatewaySource()
    // The gateway declares the ladder as its own `as const` array and hands it
    // to zod, for the same reason this file does: a bare union cannot be
    // compared against anything at test time.
    const gateway = constArray(src, 'REPORT_ACTIONS')
    expect(gateway, 'gateway REPORT_ACTIONS not found — was it renamed?').toBeTruthy()

    // And the schema really does take THAT array, not some other enum.
    const schema = src.match(/const ResolveReportSchema = z\.object\(\{([\s\S]*?)^\}\)/m)
    expect(schema, 'gateway ResolveReportSchema not found — was it renamed?').toBeTruthy()
    expect(schema![1]).toMatch(/action: z\.enum\(\s*REPORT_ACTIONS/)

    expect([...REPORT_ACTIONS].sort()).toEqual([...gateway!].sort())
  })

  it('offers exactly the categories the gateway accepts and the column can hold', () => {
    const taxonomy = readFileSync(TAXONOMY, 'utf8')
    const gateway = constArray(taxonomy, 'REPORT_CATEGORIES')
    expect(gateway, 'gateway REPORT_CATEGORIES not found — was it renamed?').toBeTruthy()
    expect([...REPORT_CATEGORIES].sort()).toEqual([...gateway!].sort())

    // The third side of the triangle: the enum the column actually holds. A
    // category both workspaces agree on and Postgres refuses is a 500 on
    // every press, and agreeing with each other is exactly what would hide it.
    const values = sqlEnum('report_category')
    expect(values, 'report_category enum not found in schema.sql').toBeTruthy()
    expect([...REPORT_CATEGORIES].sort()).toEqual([...values!].sort())
  })

  it('derives a priority for every category, and only D7 §2 priorities', () => {
    // The gateway owns the mapping; this asserts it is TOTAL. A category with
    // no priority would file a report with a NULL deadline, which is silently
    // "never overdue" — the worst direction for a figure we publish.
    const taxonomy = readFileSync(TAXONOMY, 'utf8')
    const p0 = taxonomy.match(/const P0: ReadonlySet<string> = new Set\(\[([^\]]*)\]\)/)
    const p2 = taxonomy.match(/const P2: ReadonlySet<string> = new Set\(\[([^\]]*)\]\)/)
    expect(p0, 'P0 set not found in report-taxonomy').toBeTruthy()
    expect(p2, 'P2 set not found in report-taxonomy').toBeTruthy()
    const named = [...p0![1].split(','), ...p2![1].split(',')]
      .map((s) => s.trim().replace(/^['"]|['"]$/g, ''))
      .filter(Boolean)
    // Every named category is a real one — a typo here is a category quietly
    // demoted to P1 with nothing to say so.
    for (const c of named) {
      expect(REPORT_CATEGORIES).toContain(c as never)
    }
  })

  it('narrows the list with the query key the route actually reads', () => {
    const src = gatewaySource()
    // The route reads `all`, and nothing else. `status` is what the client used
    // to send; if it ever becomes real, this assertion is the thing that says so.
    expect(src).toMatch(/req\.query\.all === 'true'/)
    expect(src).not.toMatch(/req\.query\.status/)
  })

  it('names the target fields the gateway will read', () => {
    // L6.3 added three. A target the client sends and the schema does not
    // declare is dropped by zod without complaint, so the report files with no
    // target at all and the queue shows "No target recorded" — a silent
    // failure that looks like a reporter's mistake.
    const src = gatewaySource()
    const schema = src.match(/const SubmitReportSchema = z\.object\(\{([\s\S]*?)^\}\)/m)
    expect(schema, 'SubmitReportSchema not found — was it renamed?').toBeTruthy()
    for (const field of [
      'targetNostrEventId',
      'targetAccountId',
      'targetPostId',
      'targetConversationId',
      'targetProfileId',
    ]) {
      expect(schema![1]).toContain(`${field}:`)
    }
  })
})

describe('admin report client — what goes on the wire', () => {
  let calls: Array<{ url: string; init: RequestInit }>

  beforeEach(() => {
    calls = []
    vi.stubGlobal(
      'fetch',
      vi.fn((url: string, init: RequestInit = {}) => {
        calls.push({ url, init })
        return Promise.resolve({
          ok: true,
          status: 200,
          json: () => Promise.resolve({}),
        } as unknown as Response)
      })
    )
  })

  afterEach(() => {
    vi.unstubAllGlobals()
  })

  it('asks for the open queue with no filter at all', async () => {
    await admin.listReports()
    expect(calls[0].url).toBe('/api/v1/admin/reports')
  })

  it('asks for everything with all=true, never status=', async () => {
    await admin.listReports({ all: true, limit: 100 })
    const url = calls[0].url
    expect(url).toContain('all=true')
    expect(url).toContain('limit=100')
    expect(url).not.toContain('status=')
  })

  it('PATCHes the action verbatim, and ALWAYS carries BOTH sentences', async () => {
    // L5.5b made the reason required (it is what the member is emailed); L6.4
    // made the reasoning required too (D7 §8: the judgement is mandatory even
    // for an obvious call). Omitting either is a 400 on every press.
    await admin.resolveReport(
      'r1',
      'remove_content',
      'illegal under the guidelines',
      'RGI yes — direct incitement, no literary frame'
    )
    expect(calls[0].url).toBe('/api/v1/admin/reports/r1')
    expect(calls[0].init.method).toBe('PATCH')
    expect(JSON.parse(calls[0].init.body as string)).toEqual({
      action: 'remove_content',
      reason: 'illegal under the guidelines',
      reasoning: 'RGI yes — direct incitement, no literary frame',
    })

    await admin.resolveReport('r2', 'suspend_7d', 'repeat offender', 'third upheld report')
    expect(JSON.parse(calls[1].init.body as string)).toEqual({
      action: 'suspend_7d',
      reason: 'repeat offender',
      reasoning: 'third upheld report',
    })
  })

  it("the gateway's schema requires both sentences this client always sends", () => {
    // Read out of the route, not remembered: the client sending a field the
    // server does not require is harmless, and the server requiring one the
    // client does not send is a 400 on every press.
    const src = gatewaySource()
    const schema = src.match(/const ResolveReportSchema = z\.object\(\{([\s\S]*?)^\}\)/m)
    expect(schema, 'ResolveReportSchema not found — was it renamed?').toBeTruthy()
    expect(schema![1]).toMatch(/reason: z\.string\(\)\.trim\(\)\.min\(1\)/)
    expect(schema![1]).toMatch(/reasoning: z\.string\(\)\.trim\(\)\.min\(1\)/)
    expect(schema![1]).not.toMatch(/reason:[^\n]*optional/)
    expect(schema![1]).not.toMatch(/reasoning:[^\n]*optional/)
  })

  it('decides an appeal at the route the gateway registers', async () => {
    await admin.decideAppeal('r3', 'reversed', 're-read: the frame is plainly literary')
    expect(calls[0].url).toBe('/api/v1/admin/reports/r3/appeal')
    expect(calls[0].init.method).toBe('PATCH')
    expect(gatewaySource()).toContain("'/admin/reports/:reportId/appeal'")
  })

  it('raises a priority at the route the gateway registers, with the two fields its schema parses', async () => {
    await admin.raiseReportPriority('r5', 'P0', 'names an address and a time')
    expect(calls[0].url).toBe('/api/v1/admin/reports/r5/priority')
    expect(calls[0].init.method).toBe('PATCH')
    expect(JSON.parse(calls[0].init.body as string)).toEqual({
      priority: 'P0',
      reason: 'names an address and a time',
    })
    const src = gatewaySource()
    expect(src).toContain("'/admin/reports/:reportId/priority'")
    // The reason is REQUIRED there, like every other operator act on a report.
    const schema = src.match(/const RaisePrioritySchema = z\.object\(\{([\s\S]*?)^\}\)/m)
    expect(schema, 'RaisePrioritySchema not found — was it renamed?').toBeTruthy()
    expect(schema![1]).toMatch(/priority: z\.enum\(REPORT_PRIORITIES/)
    expect(schema![1]).toMatch(/reason: z\.string\(\)\.trim\(\)\.min\(1\)/)
    expect(schema![1]).not.toMatch(/reason:[^\n]*optional/)
  })

  it('takes a report under review at the route the gateway registers', async () => {
    await admin.reviewReport('r4')
    expect(calls[0].url).toBe('/api/v1/admin/reports/r4/review')
    expect(calls[0].init.method).toBe('POST')
    expect(gatewaySource()).toContain("'/admin/reports/:reportId/review'")
  })

  it('writes and lifts platform blocks at the routes the gateway registers', async () => {
    await admin.addBlock({ kind: 'npub', target: 'npub1x', reason: 'CSAM' })
    expect(calls[0].url).toBe('/api/v1/admin/blocks')
    expect(calls[0].init.method).toBe('POST')

    await admin.removeBlock('b1', 'mistaken identity')
    expect(calls[1].url).toBe('/api/v1/admin/blocks/b1')
    expect(calls[1].init.method).toBe('DELETE')
    // The lift carries its reason (§0z item 12) — the gateway's BlockLiftSchema
    // requires it, and a DELETE with no body is a 400 on every press.
    expect(JSON.parse(calls[1].init.body as string)).toEqual({ reason: 'mistaken identity' })
    expect(gatewaySource()).toMatch(/const BlockLiftSchema = z\.object\(\{\s*reason: z\.string\(\)\.trim\(\)\.min\(1\)/)

    const src = gatewaySource()
    expect(src).toContain("app.post('/admin/blocks'")
    expect(src).toContain("'/admin/blocks/:id'")
  })
})

describe('isResolved', () => {
  it('is true for every resolved status and false for the two live ones', () => {
    // The old card compared against `'resolved'`, which report_status cannot
    // hold — so every resolved report kept its action buttons. The same fault
    // returns one value at a time: `resolved_actioned` arrived with migration
    // 222, and a predicate that had not learned it would leave a warned report
    // sitting in the queue with a live Terminate button on it.
    expect(isResolved('resolved_removed')).toBe(true)
    expect(isResolved('resolved_no_action')).toBe(true)
    expect(isResolved('resolved_actioned')).toBe(true)
    expect(isResolved('open')).toBe(false)
    expect(isResolved('under_review')).toBe(false)
  })

  it('covers every value report_status can hold', () => {
    const values = sqlEnum('report_status')
    expect(values, 'report_status enum not found in schema.sql').toBeTruthy()
    // Derived, not listed: every value the column can hold is either resolved
    // or live, and this asserts the predicate has an opinion about each — a
    // value added to the enum and not to `isResolved` reads as live for ever.
    expect(values!.length).toBeGreaterThan(4)
    const live = values!.filter((v) => !isResolved(v as never))
    expect(live.sort()).toEqual(['open', 'under_review'])
  })
})

// =============================================================================
// Every refusal code an admin surface BRANCHES ON is one the server SENDS
// (§0ab guard (c)).
//
// A code the web compares against and the gateway never sends is a sentence
// nobody will ever read: the refusal falls through to "Could not …", which is
// the silent press the walkthrough spent a sitting removing. Five codes were
// read with no pin (`already_blocked`, `source_unresolvable`, `not_a_raise`,
// `not_open`, `standing_decision`), and the roster had no branch at all for
// the 409 its suspend button can receive. DERIVED, not listed: the codes are
// read out of each component (`code === '…'` and the keys of a `REFUSAL`
// table), so a branch added later is pinned by being written.
// =============================================================================

const WEB_ADMIN = join(__dirname, '../src/components/admin')
const ADMIN_DASHBOARD = join(__dirname, '../../gateway/src/routes/admin-dashboard.ts')
// payment-service does not ship in the public mirror; in this repo it is
// always present, so nothing below skips here and CI's fail-on-skip holds.
const PAYMENT_ROUTES = join(__dirname, '../../payment-service/src/routes/payment.ts')

/** The refusal codes a component branches on. */
function codesReadBy(file: string): string[] {
  const src = readFileSync(join(WEB_ADMIN, file), 'utf8')
  const compared = [...src.matchAll(/code === '([a-z_]+)'/g)].map((m) => m[1])
  const table = src.match(/const REFUSAL: Record<string, string> = \{([\s\S]*?)^\}/m)
  const keyed = table ? [...table[1].matchAll(/^\s{2}([a-z_]+):/gm)].map((m) => m[1]) : []
  return [...new Set([...compared, ...keyed])].sort()
}

/** Whether any of the owning sources sends `{ error: '<code>' }`. */
function sent(code: string, owners: string[]): boolean {
  const re = new RegExp(`error:\\s*['"]${code}['"]`)
  return owners.some((o) => re.test(readFileSync(o, 'utf8')))
}

describe('every refusal code an admin surface reads is one the server sends', () => {
  it.each([
    ['ReportCard.tsx', [MODERATION], ['not_a_raise', 'not_open', 'no_removable_content']],
    ['PlatformBlocksPanel.tsx', [MODERATION], ['already_blocked', 'source_unresolvable']],
  ] as const)('%s', (file, owners, mustInclude) => {
    const codes = codesReadBy(file)
    // The derivation's own guard: a regex that matched nothing would make
    // every assertion below vacuous.
    for (const c of mustInclude) expect(codes).toContain(c)
    const unsent = codes.filter((c) => !sent(c, [...owners]))
    expect(unsent, `${file} branches on codes no owning route sends`).toEqual([])
  })

  it.skipIf(!existsSync(PAYMENT_ROUTES))('MemberRoster.tsx — including the suspend route\'s standing_decision', () => {
    const codes = codesReadBy('MemberRoster.tsx')
    // The 409 the suspend button can receive since §0z item 14; before this
    // the roster answered it "Could not suspend", which is not what happened.
    expect(codes).toContain('standing_decision')
    expect(codes).toContain('not_reinstatable')
    expect(codes).toContain('already_halted')
    const unsent = codes.filter((c) => !sent(c, [MODERATION, ADMIN_DASHBOARD, PAYMENT_ROUTES]))
    expect(unsent, 'MemberRoster.tsx branches on codes no owning route sends').toEqual([])
  })
})
