import { describe, it, expect, beforeAll, afterAll, vi } from "vitest";
import pg from "pg";
import Fastify, { type FastifyInstance } from "fastify";

// =============================================================================
// A gift-link redemption is spent only where it granted something (CA-B6,
// 2026-09-29).
//
// The route incremented `redemption_count` in an autocommit UPDATE and then
// inserted the unlock `ON CONFLICT DO NOTHING`, so a reader who already held
// the piece — a prior redemption, a purchase, a second device — burned one of
// the link's redemptions and got nothing for it; and `req.body.token` on an
// absent body was a 500. DB-backed because every case is about which ROWS
// moved: the count and the unlock are read back off the tables.
// =============================================================================

process.env.PAYMENT_SERVICE_URL ??= "http://payment-service.test";
process.env.INTERNAL_SERVICE_TOKEN ??= "test-token";
process.env.KEY_SERVICE_URL ??= "http://key-service.test";
process.env.READER_HASH_KEY ??= "test-reader-hash-key";
process.env.INTERNAL_SECRET ??= "test-internal-secret";

const DB_URL = process.env.TEST_DATABASE_URL ?? process.env.DATABASE_URL;
const uniq = () => process.hrtime.bigint().toString(16);

let viewer = "unset";
vi.mock("../src/middleware/auth.js", () => ({
  requireAuth: (req: any, _reply: any, done: any) => {
    req.session = { sub: viewer, pubkey: "0".repeat(64) };
    done();
  },
  optionalAuth: (req: any, _reply: any, done: any) => {
    req.session = { sub: viewer, pubkey: "0".repeat(64) };
    done();
  },
}));
vi.mock("@platform-pub/shared/lib/logger.js", () => ({
  default: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

const { giftLinkRoutes } = await import("../src/routes/gift-links.js");

describe.skipIf(!DB_URL)("POST /articles/:articleId/redeem-gift", () => {
  let client: pg.Client;
  let app: FastifyInstance;
  const accounts: string[] = [];

  async function account(name: string): Promise<string> {
    const { rows } = await client.query<{ id: string }>(
      `INSERT INTO accounts (nostr_pubkey, nostr_privkey_enc, display_name, status)
       VALUES ($1, 'fixture-enc', $2, 'active') RETURNING id`,
      [`fixture-b6-${uniq()}`.padEnd(64, "0"), name],
    );
    accounts.push(rows[0].id);
    return rows[0].id;
  }
  async function article(writer: string): Promise<string> {
    const s = uniq();
    const { rows } = await client.query<{ id: string }>(
      `INSERT INTO articles (writer_id, nostr_event_id, nostr_d_tag, title, slug, published_at, access_mode, price_pence)
       VALUES ($1, $2, $3, 'T', $4, now(), 'paywalled', 300) RETURNING id`,
      [writer, `${uniq()}`.padEnd(64, "a"), `d-${s}`, `s-${s}`],
    );
    return rows[0].id;
  }
  async function link(articleId: string, creator: string, over: Record<string, unknown> = {}): Promise<{ id: string; token: string }> {
    const token = `tok-${uniq()}`;
    const { rows } = await client.query<{ id: string }>(
      `INSERT INTO gift_links (article_id, creator_id, token, max_redemptions, redemption_count, revoked_at, expires_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7) RETURNING id`,
      [
        articleId, creator, token,
        over.max_redemptions ?? 2, over.redemption_count ?? 0,
        over.revoked_at ?? null, over.expires_at ?? null,
      ],
    );
    return { id: rows[0].id, token };
  }
  async function count(linkId: string): Promise<number> {
    const { rows } = await client.query<{ redemption_count: number }>(`SELECT redemption_count FROM gift_links WHERE id = $1`, [linkId]);
    return Number(rows[0].redemption_count);
  }
  async function unlocked(reader: string, articleId: string): Promise<boolean> {
    const { rows } = await client.query(`SELECT 1 FROM article_unlocks WHERE reader_id = $1 AND article_id = $2`, [reader, articleId]);
    return rows.length > 0;
  }
  const redeem = (who: string, articleId: string, payload: unknown) => {
    viewer = who;
    return app.inject({ method: "POST", url: `/articles/${articleId}/redeem-gift`, payload: payload as Record<string, unknown> });
  };

  beforeAll(async () => {
    process.env.DATABASE_URL = DB_URL;
    client = new pg.Client({ connectionString: DB_URL });
    await client.connect();
    app = Fastify();
    await app.register(giftLinkRoutes);
    await app.ready();
  });
  afterAll(async () => {
    if (accounts.length) {
      await client.query(`DELETE FROM article_unlocks WHERE reader_id = ANY($1::uuid[])`, [accounts]);
      await client.query(`DELETE FROM gift_links WHERE creator_id = ANY($1::uuid[])`, [accounts]);
      await client.query(`DELETE FROM feed_items WHERE author_id = ANY($1::uuid[])`, [accounts]);
      await client.query(`DELETE FROM articles WHERE writer_id = ANY($1::uuid[])`, [accounts]);
      await client.query(`DELETE FROM accounts WHERE id = ANY($1::uuid[])`, [accounts]);
    }
    await app?.close();
    await client?.end();
  });

  it("a fresh redemption unlocks the piece and spends ONE redemption", async () => {
    const writer = await account("Writer");
    const reader = await account("Reader");
    const a = await article(writer);
    const l = await link(a, writer);
    const res = await redeem(reader, a, { token: l.token });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ ok: true, unlocked: true, redeemed: true });
    expect(await unlocked(reader, a)).toBe(true);
    expect(await count(l.id)).toBe(1);
  });

  it("the same reader presenting the link again spends nothing", async () => {
    const writer = await account("Writer");
    const reader = await account("Reader");
    const a = await article(writer);
    const l = await link(a, writer);
    await redeem(reader, a, { token: l.token });
    const again = await redeem(reader, a, { token: l.token });
    expect(again.statusCode).toBe(200);
    expect(again.json()).toEqual({ ok: true, unlocked: true, redeemed: false });
    expect(await count(l.id)).toBe(1);
  });

  it("a reader who already bought the piece spends nothing either", async () => {
    const writer = await account("Writer");
    const reader = await account("Reader");
    const a = await article(writer);
    await client.query(`INSERT INTO article_unlocks (reader_id, article_id, unlocked_via) VALUES ($1, $2, 'purchase')`, [reader, a]);
    const l = await link(a, writer);
    const res = await redeem(reader, a, { token: l.token });
    expect(res.statusCode).toBe(200);
    expect(res.json().redeemed).toBe(false);
    expect(await count(l.id)).toBe(0);
  });

  it("a revoked, expired or exhausted link is refused with nothing granted", async () => {
    const writer = await account("Writer");
    const reader = await account("Reader");
    const a = await article(writer);
    const revoked = await link(a, writer, { revoked_at: new Date() });
    const expired = await link(a, writer, { expires_at: new Date(Date.now() - 1000) });
    const spent = await link(a, writer, { max_redemptions: 1, redemption_count: 1 });
    for (const l of [revoked, expired, spent]) {
      const res = await redeem(reader, a, { token: l.token });
      expect(res.statusCode).toBe(410);
    }
    expect(await unlocked(reader, a)).toBe(false);
    expect(await count(spent.id)).toBe(1);
  });

  it("an absent or empty token is a 400, never a 500", async () => {
    const writer = await account("Writer");
    const reader = await account("Reader");
    const a = await article(writer);
    expect((await redeem(reader, a, {})).statusCode).toBe(400);
    expect((await redeem(reader, a, { token: "" })).statusCode).toBe(400);
  });
});
