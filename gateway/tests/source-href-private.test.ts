import { describe, it, expect, beforeAll, afterAll, vi } from "vitest";
import pg from "pg";
import Fastify from "fastify";

// =============================================================================
// THE COMPOSER LINKS A SOURCE ONLY WHERE ITS PAGE OPENS (MODERNHAUS-ADR §E7.3).
//
// `display.href` is the gateway's own link for a feed source's name, and both
// registers render it. For an external source it was `/source/<id>`
// unconditionally — but `GET /sources/:id` answers 404 for a private protocol
// (an email newsletter is one member's inbox) and for an inactive row, so the
// composer offered a link that could not open. The href now carries the
// route's two conditions.
//
// DB-BACKED, because `is_active` arrives through the hydrated SELECT's join and
// a mocked pool would hand back whatever the fixture said. Each private row
// differs from the public one in ONE column.
//
// Run locally (both vars):
//   DATABASE_URL=postgresql://platformpub:password@localhost:5432/platformpub \
//   TEST_DATABASE_URL=$DATABASE_URL npx vitest run tests/source-href-private.test.ts
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

describe.skipIf(!DB_URL)("the composer's source href", () => {
  let client: pg.Client;
  let app: Awaited<ReturnType<typeof build>>;
  const cleanupSources: string[] = [];
  let feedId = "unset";
  const ids: Record<string, string> = {};

  async function build() {
    const a = Fastify({ logger: false });
    registerFeedSourcesRoutes(a);
    await a.ready();
    return a;
  }

  async function source(label: string, protocol: string, isActive: boolean) {
    const ext = await client.query<{ id: string }>(
      `INSERT INTO external_sources (protocol, source_uri, display_name, is_active)
       VALUES ($1, $2, $3, $4) RETURNING id`,
      [protocol, `https://href.test/${uniq()}`, label, isActive],
    );
    cleanupSources.push(ext.rows[0].id);
    ids[label] = ext.rows[0].id;
    await client.query(
      `INSERT INTO feed_sources (feed_id, source_type, external_source_id)
       VALUES ($1, 'external_source', $2)`,
      [feedId, ext.rows[0].id],
    );
  }

  async function hrefs(): Promise<Record<string, string | null>> {
    const res = await app.inject({ method: "GET", url: `/feeds/${feedId}/sources` });
    expect(res.statusCode).toBe(200);
    const out: Record<string, string | null> = {};
    for (const s of res.json().sources as { display: { label: string; href: string | null } }[]) {
      out[s.display.label] = s.display.href;
    }
    return out;
  }

  beforeAll(async () => {
    client = new pg.Client({ connectionString: DB_URL });
    await client.connect();
    const { rows } = await client.query<{ id: string }>(
      `INSERT INTO accounts (nostr_pubkey, nostr_privkey_enc, display_name)
       VALUES ($1, 'fixture-enc', 'Fixture href owner') RETURNING id`,
      [`fixture-href-owner-${uniq()}`],
    );
    ownerId = rows[0].id;
    const f = await client.query<{ id: string }>(
      `INSERT INTO feeds (owner_id, name, sort_rank) VALUES ($1, 'href', 1) RETURNING id`,
      [ownerId],
    );
    feedId = f.rows[0].id;
    app = await build();

    await source("public blog", "rss", true);
    await source("private newsletter", "email", true);
    await source("dead blog", "rss", false);
  });

  afterAll(async () => {
    await client.query(`DELETE FROM accounts WHERE id = $1`, [ownerId]);
    if (cleanupSources.length)
      await client.query(`DELETE FROM external_sources WHERE id = ANY($1::uuid[])`, [cleanupSources]);
    await app?.close();
    await client.end();
  });

  it("links an active source of a public protocol to its page", async () => {
    expect((await hrefs())["public blog"]).toBe(`/source/${ids["public blog"]}`);
  });

  it("offers no link to an email newsletter, which the source route will not serve", async () => {
    const got = await hrefs();
    expect(Object.keys(got)).toContain("private newsletter");
    expect(got["private newsletter"]).toBeNull();
  });

  it("offers no link to an inactive source", async () => {
    const got = await hrefs();
    expect(Object.keys(got)).toContain("dead blog");
    expect(got["dead blog"]).toBeNull();
  });
});
