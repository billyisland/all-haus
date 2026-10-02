import { describe, it, expect, beforeAll, afterAll, vi } from "vitest";
import pg from "pg";
import Fastify from "fastify";

// =============================================================================
// The composer lists a feed's sources ALPHABETICALLY, by the label it renders.
//
// A composition is a set, not a log. Ordering by created_at meant the list
// reshuffled itself as the author added to it, and a source was findable only
// by remembering when it had been added — worst for exactly the feeds where
// finding one matters, the long ones.
//
// DB-BACKED, AND IT HAS TO BE. The label is not a column: it is assembled in
// `sourceRowToResponse` out of four different fallback chains (display name →
// username → "(deleted account)", the tag's `#`, an external source's URI),
// and the sort runs over the assembled string. A mocked pool would hand back
// rows in whatever order the fixture listed them, which is to say it would
// assert the fixture rather than the ordering.
//
// Every fixture row below is inserted with an EXPLICIT created_at whose order
// is DIFFERENT from its alphabetical one, so a slip back to `ORDER BY
// fs.created_at` fails here rather than passing by coincidence.
//
// MUTATION LOG (each reverted, suite re-run, then restored):
//   1. sources.ts: drop the `.sort(...)` from loadFeedSources
//      ⇒ "orders by the rendered label" fails (created_at order).     DETECTED
//   2. sources.ts: compareSourceLabels without LEADING_SIGIL_RE
//      ⇒ "files a tag under its letter" fails (#longform first).      DETECTED
//   3. sources.ts: Collator sensitivity "base" → "variant" is NOT detected
//      (it separates case only when the base letters tie, which these
//      fixtures avoid); `numeric: true` → false IS, via the two digit rows.
//
// Run locally (both vars — the fixtures use their own client, the route uses
// the shared pool, which reads DATABASE_URL):
//   DATABASE_URL=postgresql://platformpub:password@localhost:5432/platformpub \
//   TEST_DATABASE_URL=$DATABASE_URL npx vitest run tests/feed-source-order.test.ts
// =============================================================================

process.env.PAYMENT_SERVICE_URL ??= "http://payment-service.test";
process.env.INTERNAL_SERVICE_TOKEN ??= "test-token";

const DB_URL = process.env.TEST_DATABASE_URL ?? process.env.DATABASE_URL;
const uniq = () => process.hrtime.bigint().toString(16);

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

const { registerFeedSourcesRoutes } = await import(
  "../src/routes/feeds/sources.js"
);

describe.skipIf(!DB_URL)("the composer's source list is alphabetical", () => {
  let client: pg.Client;
  let app: Awaited<ReturnType<typeof build>>;
  const cleanupAccounts: string[] = [];
  // external_sources rows are nobody's child, so deleting the owner does not
  // cascade them — they would outlive the run as litter in a dev database.
  const cleanupSources: string[] = [];
  let feedId = "unset";

  async function build() {
    const a = Fastify({ logger: false });
    registerFeedSourcesRoutes(a);
    await a.ready();
    return a;
  }

  /** An account source. `minutesAgo` is the created_at the sort must ignore. */
  async function accountSource(displayName: string, minutesAgo: number) {
    const { rows } = await client.query<{ id: string }>(
      `INSERT INTO accounts (nostr_pubkey, nostr_privkey_enc, display_name, username)
       VALUES ($1, 'fixture-enc', $2, $3) RETURNING id`,
      [`fixture-order-${uniq()}`, displayName, `order${uniq()}`],
    );
    cleanupAccounts.push(rows[0].id);
    await client.query(
      `INSERT INTO feed_sources (feed_id, source_type, account_id, created_at)
       VALUES ($1, 'account', $2, now() - ($3 || ' minutes')::interval)`,
      [feedId, rows[0].id, String(minutesAgo)],
    );
  }

  async function externalSourceRow(displayName: string, minutesAgo: number) {
    const ext = await client.query<{ id: string }>(
      `INSERT INTO external_sources (protocol, source_uri, display_name)
       VALUES ('rss', $1, $2) RETURNING id`,
      [`https://order.test/${uniq()}.xml`, displayName],
    );
    cleanupSources.push(ext.rows[0].id);
    await client.query(
      `INSERT INTO feed_sources (feed_id, source_type, external_source_id, created_at)
       VALUES ($1, 'external_source', $2, now() - ($3 || ' minutes')::interval)`,
      [feedId, ext.rows[0].id, String(minutesAgo)],
    );
  }

  async function tagSource(name: string, minutesAgo: number) {
    await client.query(
      `INSERT INTO feed_sources (feed_id, source_type, tag_name, created_at)
       VALUES ($1, 'tag', $2, now() - ($3 || ' minutes')::interval)`,
      [feedId, name, String(minutesAgo)],
    );
  }

  async function labels(): Promise<string[]> {
    const res = await app.inject({
      method: "GET",
      url: `/feeds/${feedId}/sources`,
    });
    expect(res.statusCode).toBe(200);
    return res
      .json()
      .sources.map((s: { display: { label: string } }) => s.display.label);
  }

  beforeAll(async () => {
    client = new pg.Client({ connectionString: DB_URL });
    await client.connect();
    const { rows } = await client.query<{ id: string }>(
      `INSERT INTO accounts (nostr_pubkey, nostr_privkey_enc, display_name)
       VALUES ($1, 'fixture-enc', 'Fixture order owner') RETURNING id`,
      [`fixture-order-owner-${uniq()}`],
    );
    ownerId = rows[0].id;
    cleanupAccounts.push(rows[0].id);
    const f = await client.query<{ id: string }>(
      `INSERT INTO feeds (owner_id, name, sort_rank) VALUES ($1, 'order', 1)
       RETURNING id`,
      [ownerId],
    );
    feedId = f.rows[0].id;
    app = await build();

    // Insertion order (newest created_at last) is deliberately NOT the
    // alphabetical one: zebra, apple, #longform, Chapter 10, Chapter 2, bee.
    await accountSource("Zebra Quarterly", 6);
    await externalSourceRow("apple bulletin", 5);
    await tagSource("longform", 4);
    await externalSourceRow("Chapter 10", 3);
    await externalSourceRow("Chapter 2", 2);
    await accountSource("bee keeper", 1);
  });

  afterAll(async () => {
    if (cleanupAccounts.length)
      await client.query(`DELETE FROM accounts WHERE id = ANY($1::uuid[])`, [
        cleanupAccounts,
      ]);
    if (cleanupSources.length)
      await client.query(
        `DELETE FROM external_sources WHERE id = ANY($1::uuid[])`,
        [cleanupSources],
      );
    await app?.close();
    await client.end();
  });

  it("orders by the rendered label, not by when the source was added", async () => {
    expect(await labels()).toEqual([
      "apple bulletin",
      "bee keeper",
      "Chapter 2",
      "Chapter 10",
      "#longform",
      "Zebra Quarterly",
    ]);
  });

  it("reads case-insensitively, so capitals do not sort into their own block", async () => {
    const got = await labels();
    // The byte order would be Chapter*, Zebra, #longform, apple, bee: every
    // capital ahead of every lowercase. What the eye reads is a→b→C→C→l→Z.
    expect(got.indexOf("apple bulletin")).toBeLessThan(
      got.indexOf("Chapter 2"),
    );
    expect(got.indexOf("bee keeper")).toBeLessThan(got.indexOf("Zebra Quarterly"));
  });

  it("counts digits as numbers, so 2 comes before 10", async () => {
    const got = await labels();
    expect(got.indexOf("Chapter 2")).toBeLessThan(got.indexOf("Chapter 10"));
  });

  it("files a tag under its letter rather than under its sigil", async () => {
    const got = await labels();
    // `#longform` reads as "longform": after bee, before Zebra. Sorting the
    // raw string would put every tag in a punctuation block at the top.
    expect(got.indexOf("#longform")).toBeGreaterThan(got.indexOf("bee keeper"));
    expect(got.indexOf("#longform")).toBeLessThan(
      got.indexOf("Zebra Quarterly"),
    );
  });
});
