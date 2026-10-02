import { describe, it, expect, beforeAll, afterAll } from "vitest";
import pg from "pg";

// =============================================================================
// The comp's shape is held by the SCHEMA, not by the route (migration 193;
// MIRROR-AUDIT §2.12, S8).
//
// WHY DB-BACKED. Both guarantees are Postgres's evaluation of a CHECK and of a
// PARTIAL UNIQUE INDEX over a mutable predicate. A mocked `pool.query`
// dispatching on query text would hand back whatever the fixture holds and
// agree with itself whether or not either object exists — which is exactly the
// silence being closed. The route's own behaviour is proved separately, and
// with the DB mocked, in comp-offer.test.ts.
//
// WHY IN THE SCHEMA AT ALL. The §0l lesson: a route rebuild can un-deploy a
// guard, a constraint cannot. A comp offer that was bearer (`mode = 'code'`),
// or priced, or unlimited, is the original defect wearing the new model's
// clothes — a link anyone could redeem into a free subscription. And
// consent-by-offer moves the harm from the subscription row to the
// NOTIFICATION, so something has to bound how many gifts one writer may put in
// front of one reader; a check-then-insert in the route is a race.
//
// Run locally:
//   POSTGRES_PASSWORD=$(grep -E '^POSTGRES_PASSWORD=' .env | cut -d= -f2-) \
//   DATABASE_URL=postgresql://platformpub:$POSTGRES_PASSWORD@localhost:5432/platformpub \
//     npx vitest run tests/comp-offer-shape.test.ts
// =============================================================================

const DB_URL = process.env.TEST_DATABASE_URL ?? process.env.DATABASE_URL;

describe.skipIf(!DB_URL)("subscription_offers — the comp's shape", () => {
  let client: pg.Client;
  const stamp = Date.now().toString(36);
  const accounts: string[] = [];
  let writer = "";
  let reader = "";

  const mkAccount = async (name: string) => {
    const { rows } = await client.query<{ id: string }>(
      `INSERT INTO accounts (username, nostr_pubkey, nostr_privkey_enc)
       VALUES ($1, $2, $3) RETURNING id`,
      [
        `comp-${name}-${stamp}`,
        `${name}${stamp}`.padEnd(64, "0").slice(0, 64),
        "x",
      ],
    );
    accounts.push(rows[0].id);
    return rows[0].id;
  };

  // The comp offer the route writes, parameterised so each case can bend one
  // field and nothing else.
  const insertComp = (
    over: Partial<{
      mode: string;
      discountPct: number;
      recipientId: string | null;
      maxRedemptions: number | null;
      isComp: boolean;
    }> = {},
  ) =>
    client.query<{ id: string }>(
      `INSERT INTO subscription_offers
         (writer_id, label, mode, discount_pct, code, recipient_id,
          max_redemptions, is_comp)
       VALUES ($1, 'comp', $2, $3, $4, $5, $6, $7)
       RETURNING id`,
      [
        writer,
        over.mode ?? "grant",
        over.discountPct ?? 100,
        `code-${stamp}-${Math.random().toString(36).slice(2, 10)}`,
        over.recipientId === undefined ? reader : over.recipientId,
        over.maxRedemptions === undefined ? 1 : over.maxRedemptions,
        over.isComp ?? true,
      ],
    );

  beforeAll(async () => {
    client = new pg.Client({ connectionString: DB_URL });
    await client.connect();
    writer = await mkAccount("w");
    reader = await mkAccount("r");
  });

  afterAll(async () => {
    if (accounts.length) {
      await client.query(`DELETE FROM subscription_offers WHERE writer_id = ANY($1)`, [accounts]);
      await client.query(`DELETE FROM accounts WHERE id = ANY($1)`, [accounts]);
    }
    await client.end();
  });

  it("accepts the shape the route writes", async () => {
    const { rows } = await insertComp();
    expect(rows[0].id).toBeTruthy();
    await client.query(`DELETE FROM subscription_offers WHERE id = $1`, [rows[0].id]);
  });

  // Each of these is a way the comp could become redeemable by someone the
  // writer never named, or redeemable more than once, or not free.
  it.each([
    ["bearer (mode = 'code')", { mode: "code", recipientId: null }],
    ["priced (discount < 100)", { discountPct: 50 }],
    ["recipient-less", { recipientId: null }],
    ["unlimited redemptions", { maxRedemptions: null }],
    ["multi-redemption", { maxRedemptions: 5 }],
  ])("refuses a comp that is %s", async (_label, over) => {
    await expect(insertComp(over)).rejects.toThrow(
      /subscription_offers_comp_shape/,
    );
  });

  it("allows every one of those shapes when it is NOT a comp", async () => {
    // The control: the CHECK constrains comps and nothing else. Without it the
    // suite above would pass equally against a constraint that had banned
    // half the offer table.
    const { rows } = await insertComp({
      mode: "code",
      discountPct: 50,
      recipientId: null,
      maxRedemptions: null,
      isComp: false,
    });
    expect(rows[0].id).toBeTruthy();
    await client.query(`DELETE FROM subscription_offers WHERE id = $1`, [rows[0].id]);
  });

  it("allows only ONE outstanding comp offer per (writer, recipient)", async () => {
    const first = await insertComp();
    await expect(insertComp()).rejects.toThrow(/uq_comp_offer_outstanding/);

    // Revoked ⇒ out of the index, so the writer may offer again.
    await client.query(
      `UPDATE subscription_offers SET revoked_at = now() WHERE id = $1`,
      [first.rows[0].id],
    );
    const second = await insertComp();

    // Redeemed ⇒ likewise out of the index. This is the arm that matters for
    // the year AFTER a comp has run: the gift ended, so a new one may be made.
    await client.query(
      `UPDATE subscription_offers SET redemption_count = 1 WHERE id = $1`,
      [second.rows[0].id],
    );
    const third = await insertComp();
    expect(third.rows[0].id).toBeTruthy();

    await client.query(`DELETE FROM subscription_offers WHERE writer_id = $1`, [writer]);
  });
});
