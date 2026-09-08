import { describe, it, expect, beforeAll, afterAll, beforeEach, afterEach } from 'vitest'
import pg from 'pg'

// =============================================================================
// `resolveArrivalGift` — the one place that decides how much money a new
// account is granted (PAYWALL-ARRIVAL-ADR D1/D2).
//
// WHY THIS FILE EXISTS SEPARATELY FROM THE ARITHMETIC TEST. Its sibling
// (`payment-service/tests/arrival-gift-integration.test.ts`) proves that the
// ordinary card-less path, HANDED an enlarged grant, lands on the right
// numbers. Nothing there proves the grant is enlarged — it builds its own
// accounts. This one drives the real resolver against real rows, because the
// three rules it enforces are each a thing that has to be true of the DATABASE:
//
//   • `p` comes from `articles`, never from the request — a client-supplied
//     price is a free-money endpoint on the one route that must accept
//     unauthenticated input by definition;
//   • the cap is the `arrival_gift_cap_pence` DIAL, not a literal and NOT the
//     allowance — so retuning it retunes the cap, and retuning the ALLOWANCE
//     does not (they were one dial until 2026-09-06; see the between-the-dials
//     case below, which is the whole of that split);
//   • an UNDELIVERABLE piece is given nothing, on the same two conditions
//     `performGatePass` refuses on (no vault key, or price < 1). Granting for a
//     piece that then refuses to open hands out the enlargement for nothing.
//
// And it pins the thing §11.2 turned on: the article id is recorded even when
// the gift is ZERO, because above-cap and misconfigured are arrivals that were
// given nothing, and `arrival_gift_pence > 0` cannot tell them from a member
// signing in at the same gate.
//
// DB-backed and always rolled back. Run locally:
//   POSTGRES_PASSWORD=$(grep -E '^POSTGRES_PASSWORD=' .env | cut -d= -f2-) \
//   DATABASE_URL=postgresql://platformpub:$POSTGRES_PASSWORD@localhost:5432/platformpub \
//     npx vitest run tests/arrival-gift-resolve.test.ts
// =============================================================================

const DB_URL = process.env.TEST_DATABASE_URL ?? process.env.DATABASE_URL

describe.skipIf(!DB_URL)('resolveArrivalGift', () => {
  let client: pg.Client
  let resolveArrivalGift: typeof import('../src/auth/arrival-gift.js').resolveArrivalGift
  let dial: number
  let cap: number
  let writerId: string

  beforeAll(async () => {
    process.env.DATABASE_URL = DB_URL
    client = new pg.Client({ connectionString: DB_URL })
    await client.connect()
    ;({ resolveArrivalGift } = await import('../src/auth/arrival-gift.js'))
    const { rows } = await client.query<{ key: string; value: string }>(
      `SELECT key, value FROM platform_config
        WHERE key IN ('free_allowance_pence', 'arrival_gift_cap_pence')`,
    )
    const byKey = new Map(rows.map((r) => [r.key, parseInt(r.value, 10)]))
    dial = byKey.get('free_allowance_pence')!
    cap = byKey.get('arrival_gift_cap_pence')!
    // THE DISCRIMINATOR HAS TO EXIST BEFORE ANY OF THESE CASES MEAN ANYTHING.
    // Every assertion below distinguishes the cap dial from the allowance dial
    // by a price that falls BETWEEN them; tuned equal, that price does not
    // exist and the suite would pass against a resolver reading either one —
    // the "a dial whose default equals another dial's cannot be pinned"
    // trap, met head-on rather than left to chance.
    expect(cap).toBeLessThan(dial)
  })
  afterAll(async () => {
    await client.end()
    const { pool } = await import('../src/db/client.js')
    await pool.end()
  })

  // The resolver reads through its OWN pool, so these rows have to be committed
  // rather than held in this client's transaction — and are cleaned up after.
  const made: string[] = []
  beforeEach(async () => {
    const s = `arrres-${Date.now().toString(36)}-${made.length}`
    const { rows } = await client.query<{ id: string }>(
      `INSERT INTO accounts (nostr_pubkey) VALUES ($1) RETURNING id`,
      [s.padEnd(64, '0')],
    )
    writerId = rows[0].id
    made.push(writerId)
  })
  afterEach(async () => {
    await client.query(
      `DELETE FROM vault_keys WHERE article_id IN
         (SELECT id FROM articles WHERE writer_id = ANY($1::uuid[]))`,
      [made],
    )
    await client.query(`DELETE FROM articles WHERE writer_id = ANY($1::uuid[])`, [made])
    await client.query(`DELETE FROM accounts WHERE id = ANY($1::uuid[])`, [made])
    made.length = 0
  })

  let seq = 0
  async function article(opts: {
    price: number | null
    accessMode?: string
    vaultKey?: boolean
    published?: boolean
  }): Promise<string> {
    const s = `arrres-a-${Date.now().toString(36)}-${seq++}`
    const { rows } = await client.query<{ id: string }>(
      `INSERT INTO articles (writer_id, nostr_event_id, nostr_d_tag, title, slug,
                             access_mode, price_pence, published_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8) RETURNING id`,
      [
        writerId, s.padEnd(64, '0'), s, `Article ${s}`, s,
        opts.accessMode ?? 'paywalled', opts.price,
        opts.published === false ? null : new Date(),
      ],
    )
    if (opts.vaultKey !== false) {
      await client.query(
        `INSERT INTO vault_keys (article_id, nostr_article_event_id, content_key_enc)
         VALUES ($1, $2, $3)`,
        [rows[0].id, s.padEnd(64, '0'), 'x'],
      )
    }
    return s
  }

  it('grants the price of a piece AT the cap, and records the article', async () => {
    const dTag = await article({ price: cap })
    const g = await resolveArrivalGift(dTag)
    expect(g.giftPence).toBe(cap)
    expect(g.articleId).not.toBeNull()
  })

  it('grants nothing ABOVE the cap — but still records the article', async () => {
    // The distinction §11.2 turned on. An above-cap arrival was given nothing
    // and must still be tellable from a member signing in at the same gate.
    const dTag = await article({ price: cap + 1 })
    const g = await resolveArrivalGift(dTag)
    expect(g.giftPence).toBe(0)
    expect(g.articleId).not.toBeNull()
  })

  it('grants nothing BETWEEN the cap and the allowance — which dial is read', async () => {
    // THE CASE THE 2026-09-06 SPLIT EXISTS FOR, and the only one that says WHICH
    // dial the resolver reads. Until then the cap WAS `free_allowance_pence`, so
    // a piece priced here was covered — and because the grant is `allowance + p`
    // and the money is fungible, the priciest such piece doubled what one signup
    // was worth, spendable anywhere, at writers' expense (allowance reads earn
    // nobody). Every other case in this file passes under either dial; this one
    // fails under the old one, which is what makes it the pin rather than a
    // restatement.
    const between = Math.floor((cap + dial) / 2)
    expect(between).toBeGreaterThan(cap)
    expect(between).toBeLessThanOrEqual(dial)
    const dTag = await article({ price: between })
    const g = await resolveArrivalGift(dTag)
    expect(g.giftPence).toBe(0)
    expect(g.articleId).not.toBeNull()
    expect(g.pricePence).toBe(between)
  })

  it('grants nothing for an UNDELIVERABLE piece (no vault key)', async () => {
    // The same refusal `performGatePass` makes before any money moves. Granting
    // here would enlarge the allowance for a piece that then 409s.
    const dTag = await article({ price: 100, vaultKey: false })
    const g = await resolveArrivalGift(dTag)
    expect(g.giftPence).toBe(0)
    expect(g.articleId).not.toBeNull()
  })

  it('is not an arrival at all for a free piece, a deleted one, or a bad tag', async () => {
    const free = await article({ price: null, accessMode: 'public' })
    expect((await resolveArrivalGift(free)).articleId).toBeNull()

    const unpublished = await article({ price: 100, published: false })
    expect((await resolveArrivalGift(unpublished)).articleId).toBeNull()

    expect((await resolveArrivalGift('no-such-d-tag')).articleId).toBeNull()
    expect((await resolveArrivalGift(null)).articleId).toBeNull()
  })

  it('reads the price from the DATABASE, not from anything a caller passed', async () => {
    // The signature admits no price. This is the structural statement of it:
    // the only input is an identifier, and the money comes off the row.
    const dTag = await article({ price: 137 })
    const g = await resolveArrivalGift(dTag)
    expect(g.giftPence).toBe(137)
    expect(g.pricePence).toBe(137)
  })
})
