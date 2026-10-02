import { describe, it, expect } from 'vitest'
import fs from 'fs'
import path from 'path'
import { fileURLToPath } from 'url'

// =============================================================================
// Every relay-outbox entity type the code can enqueue is one the DATABASE will
// accept (MIRROR-AUDIT §3 *Data integrity and ingest*, S17).
//
// `RelayOutboxEntityType` is a TypeScript union; `relay_outbox_entity_type_check`
// is a CHECK constraint. Nothing connects them, and they drifted: 'citation' and
// 'dispute' were added to the union with the Upstream Edges routes and never
// reached the constraint. The failure that buys is not a rejected row — every
// enqueue is INSIDE the caller's transaction, per the relay-outbox invariant —
// so a 23514 rolls back the edge, the notification and everything else the
// route was writing, and answers 500.
//
// It stayed invisible because UPSTREAM_EDGES_ENABLED is dark. That is the
// argument for the test rather than against it: the flag's whole value is that
// flipping it to LOOK at the feature is cheap and reversible, and a 500 on the
// first citation makes that false. The next type added behind the next dark
// flag would land in exactly the same silence.
//
// Same shape as ledger-trigger-coverage.test.ts: enumerate the union from its
// one home and demand the other two spellings match. Pure text over the repo's
// own files — no DB, and nothing to drift.
// =============================================================================

const here = path.dirname(fileURLToPath(import.meta.url))
const root = path.resolve(here, '../..')
const read = (rel: string) => fs.readFileSync(path.join(root, rel), 'utf8')

/** The `RelayOutboxEntityType` union, read from its one home. */
function unionMembers(): string[] {
  const src = read('shared/src/lib/relay-outbox.ts')
  const start = src.indexOf('export type RelayOutboxEntityType =')
  expect(start).toBeGreaterThan(-1)
  const end = src.indexOf('export interface SignedNostrEvent', start)
  expect(end).toBeGreaterThan(start)
  const members = [...src.slice(start, end).matchAll(/^\s*\|\s*'([a-z_]+)'/gm)].map((m) => m[1])
  expect(members.length).toBeGreaterThan(10) // a regex that matched nothing must not pass
  return members
}

/** The values migration 197's CHECK admits. */
function migrationTypes(): string[] {
  const sql = read('migrations/197_relay_outbox_entity_type_edges.sql')
  const at = sql.indexOf('ADD CONSTRAINT relay_outbox_entity_type_check')
  expect(at).toBeGreaterThan(-1)
  return [...sql.slice(at).matchAll(/'([a-z_]+)'/g)].map((m) => m[1])
}

/**
 * The values schema.sql's CHECK admits — the genesis base, which is what a
 * fresh database actually gets. A migration that never runs there is not
 * evidence its effect is in force (CLAUDE.md's seeded-migration rule), so this
 * is the spelling that decides what prod will accept, and it is checked
 * separately from the migration's.
 */
function schemaTypes(): string[] {
  const sql = read('schema.sql')
  const at = sql.indexOf('CONSTRAINT relay_outbox_entity_type_check')
  expect(at).toBeGreaterThan(-1)
  const body = sql.slice(at, sql.indexOf('\n', at))
  return [...body.matchAll(/'([a-z_]+)'::text/g)].map((m) => m[1])
}

/**
 * Every entity type any service actually enqueues, read from the call sites.
 * The union is what the compiler enforces; this is what the running code does,
 * and it is the half a `as RelayOutboxEntityType` cast would hide.
 */
function enqueuedTypes(): string[] {
  const dirs = ['gateway/src', 'payment-service/src', 'feed-ingest/src', 'shared/src']
  const out = new Set<string>()
  for (const d of dirs) {
    for (const f of walk(path.join(root, d))) {
      if (!f.endsWith('.ts') || f.endsWith('relay-outbox.ts')) continue
      for (const m of fs.readFileSync(f, 'utf8').matchAll(/entityType: *['"]([a-z_]+)['"]/g))
        out.add(m[1])
    }
  }
  expect(out.size).toBeGreaterThan(5) // the walk found the call sites at all
  return [...out]
}

/**
 * Types the code has RETIRED but the CHECK still admits, because rows written
 * under them remain in the table (an outbox row is history, and narrowing the
 * CHECK would need them rewritten or deleted first). Named here, one reason
 * each, so a retirement is a decision on the page rather than a gap the test
 * was loosened to fit: the CHECK must admit exactly the union PLUS these, and
 * the union must not quietly take one back.
 */
const RETIRED: Record<string, string> = {
  // walkthrough W1 (`1a627d69`): kind 14 named a DM's conversation on a relay
  // whose reads are public; nothing writes it any more (see relay-outbox.ts).
  conversation_pulse: 'walkthrough A8 — DMs stopped publishing kind 14',
}

describe('relay_outbox entity types — the union, the migration and schema.sql agree', () => {
  const members = unionMembers()
  const admitted = [...members, ...Object.keys(RETIRED)].sort()

  it("migration 197's CHECK admits exactly the union's members and the retired ones", () => {
    expect([...new Set(migrationTypes())].sort()).toEqual(admitted)
  })

  it("schema.sql's CHECK admits exactly the union's members and the retired ones", () => {
    expect([...new Set(schemaTypes())].sort()).toEqual(admitted)
  })

  it('a retired type is not in the union, and nothing enqueues it', () => {
    const retired = Object.keys(RETIRED)
    expect(members.filter((m) => retired.includes(m))).toEqual([])
    expect(enqueuedTypes().filter((t) => retired.includes(t))).toEqual([])
  })

  it('every type the code enqueues is one the union declares', () => {
    // A cast, or a type widened to string, would let a call site name something
    // the compiler never checked — and the first anyone would hear of it is a
    // 23514 rolling back somebody's transaction.
    expect(enqueuedTypes().filter((t) => !members.includes(t))).toEqual([])
  })
})

function walk(dir: string): string[] {
  const out: string[] = []
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name)
    if (e.isDirectory()) out.push(...walk(p))
    else out.push(p)
  }
  return out
}
