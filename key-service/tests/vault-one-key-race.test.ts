import { describe, it, expect, beforeAll, afterAll, vi } from "vitest";
import pg from "pg";

// =============================================================================
// ONE VAULT KEY PER ARTICLE, EVEN WHEN TWO FIRST SEALS RACE (CA-F14(d)).
//
// publishArticle read `vault_keys WHERE article_id` and inserted a fresh key
// when it found none, with nothing between — so two seals of one new article
// in flight together each minted a key, and every later read by article_id
// picked one: a reader could be issued the key the body was NOT encrypted with.
// The arbiter is now the unique index on article_id (migration 268).
//
// DB-backed, and the interleaving is FORCED: each transaction's INSERT waits
// until BOTH have read "no key", which is the losing order a lucky schedule
// would hide. Only the KMS and the cipher are mocked (they need no database and
// carry no claim here); the SQL runs against Postgres.
//
// MUTATION: drop `ON CONFLICT (article_id) DO NOTHING` → the loser throws 23505.
// Drop migration 268's index → two rows, and the assertions below go red.
//
//   DATABASE_URL=postgresql://platformpub:password@localhost:5432/platformpub \
//     npx vitest run tests/vault-one-key-race.test.ts
// =============================================================================

const DB_URL = process.env.TEST_DATABASE_URL ?? process.env.DATABASE_URL;

// Two transactions each reach their INSERT only after both have SELECTed.
let arrivals = 0;
let releaseReads: () => void = () => {};
const bothRead = new Promise<void>((r) => (releaseReads = r));

vi.mock("@platform-pub/shared/db/client.js", async (importOriginal) => {
  const real = await importOriginal<typeof import("@platform-pub/shared/db/client.js")>();
  return {
    ...real,
    withTransaction: <T>(fn: (c: pg.PoolClient) => Promise<T>) =>
      real.withTransaction((client) => {
        const query = client.query.bind(client) as (...a: unknown[]) => Promise<unknown>;
        const gated = new Proxy(client, {
          get(target, prop, recv) {
            if (prop !== "query") return Reflect.get(target, prop, recv);
            return async (sql: unknown, params?: unknown) => {
              if (typeof sql === "string" && sql.includes("INSERT INTO vault_keys")) {
                if (++arrivals >= 2) releaseReads();
                await bothRead;
              }
              return query(sql, params);
            };
          },
        });
        return fn(gated as pg.PoolClient);
      }),
  };
});
vi.mock("@platform-pub/shared/lib/logger.js", () => ({
  default: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));
let keySeq = 0;
vi.mock("../src/lib/kms.js", () => ({
  generateContentKey: vi.fn(() => Buffer.alloc(32, ++keySeq)),
  encryptContentKey: vi.fn((k: Buffer) => k.toString("hex")),
  decryptContentKey: vi.fn((enc: string) => Buffer.from(enc, "hex")),
}));
vi.mock("../src/lib/crypto.js", () => ({
  encryptArticleBodyXChaCha: vi.fn((_body: string, key: Buffer) => `sealed-with-${key.toString("hex")}`),
  decryptArticleBodyXChaCha: vi.fn(),
  decryptArticleBody: vi.fn(),
}));

describe.skipIf(!DB_URL)("publishArticle — two first seals of one article", () => {
  let client: pg.Client;
  let writerId: string;
  let articleId: string;
  const stamp = Date.now().toString(36);

  beforeAll(async () => {
    client = new pg.Client({ connectionString: DB_URL });
    await client.connect();
    const { rows: [w] } = await client.query<{ id: string }>(
      `INSERT INTO accounts (nostr_pubkey) VALUES ($1) RETURNING id`,
      [`vrace${stamp}`.padEnd(64, "0")],
    );
    writerId = w.id;
    const { rows: [a] } = await client.query<{ id: string }>(
      `INSERT INTO articles (writer_id, nostr_event_id, nostr_d_tag, title, slug)
       VALUES ($1, $2, $3, 'T', $3) RETURNING id`,
      [writerId, `vrace${stamp}`.padEnd(64, "a"), `vrace-${stamp}`],
    );
    articleId = a.id;
  });

  afterAll(async () => {
    await client.query(`DELETE FROM vault_keys WHERE article_id = $1`, [articleId]);
    await client.query(`DELETE FROM articles WHERE id = $1`, [articleId]);
    await client.query(`DELETE FROM accounts WHERE id = $1`, [writerId]);
    await client.end();
  });

  it("leaves one key row, and both seals encrypt with that key", async () => {
    const { vaultService } = await import("../src/services/vault.js");
    const seal = (event: string) =>
      vaultService.publishArticle({
        articleId,
        nostrArticleEventId: event.padEnd(64, "0"),
        paywallBody: "the paid half",
        pricePence: 100,
        gatePositionPct: 50,
        nostrDTag: `vrace-${stamp}`,
      });

    const [one, two] = await Promise.all([seal(`e1${stamp}`), seal(`e2${stamp}`)]);

    const { rows } = await client.query<{ id: string; content_key_enc: string; ciphertext: string }>(
      `SELECT id, content_key_enc, ciphertext FROM vault_keys WHERE article_id = $1`,
      [articleId],
    );
    expect(rows).toHaveLength(1);
    expect(one.vaultKeyId).toBe(rows[0].id);
    expect(two.vaultKeyId).toBe(rows[0].id);
    // Both bodies were sealed with the ONE stored key — the property a reader
    // depends on; two keys made one of these name a key nobody can be issued.
    expect(one.ciphertext).toBe(`sealed-with-${rows[0].content_key_enc}`);
    expect(two.ciphertext).toBe(`sealed-with-${rows[0].content_key_enc}`);
  });
});
