import { describe, it, expect, beforeAll, afterAll, vi } from "vitest";
import pg from "pg";
import Fastify from "fastify";

// =============================================================================
// A feed may have no name (migration 190).
//
// THE BUG THIS PINS. `POST /workspace/feeds` with no name answered
// 500 `{"code":"23514", … "violates check constraint \"feeds_name_length\""}`.
// The New feed dialog's label is literally "Name (optional)", the gateway's
// `createFeedSchema` has always carried `.default("")`, and the whole client
// renders the untitled case on purpose (`Feed N` on the vessel and the muster,
// "No name" / "Add name" in the composer, "Unnamed feed" in the ∀ menu) — the
// database's 1-character floor was the only thing in the system that disagreed,
// and it surfaced as a raw constraint name in a toast.
//
// DB-BACKED, AND IT CANNOT BE ANYTHING ELSE. What is under test is a Postgres
// CHECK constraint. A mocked `pool.query` would answer "did the INSERT
// succeed?" from the mock's idea of the constraint, which is to say from
// nothing at all — it passes identically against the schema that raised the
// 500. Mutation-proved: restore the `char_length(name) >= 1` arm and the first
// two cases fail with 23514.
//
// THE CAP IS TESTED BESIDE THE FLOOR on purpose. Relaxing a bound is exactly
// where the other bound quietly goes too; 077's comment says the cap is what
// this constraint is FOR, so the 81-character case is what proves the fix kept
// the point of it.
//
// Run locally (both vars — the fixtures use their own client, the code under
// test uses the shared pool, which reads DATABASE_URL):
//   DATABASE_URL=postgresql://platformpub:password@localhost:5432/platformpub \
//   TEST_DATABASE_URL=$DATABASE_URL npx vitest run tests/feed-untitled.test.ts
// =============================================================================

process.env.PAYMENT_SERVICE_URL ??= "http://payment-service.test";
process.env.INTERNAL_SERVICE_TOKEN ??= "test-token";

const DB_URL = process.env.TEST_DATABASE_URL ?? process.env.DATABASE_URL;
const uniq = () => process.hrtime.bigint().toString(16);

// Who requireAuth says is calling. A fixture account minted at run time, so the
// mock reads it rather than closing over a literal.
let ownerId = "unset";
vi.mock("../src/middleware/auth.js", () => ({
  requireAuth: (req: any, _reply: any, done: any) => {
    req.session = { sub: ownerId };
    done();
  },
  optionalAuth: (req: any, _reply: any, done: any) => {
    req.session = { sub: ownerId };
    done();
  },
}));

const { registerFeedCrudRoutes } = await import("../src/routes/feeds/crud.js");

describe.skipIf(!DB_URL)("a feed's name is optional", () => {
  let client: pg.Client;
  let app: Awaited<ReturnType<typeof build>>;
  const cleanupAccounts: string[] = [];

  async function build() {
    const a = Fastify({ logger: false });
    // Called, not `register`ed: this is a plain (app) => void, so avvio would
    // wait on a `done` it never gets (the same shape feed-delete/-merge use).
    registerFeedCrudRoutes(a);
    await a.ready();
    return a;
  }

  beforeAll(async () => {
    client = new pg.Client({ connectionString: DB_URL });
    await client.connect();
    const pubkey = `fixture-untitled-${uniq()}`;
    const { rows } = await client.query<{ id: string }>(
      `INSERT INTO accounts (nostr_pubkey, nostr_privkey_enc, display_name)
       VALUES ($1, 'fixture-enc', 'Fixture untitled') RETURNING id`,
      [pubkey],
    );
    ownerId = rows[0].id;
    cleanupAccounts.push(rows[0].id);
    app = await build();
  });

  afterAll(async () => {
    if (cleanupAccounts.length)
      await client.query(`DELETE FROM accounts WHERE id = ANY($1::uuid[])`, [
        cleanupAccounts,
      ]);
    await app?.close();
    await client.end();
  });

  /** What the row actually holds — the response echoes the request, so reading
   *  it back through the API would not distinguish "stored" from "accepted". */
  async function storedName(feedId: string): Promise<string> {
    const { rows } = await client.query<{ name: string }>(
      `SELECT name FROM feeds WHERE id = $1`,
      [feedId],
    );
    return rows[0].name;
  }

  it("creates a feed when the body carries no name at all", async () => {
    const res = await app.inject({
      method: "POST",
      url: "/feeds",
      payload: {},
    });
    expect(res.statusCode).toBe(201);
    const feed = res.json().feed;
    expect(await storedName(feed.id)).toBe("");
  });

  it("creates a feed for an explicitly empty name", async () => {
    const res = await app.inject({
      method: "POST",
      url: "/feeds",
      payload: { name: "   " },
    });
    expect(res.statusCode).toBe(201);
    // Zod trims, so whitespace is the no-name case rather than a name.
    expect(await storedName(res.json().feed.id)).toBe("");
  });

  it("clears a name on rename, which is the same fact one edit later", async () => {
    const created = await app.inject({
      method: "POST",
      url: "/feeds",
      payload: { name: "Politics" },
    });
    const id = created.json().feed.id;
    const res = await app.inject({
      method: "PATCH",
      url: `/feeds/${id}`,
      payload: { name: "" },
    });
    expect(res.statusCode).toBe(200);
    expect(await storedName(id)).toBe("");
  });

  it("still refuses a name past the 80-character cap, as a 400", async () => {
    const res = await app.inject({
      method: "POST",
      url: "/feeds",
      payload: { name: "x".repeat(81) },
    });
    // 400 from Zod, NOT a 500 from the constraint — the cap is enforced before
    // the INSERT, so the constraint stays the backstop it was written to be.
    expect(res.statusCode).toBe(400);
  });
});
