import { describe, it, expect, beforeAll, afterAll, vi } from "vitest";
import pg from "pg";
import Fastify, { type FastifyInstance } from "fastify";

// =============================================================================
// A d-tag addresses ONE live piece (CA-B4, 2026-09-29).
//
// `idx_articles_unique_live` is partial on `deleted_at IS NULL`, so a
// withdrawn row and its live re-publish coexist under one d-tag — and
// `GET /articles/:dTag` had no ORDER BY, so `rows[0]` was whichever the
// planner found: a public 404 for a live piece. The index is also per
// WRITER, and the address is by d-tag alone, so a chosen collision put one
// writer's piece at another's address.
//
// DB-backed because both halves are about which ROW a statement lands on:
// the GET's ordering and the POST's refusal are only visible against real
// rows under a real partial index.
// =============================================================================

process.env.PAYMENT_SERVICE_URL ??= "http://payment-service.test";
process.env.INTERNAL_SERVICE_TOKEN ??= "test-token";
process.env.KEY_SERVICE_URL ??= "http://key-service.test";
process.env.READER_HASH_KEY ??= "test-reader-hash-key";
process.env.INTERNAL_SECRET ??= "test-internal-secret";

const DB_URL = process.env.TEST_DATABASE_URL ?? process.env.DATABASE_URL;
const uniq = () => process.hrtime.bigint().toString(16);

let viewer: string | null = null;
vi.mock("../src/middleware/auth.js", () => ({
  requireAuth: (req: any, _reply: any, done: any) => {
    req.session = { sub: viewer, pubkey: "0".repeat(64) };
    done();
  },
  optionalAuth: (req: any, _reply: any, done: any) => {
    if (viewer) req.session = { sub: viewer, pubkey: "0".repeat(64) };
    done();
  },
}));
vi.mock("../src/routes/drives.js", () => ({
  matchDriveForPublish: vi.fn(async () => null),
  queueDriveFulfilment: vi.fn(),
}));
vi.mock("@platform-pub/shared/lib/publish-emails.js", () => ({
  sendPublishNotifications: vi.fn(async () => undefined),
}));
vi.mock("@platform-pub/shared/lib/logger.js", () => ({
  default: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

const { articlePublishRoutes } = await import("../src/routes/articles/publish.js");

describe.skipIf(!DB_URL)("articles by d-tag", () => {
  let client: pg.Client;
  let app: FastifyInstance;
  const accounts: string[] = [];

  async function account(name: string): Promise<string> {
    const { rows } = await client.query<{ id: string }>(
      // Admitted as writers: every fixture here publishes (READER-WRITER-SPLIT-ADR).
      `INSERT INTO accounts (nostr_pubkey, nostr_privkey_enc, display_name, username, status, writer_admitted_at)
       VALUES ($1, 'fixture-enc', $2, $3, 'active', now()) RETURNING id`,
      [`fixture-b4-${uniq()}`.padEnd(64, "0"), name, `b4-${uniq()}`],
    );
    accounts.push(rows[0].id);
    return rows[0].id;
  }
  async function articleRow(writer: string, dTag: string, title: string, deleted: boolean): Promise<string> {
    const { rows } = await client.query<{ id: string }>(
      `INSERT INTO articles (writer_id, nostr_event_id, nostr_d_tag, title, slug, published_at, deleted_at)
       VALUES ($1, $2, $3, $4, $5, now() - interval '1 day', $6) RETURNING id`,
      [writer, `${uniq()}`.padEnd(64, "e"), dTag, title, `s-${uniq()}`, deleted ? new Date() : null],
    );
    return rows[0].id;
  }

  beforeAll(async () => {
    process.env.DATABASE_URL = DB_URL;
    client = new pg.Client({ connectionString: DB_URL });
    await client.connect();
    app = Fastify();
    await app.register(articlePublishRoutes);
    await app.ready();
  });
  afterAll(async () => {
    if (accounts.length) {
      await client.query(`DELETE FROM feed_items WHERE author_id = ANY($1::uuid[])`, [accounts]);
      await client.query(`DELETE FROM articles WHERE writer_id = ANY($1::uuid[])`, [accounts]);
      await client.query(`DELETE FROM accounts WHERE id = ANY($1::uuid[])`, [accounts]);
    }
    await app?.close();
    await client?.end();
  });

  it("GET serves the LIVE row when a withdrawn one shares the d-tag, whatever order they were written in", async () => {
    const writer = await account("Writer");
    const dTag = `d-${uniq()}`;
    // The withdrawn row first, then the live re-publish — the order an
    // unordered scan is most likely to return.
    await articleRow(writer, dTag, "Withdrawn copy", true);
    const live = await articleRow(writer, dTag, "Live copy", false);

    viewer = null;
    const res = await app.inject({ method: "GET", url: `/articles/${dTag}` });
    expect(res.statusCode).toBe(200);
    expect(res.json().id).toBe(live);
    expect(res.json().title).toBe("Live copy");
  });

  it("GET still reaches the withdrawn arm when no live row exists — 404 to the world", async () => {
    const writer = await account("Writer");
    const dTag = `d-${uniq()}`;
    await articleRow(writer, dTag, "Gone", true);
    viewer = null;
    const res = await app.inject({ method: "GET", url: `/articles/${dTag}` });
    expect(res.statusCode).toBe(404);
  });

  const body = (dTag: string) => ({
    nostrEventId: `${uniq()}`.padEnd(64, "f"),
    dTag,
    title: "A piece",
    content: "Body.",
    accessMode: "public",
    pricePence: 0,
    gatePositionPct: 0,
    sendEmail: false,
  });

  it("POST refuses a d-tag live under ANOTHER writer — 409, and no row", async () => {
    const owner = await account("Owner");
    const other = await account("Other");
    const dTag = `d-${uniq()}`;
    await articleRow(owner, dTag, "Theirs", false);

    viewer = other;
    const res = await app.inject({ method: "POST", url: "/articles", payload: body(dTag) });
    expect(res.statusCode).toBe(409);
    expect(res.json().error).toBe("d_tag_taken");
    const { rows } = await client.query(`SELECT 1 FROM articles WHERE writer_id = $1 AND nostr_d_tag = $2`, [other, dTag]);
    expect(rows).toHaveLength(0);
  });

  it("POST still lets the owner edit their own live d-tag, and lets anyone take a WITHDRAWN one", async () => {
    const owner = await account("Owner");
    const other = await account("Other");
    const dTag = `d-${uniq()}`;
    await articleRow(owner, dTag, "Theirs", false);

    viewer = owner;
    const edit = await app.inject({ method: "POST", url: "/articles", payload: body(dTag) });
    expect([200, 201]).toContain(edit.statusCode);

    const withdrawn = `d-${uniq()}`;
    await articleRow(owner, withdrawn, "Gone", true);
    viewer = other;
    const take = await app.inject({ method: "POST", url: "/articles", payload: body(withdrawn) });
    expect([200, 201]).toContain(take.statusCode);
  });
});
