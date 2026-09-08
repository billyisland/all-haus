import { describe, it, expect, beforeAll, afterAll, beforeEach, afterEach } from "vitest";
import pg from "pg";
import {
  buildStatementSQL,
  SUMMARY_STATEMENT_SQL,
} from "../src/routes/my-account.js";

// =============================================================================
// The arrival account's statement adds up (PAYWALL-ARRIVAL-ADR D2, §11.3).
//
// The statement is TWO INDEPENDENT QUERIES — the entry list and the summary
// totals — and they are copies of the same idea rather than a projection of one
// onto the other. That is the whole hazard D2's display half created: the
// arrival read is `chargeable_pence = 0`, so BOTH debit arms exclude it by
// construction, and admitting it to one alone nets the entries to `dial` while
// the summary nets to `dial + p`. Three pounds moving from one place to the
// other, on the money surface, shown to the one reader this flow exists to
// impress — which is D2's own failure rebuilt inside the remedy for it.
//
// SO THE ASSERTION IS PARITY, not a pair of expected numbers. Expected numbers
// would let both queries drift together and still pass; parity is the property
// that actually has to hold, and it is checked on a REAL seeded arrival account
// against the REAL exported statements.
//
// WHY DB-BACKED. `chargeable_pence` is generated, and the arrival predicate
// turns on `IS NOT DISTINCT FROM` — three-valued logic that a mocked
// `pool.query` cannot evaluate and that a fixture would simply assert around.
// The NULL case is not incidental: `arrival_article_id` is NULL for every
// ordinary account, and a plain `=` there makes the free-reads arm's `NOT (…)`
// evaluate to NULL, silently dropping EVERY free read from EVERY ordinary
// reader's statement. That is the control below.
//
// Always rolled back. Run locally:
//   POSTGRES_PASSWORD=$(grep -E '^POSTGRES_PASSWORD=' ../.env | cut -d= -f2-) \
//   TEST_DATABASE_URL=postgresql://platformpub:$POSTGRES_PASSWORD@localhost:5432/platformpub \
//     npx vitest run tests/arrival-statement-parity-integration.test.ts
// =============================================================================

const DB_URL = process.env.TEST_DATABASE_URL ?? process.env.DATABASE_URL;

const FEE = 800;
const DIAL = 500;

describe.skipIf(!DB_URL)("the arrival statement", () => {
  let client: pg.Client;
  let writerId: string;

  beforeAll(async () => {
    client = new pg.Client({ connectionString: DB_URL });
    await client.connect();
  });
  afterAll(async () => {
    await client.end();
  });

  beforeEach(async () => {
    await client.query("BEGIN");
    writerId = await insertAccount(DIAL, null, 0);
  });
  afterEach(async () => {
    await client.query("ROLLBACK");
  });

  let seq = 0;
  const uniq = () => `stmt-${Date.now().toString(36)}-${seq++}`;

  async function insertAccount(
    granted: number,
    arrivalArticleId: string | null,
    arrivalGift: number,
  ): Promise<string> {
    const { rows } = await client.query<{ id: string }>(
      `INSERT INTO accounts (nostr_pubkey, free_allowance_granted_pence,
                             free_allowance_remaining_pence,
                             arrival_article_id, arrival_gift_pence)
       VALUES ($1, $2, $2, $3, $4) RETURNING id`,
      [uniq().padEnd(64, "0"), granted, arrivalArticleId, arrivalGift],
    );
    return rows[0].id;
  }

  async function insertArticle(price: number): Promise<string> {
    const s = uniq();
    const { rows } = await client.query<{ id: string }>(
      `INSERT INTO articles (writer_id, nostr_event_id, nostr_d_tag, title, slug,
                             access_mode, price_pence)
       VALUES ($1, $2, $3, $4, $5, 'paywalled', $6) RETURNING id`,
      [writerId, s.padEnd(64, "0"), s, `Article ${s}`, s, price],
    );
    return rows[0].id;
  }

  async function insertRead(
    readerId: string,
    articleId: string,
    listPrice: number,
    allowanceConsumed: number,
  ) {
    await client.query(
      `INSERT INTO read_events
         (reader_id, article_id, writer_id, amount_pence, state,
          on_free_allowance, allowance_consumed_pence)
       VALUES ($1, $2, $3, $4, 'platform_settled', $5, $6)`,
      [readerId, articleId, writerId, listPrice, allowanceConsumed > 0, allowanceConsumed],
    );
  }

  /** The entry list's own arithmetic: credits minus debits, over every row. */
  async function entriesNet(readerId: string, includeFree: boolean) {
    const { rows } = await client.query<{
      type: string;
      amount_pence: number;
      description: string;
    }>(buildStatementSQL(includeFree, "all"), [readerId, FEE]);
    const net = rows.reduce(
      (a, r) => a + (r.type === "credit" ? r.amount_pence : -r.amount_pence),
      0,
    );
    return { net, rows };
  }

  async function summaryNet(readerId: string) {
    const { rows } = await client.query<{
      credits_total: string;
      debits_total: string;
    }>(SUMMARY_STATEMENT_SQL, [readerId, null, FEE]);
    return parseInt(rows[0].credits_total, 10) - parseInt(rows[0].debits_total, 10);
  }

  it("the entry list and the summary agree on a seeded arrival account", async () => {
    const price = 300;
    const articleId = await insertArticle(price);
    const readerId = await insertAccount(DIAL + price, articleId, price);
    await insertRead(readerId, articleId, price, price);

    const { net } = await entriesNet(readerId, false);
    expect(net).toBe(await summaryNet(readerId));
    // And the figure is the welcome gift, whole — the arrival credit and the
    // arrival debit cancel, which is the point of showing both.
    expect(net).toBe(DIAL);
  });

  it("shows the arrival gift and its read as two lines that cancel", async () => {
    const price = 300;
    const articleId = await insertArticle(price);
    const readerId = await insertAccount(DIAL + price, articleId, price);
    await insertRead(readerId, articleId, price, price);

    const { rows } = await entriesNet(readerId, false);
    const gift = rows.find((r) => r.description.startsWith("Arrival gift"));
    const debit = rows.find((r) => r.type === "debit");
    expect(gift?.amount_pence).toBe(price);
    expect(debit?.amount_pence).toBe(price);
    // 'Starting credit' is the DIAL alone, not the enlarged grant. Left whole
    // it would tell a reader who has spent nothing that their gift is already a
    // third drained.
    const start = rows.find((r) => r.description === "Starting credit");
    expect(start?.amount_pence).toBe(DIAL);
  });

  it("does not render the arrival read twice under include_free_reads", async () => {
    // It is a £0 read by the free-reads arm's own test AND it is on the debit
    // side now, so the free arm has to be narrowed or it appears in both.
    const price = 300;
    const articleId = await insertArticle(price);
    const readerId = await insertAccount(DIAL + price, articleId, price);
    await insertRead(readerId, articleId, price, price);

    const { rows, net } = await entriesNet(readerId, true);
    const forArticle = rows.filter((r) => r.type === "debit");
    expect(forArticle).toHaveLength(1);
    expect(net).toBe(await summaryNet(readerId));
  });

  it("a GIFT-0 arrival account nets the plain dial, not dial - p", async () => {
    // PATH D, and the case the fragment used to get wrong. The account IS
    // stamped with an `arrival_article_id` — the piece was above the cap or
    // undeliverable at signup — but it never received the enlargement, so
    // `arrival_gift_pence` is 0 and the 'Arrival gift' credit line is absent
    // (that arm carries its own `> 0`). The piece is later fixed or repriced and
    // the reader unlocks it with the ordinary button, at or below the cap, on
    // allowance.
    //
    // Keyed on the ARTICLE alone, that read matched the arrival predicate: it
    // was hoisted onto the debit side at its list price with no credit anywhere
    // to answer it, and excluded from the free-reads arm that would have shown
    // it at zero. Net `dial - p`. Both queries share the fragment, so they were
    // wrong TOGETHER and every parity assertion above stayed green — which is
    // why this case asserts the FIGURE as well as the parity.
    const price = 300;
    const articleId = await insertArticle(price);
    const readerId = await insertAccount(DIAL, articleId, 0);
    await insertRead(readerId, articleId, price, price);

    const { rows, net } = await entriesNet(readerId, true);
    expect(net).toBe(await summaryNet(readerId));
    expect(net).toBe(DIAL);
    // No gift line, and the read shows as the free read it was.
    expect(rows.some((r) => r.description.startsWith("Arrival gift"))).toBe(false);
    const debits = rows.filter((r) => r.type === "debit");
    expect(debits).toHaveLength(1);
    expect(debits[0].amount_pence).toBe(0);
  });

  it("CONTROL: an ordinary account still sees its free reads, and still agrees", async () => {
    // The `IS NOT DISTINCT FROM` case. `arrival_article_id` is NULL here, and
    // with a plain `=` the free-reads arm's `NOT (…)` evaluates to NULL and
    // drops every free read — for every reader on the platform, silently.
    const readerId = await insertAccount(DIAL, null, 0);
    const articleId = await insertArticle(120);
    await insertRead(readerId, articleId, 120, 120);

    const { rows, net } = await entriesNet(readerId, true);
    expect(rows.some((r) => r.type === "debit" && r.amount_pence === 0)).toBe(true);
    expect(net).toBe(await summaryNet(readerId));
    expect(net).toBe(DIAL);
  });
});
