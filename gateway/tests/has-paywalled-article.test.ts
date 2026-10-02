import { describe, it, expect, beforeAll, afterAll, beforeEach, afterEach } from "vitest";
import pg from "pg";
import { HAS_PAYWALLED_ARTICLE_SQL } from "../src/routes/writers.js";

// =============================================================================
// "Does this writer have a paywalled article?" is a question about `access_mode`
// (MIRROR-AUDIT §4, correctness papercuts).
//
// WHAT WAS WRONG. The predicate asked `price_pence > 0`. Nothing clears
// `price_pence` when a piece is switched back to public — the publish upsert
// writes whatever the editor sends and the schema floors the value only at 0 —
// so a writer who charged for one article in 2025 and opened it up afterwards
// went on reading as having paywalled work for ever. That flag draws the
// subscribe affordance beside their name in the following list, so the site was
// making a standing claim about them that they had revoked.
//
// WHY THIS IS DB-BACKED. The claim is entirely about which column Postgres
// evaluates, over a row where the two columns DISAGREE. A mocked `pool.query`
// dispatching on the query text hands back whatever the fixture says, which is
// the answer the test is supposed to be checking; and a test that retypes the
// predicate has already made the same choice the code did. So the exported
// fragment is run, against a real row, in a rolled-back transaction.
//
// THE FIXTURE THAT MATTERS is the disagreeing one: `access_mode = 'public'` with
// `price_pence = 250`. A suite whose articles are all self-consistent passes
// against both spellings.
// =============================================================================

const DB_URL = process.env.TEST_DATABASE_URL ?? process.env.DATABASE_URL;

describe.skipIf(!DB_URL)("has_paywalled_article", () => {
  let client: pg.Client;
  let writer: string;

  beforeAll(async () => {
    client = new pg.Client({ connectionString: DB_URL });
    await client.connect();
  });
  afterAll(async () => {
    await client.end();
  });

  beforeEach(async () => {
    await client.query("BEGIN");
    const { rows } = await client.query<{ id: string }>(
      `INSERT INTO accounts (nostr_pubkey, nostr_privkey_enc)
       VALUES ($1, 'fixture-enc') RETURNING id`,
      [`fixture-haspw-${process.hrtime.bigint().toString(16)}`],
    );
    writer = rows[0].id;
  });
  afterEach(async () => {
    await client.query("ROLLBACK");
  });

  async function article(opts: {
    accessMode: string;
    pricePence: number;
    deleted?: boolean;
  }) {
    const tag = `haspw-${process.hrtime.bigint().toString(16)}`;
    await client.query(
      `INSERT INTO articles
         (writer_id, nostr_event_id, nostr_d_tag, slug, title, content_free,
          access_mode, price_pence, deleted_at)
       VALUES ($1, $2, $3, $3, 'Fixture', 'body', $4, $5, $6)`,
      [
        writer,
        tag.padEnd(64, "0"),
        tag,
        opts.accessMode,
        opts.pricePence,
        opts.deleted ? new Date() : null,
      ],
    );
  }

  /** Runs the REAL exported fragment, with `a` bound to the fixture writer. */
  async function hasPaywalled(): Promise<boolean> {
    const { rows } = await client.query<{ answer: boolean }>(
      `SELECT ${HAS_PAYWALLED_ARTICLE_SQL} AS answer
         FROM accounts a WHERE a.id = $1`,
      [writer],
    );
    return rows[0].answer;
  }

  it("is FALSE for a public article carrying a leftover price", async () => {
    // The shape the defect produced: paywalled once, opened up later, price
    // never cleared because nothing clears it.
    await article({ accessMode: "public", pricePence: 250 });

    expect(await hasPaywalled()).toBe(false);
  });

  it("is TRUE for an actually paywalled article", async () => {
    await article({ accessMode: "paywalled", pricePence: 250 });

    expect(await hasPaywalled()).toBe(true);
  });

  it("is FALSE for a writer with nothing published", async () => {
    expect(await hasPaywalled()).toBe(false);
  });

  it("ignores a soft-deleted paywalled article", async () => {
    await article({ accessMode: "paywalled", pricePence: 250, deleted: true });

    expect(await hasPaywalled()).toBe(false);
  });

  it("is TRUE when one of several articles is paywalled", async () => {
    await article({ accessMode: "public", pricePence: 0 });
    await article({ accessMode: "paywalled", pricePence: 100 });
    await article({ accessMode: "public", pricePence: 400 });

    expect(await hasPaywalled()).toBe(true);
  });

  it("is FALSE for invitation_only, whatever its price says", async () => {
    // A third access_mode exists, and it is not the paywall — so a predicate
    // widened to `access_mode <> 'public'` would be wrong in the other
    // direction and this is what says so.
    await article({ accessMode: "invitation_only", pricePence: 300 });

    expect(await hasPaywalled()).toBe(false);
  });
});
