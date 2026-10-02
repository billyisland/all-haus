import { describe, it, expect, beforeAll, afterAll, vi } from "vitest";
import pg from "pg";
import Fastify, { type FastifyInstance } from "fastify";

// =============================================================================
// An RSS item carries the piece as HTML, not as markdown (CA-B5, 2026-09-29).
//
// `content_free` is the editor's markdown, and the three feeds put it raw in
// `content:encoded` and ran a tag-strip over it for `description` — text that
// had no tags. Rendered through `marked` and then the shared sanitiser, so a
// feed reader shows the piece and nothing the sanitiser refuses reaches a
// third-party renderer. DB-backed because the route reads real rows and the
// assertion is on the served document.
// =============================================================================

process.env.APP_URL ??= "https://all.haus.test";
process.env.PAYMENT_SERVICE_URL ??= "http://payment-service.test";
process.env.INTERNAL_SERVICE_TOKEN ??= "test-token";

const DB_URL = process.env.TEST_DATABASE_URL ?? process.env.DATABASE_URL;
const uniq = () => process.hrtime.bigint().toString(16);

vi.mock("@platform-pub/shared/lib/logger.js", () => ({
  default: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

const { rssRoutes } = await import("../src/routes/rss.js");

describe.skipIf(!DB_URL)("GET /rss/:username", () => {
  let client: pg.Client;
  let app: FastifyInstance;
  const accounts: string[] = [];

  beforeAll(async () => {
    process.env.DATABASE_URL = DB_URL;
    client = new pg.Client({ connectionString: DB_URL });
    await client.connect();
    app = Fastify();
    await app.register(rssRoutes);
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

  it("renders markdown to sanitised HTML, and the description is the rendered text", async () => {
    const username = `rss-${uniq()}`;
    const { rows } = await client.query<{ id: string }>(
      `INSERT INTO accounts (nostr_pubkey, nostr_privkey_enc, display_name, username, status)
       VALUES ($1, 'fixture-enc', 'Feed Writer', $2, 'active') RETURNING id`,
      [`fixture-b5-${uniq()}`.padEnd(64, "0"), username],
    );
    accounts.push(rows[0].id);
    const s = uniq();
    await client.query(
      `INSERT INTO articles (writer_id, nostr_event_id, nostr_d_tag, title, slug, published_at, content_free)
       VALUES ($1, $2, $3, 'A piece', $4, now(), $5)`,
      [rows[0].id, `${uniq()}`.padEnd(64, "b"), `d-${s}`, `s-${s}`,
        "A **bold** opening.\n\n<script>alert(1)</script>\n\n- one\n- two"],
    );

    const res = await app.inject({ method: "GET", url: `/rss/${username}` });
    expect(res.statusCode).toBe(200);
    expect(res.headers["content-type"]).toContain("application/rss+xml");
    const xml = res.body;

    const encoded = xml.match(/<content:encoded><!\[CDATA\[([\s\S]*?)\]\]><\/content:encoded>/)![1];
    expect(encoded).toContain("<strong>bold</strong>");
    expect(encoded).toContain("<li>one</li>");
    expect(encoded).not.toContain("**bold**");
    // The sanitiser's allow-list, not marked's: a script never reaches the reader's renderer.
    expect(encoded).not.toMatch(/<script/i);

    const description = xml.match(/<description>([\s\S]*?)<\/description>/g)![1];
    expect(description).toContain("A bold opening.");
    expect(description).not.toContain("**");
    expect(description).not.toContain("&lt;strong&gt;");
  });
});
