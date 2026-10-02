import { describe, it, expect, beforeAll, afterAll, beforeEach, afterEach } from "vitest";
import pg from "pg";
import { ARTICLE_SHARE_UPSERT_SQL } from "../src/routes/publications/revenue.js";

// =============================================================================
// A flat fee is paid ONCE (MIRROR-AUDIT §3 *Money*, S14).
//
// `publication_article_shares.paid_out` is the payout cycle's one-shot marker:
// it is stamped TRUE inside the reserve transaction, and computePublicationSplits
// then skips the share for ever (`flat_fee_pence && !share.paidOut`).
// PATCH /publications/:id/payroll/article/:articleId used to end its ON CONFLICT
// DO UPDATE with `paid_out = FALSE`, so ANY edit — including a re-save of the
// same value — handed an already-paid fee back to the next cycle.
//
// WHY DB-BACKED. The fix is a WHERE clause on a DO UPDATE, and the two things
// it turns on are Postgres's to answer: whether a DO UPDATE refused by its WHERE
// reports `rowCount = 0` (the route's 409 is a lie if it reports 1), and how
// EXCLUDED reads inside that WHERE. A mocked `pool.query` dispatching on query
// text hands back whatever the fixture holds and agrees with itself either way.
// So this runs the REAL exported statement.
//
// Rows are seeded inside a transaction that is ALWAYS rolled back.
//
// Skipped unless a DB URL is supplied — CI supplies one (it boots Postgres and
// FAILS on a skip). Run locally against the dev DB:
//   POSTGRES_PASSWORD=$(grep -E '^POSTGRES_PASSWORD=' ../.env | cut -d= -f2-) \
//   TEST_DATABASE_URL=postgresql://platformpub:$POSTGRES_PASSWORD@localhost:5432/platformpub \
//     npx vitest run tests/publication-article-share-paid-out.test.ts
// =============================================================================

const DB_URL = process.env.TEST_DATABASE_URL ?? process.env.DATABASE_URL;

describe.skipIf(!DB_URL)("per-article share upsert — paid_out is a one-shot", () => {
  let client: pg.Client;
  let pubId: string;
  let accountId: string;
  let articleId: string;

  beforeAll(async () => {
    client = new pg.Client({ connectionString: DB_URL });
    await client.connect();
  });
  afterAll(async () => {
    await client.end();
  });

  beforeEach(async () => {
    await client.query("BEGIN");
    pubId = await insertPublication();
    accountId = await insertAccount();
    articleId = await insertArticle(accountId);
  });
  afterEach(async () => {
    await client.query("ROLLBACK");
  });

  let seq = 0;
  const uniq = () => `s14-${Date.now().toString(36)}-${seq++}`;

  async function insertAccount(): Promise<string> {
    const { rows } = await client.query<{ id: string }>(
      `INSERT INTO accounts (nostr_pubkey) VALUES ($1) RETURNING id`,
      [uniq().padEnd(64, "0")],
    );
    return rows[0].id;
  }

  async function insertPublication(): Promise<string> {
    const s = uniq();
    const { rows } = await client.query<{ id: string }>(
      `INSERT INTO publications (slug, name, nostr_pubkey, nostr_privkey_enc)
       VALUES ($1, $2, $3, $4) RETURNING id`,
      [s, `Pub ${s}`, s.padEnd(64, "0"), "enc"],
    );
    return rows[0].id;
  }

  async function insertArticle(writerId: string): Promise<string> {
    const s = uniq();
    const { rows } = await client.query<{ id: string }>(
      `INSERT INTO articles (writer_id, publication_id, nostr_event_id, nostr_d_tag, title, slug)
       VALUES ($1, $2, $3, $4, $5, $6) RETURNING id`,
      [writerId, pubId, s.padEnd(64, "0"), s, `Article ${s}`, s],
    );
    return rows[0].id;
  }

  const upsert = (shareType: "flat_fee_pence" | "revenue_bps", shareValue: number) =>
    client.query(ARTICLE_SHARE_UPSERT_SQL, [
      pubId,
      articleId,
      accountId,
      shareType,
      shareValue,
    ]);

  const read = async () =>
    (
      await client.query<{ share_type: string; share_value: number; paid_out: boolean }>(
        `SELECT share_type, share_value, paid_out FROM publication_article_shares
          WHERE article_id = $1 AND account_id = $2`,
        [articleId, accountId],
      )
    ).rows[0];

  /** What the payout cycle stamps inside its reserve transaction. */
  const markPaid = () =>
    client.query(
      `UPDATE publication_article_shares SET paid_out = TRUE
        WHERE article_id = $1 AND account_id = $2`,
      [articleId, accountId],
    );

  it("creates the share on a first write", async () => {
    const r = await upsert("flat_fee_pence", 5000);
    expect(r.rowCount).toBe(1);
    expect(await read()).toMatchObject({ share_type: "flat_fee_pence", share_value: 5000, paid_out: false });
  });

  it("re-prices an UNPAID flat fee freely", async () => {
    await upsert("flat_fee_pence", 5000);
    const r = await upsert("flat_fee_pence", 6000);
    expect(r.rowCount).toBe(1);
    expect(await read()).toMatchObject({ share_value: 6000, paid_out: false });
  });

  it("REFUSES to re-price a PAID flat fee, and leaves paid_out alone", async () => {
    // THE finding: with the old `paid_out = FALSE` this wrote 6000 and re-armed
    // the share, so the next cycle paid £60 on top of the £50 already paid.
    await upsert("flat_fee_pence", 5000);
    await markPaid();

    const r = await upsert("flat_fee_pence", 6000);
    expect(r.rowCount).toBe(0); // the route's 409
    expect(await read()).toMatchObject({ share_value: 5000, paid_out: true });
  });

  it("refuses a re-save of the SAME value on a paid fee (no silent no-op)", async () => {
    await upsert("flat_fee_pence", 5000);
    await markPaid();
    const r = await upsert("flat_fee_pence", 5000);
    expect(r.rowCount).toBe(0);
  });

  it("ALLOWS switching a paid flat fee to revenue_bps, keeping paid_out TRUE", async () => {
    // paid_out means nothing to the bps arm, so the switch is a real change and
    // is allowed; the flag survives so switching BACK is refused rather than
    // re-paying.
    await upsert("flat_fee_pence", 5000);
    await markPaid();

    const r = await upsert("revenue_bps", 1000);
    expect(r.rowCount).toBe(1);
    expect(await read()).toMatchObject({ share_type: "revenue_bps", share_value: 1000, paid_out: true });

    const back = await upsert("flat_fee_pence", 5000);
    expect(back.rowCount).toBe(0);
    expect(await read()).toMatchObject({ share_type: "revenue_bps", share_value: 1000 });
  });

  it("re-prices a bps share that happens to carry a stale paid_out", async () => {
    await upsert("revenue_bps", 1000);
    await markPaid();
    const r = await upsert("revenue_bps", 2000);
    expect(r.rowCount).toBe(1);
    expect(await read()).toMatchObject({ share_value: 2000 });
  });
});
