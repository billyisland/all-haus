import { describe, it, expect, beforeAll, afterAll } from "vitest";
import pg from "pg";

// =============================================================================
// The email→account oracle is now the member's own choice (MIRROR-AUDIT §3, S16).
//
// `POST /resolve` ran `lookupByEmail` on any `user@host` input and returned the
// matching account's id, username, display name and avatar — 30 tries a minute
// for any member, which against a breach list binds real-world identities to the
// pseudonyms this platform exists to let writers keep. It also contradicted a
// rule already written down one route over: `POST /auth/login` answers
// identically whether or not the address has an account, and says so in a
// comment.
//
// WHY DB-BACKED. The whole of the fix is a predicate inside a WHERE clause
// against a column with a DEFAULT. A mocked `pool.query` dispatching on query
// text would hand back whichever row the fixture holds and agree with itself
// whether or not the predicate is there — and it could not see the default at
// all, which is half the decision: an account nobody has touched must be
// undiscoverable, not discoverable.
//
// The controls are the point. `discoverable_by_email` must not become a general
// "can this person be found" switch: name, username and npub are PUBLISHED
// identifiers and searching by them is untouched. So the opted-out account is
// asserted findable by username in the same test.
//
// Run locally:
//   POSTGRES_PASSWORD=$(grep -E '^POSTGRES_PASSWORD=' .env | cut -d= -f2-) \
//   DATABASE_URL=postgresql://platformpub:$POSTGRES_PASSWORD@localhost:5432/platformpub \
//     npx vitest run tests/email-discoverability.test.ts
// =============================================================================

const DB_URL = process.env.TEST_DATABASE_URL ?? process.env.DATABASE_URL;

describe.skipIf(!DB_URL)("email discoverability is opt-in", () => {
  let client: pg.Client;
  const uniq = () => Math.random().toString(36).slice(2, 10);
  const made: string[] = [];

  async function makeAccount(opts: { discoverable?: boolean } = {}) {
    const u = `s16_${uniq()}`;
    const email = `${u}@example.com`;
    const pubkey = Array.from({ length: 64 }, () =>
      "0123456789abcdef"[Math.floor(Math.random() * 16)],
    ).join("");
    // `discoverable_by_email` is deliberately LEFT OUT of the insert when the
    // case is about the default — naming it, even as false, would test the
    // fixture rather than migration 196.
    const { rows } = await client.query<{ id: string }>(
      `INSERT INTO accounts (username, email, display_name, status, nostr_pubkey${
        opts.discoverable === undefined ? "" : ", discoverable_by_email"
      })
       VALUES ($1, $2, $3, 'active', $4${
         opts.discoverable === undefined ? "" : ", $5"
       })
       RETURNING id`,
      opts.discoverable === undefined
        ? [u, email, "S16 Tester", pubkey]
        : [u, email, "S16 Tester", pubkey, opts.discoverable],
    );
    made.push(rows[0].id);
    return { id: rows[0].id, username: u, email };
  }

  // The resolver's own statement. Kept here verbatim rather than imported
  // because `resolver.ts` pulls in the whole outbound-fetch world; what is under
  // test is the PREDICATE, and the file's own copy is asserted to contain it
  // by the last case, so the two cannot silently diverge.
  const LOOKUP = `SELECT id, username, display_name, avatar_blossom_url FROM accounts
     WHERE email = $1 AND status = 'active'
       AND discoverable_by_email = TRUE`;

  beforeAll(async () => {
    client = new pg.Client({ connectionString: DB_URL });
    await client.connect();
  });

  afterAll(async () => {
    if (made.length) {
      await client.query(`DELETE FROM accounts WHERE id = ANY($1::uuid[])`, [made]);
    }
    await client.end();
  });

  it("a brand-new account is NOT findable by email — the default decides", async () => {
    // A default is a decision, not a deferral: most members never open a
    // settings page, so defaulting TRUE would keep the oracle for nearly
    // everyone. This is the case that proves migration 196's default.
    const a = await makeAccount();
    const { rows } = await client.query(LOOKUP, [a.email]);
    expect(rows).toHaveLength(0);
  });

  it("an opted-in account IS findable by email", async () => {
    const a = await makeAccount({ discoverable: true });
    const { rows } = await client.query<{ id: string }>(LOOKUP, [a.email]);
    expect(rows.map((r) => r.id)).toEqual([a.id]);
  });

  it("an opted-out account is still findable by USERNAME", async () => {
    // The guard must not become "this person cannot be found". Every other
    // identifier the resolver takes is published; this one is not.
    const a = await makeAccount({ discoverable: false });
    const { rows } = await client.query(
      `SELECT id FROM accounts WHERE username = $1 AND status = 'active'`,
      [a.username],
    );
    expect(rows).toHaveLength(1);
  });

  it("an opted-out account answers exactly as an unknown address does", async () => {
    // Both must be silence. If the two differed in any observable way the column
    // would buy nothing — the oracle would just have grown a second step.
    const a = await makeAccount({ discoverable: false });
    const optedOut = await client.query(LOOKUP, [a.email]);
    const unknown = await client.query(LOOKUP, [`nobody_${uniq()}@example.com`]);
    expect(optedOut.rows).toEqual(unknown.rows);
  });

  it("the resolver's own statement carries the predicate", async () => {
    // A structural pin, not a behavioural one: the cases above run a copy of the
    // SQL, so this is what stops the copy and the original drifting apart.
    const { readFileSync } = await import("node:fs");
    const src = readFileSync(
      new URL("../src/lib/resolver.ts", import.meta.url),
      "utf8",
    );
    expect(src).toContain("discoverable_by_email = TRUE");
  });
});
