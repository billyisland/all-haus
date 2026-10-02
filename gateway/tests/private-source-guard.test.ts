import { describe, it, expect, vi, beforeEach } from "vitest";
import Fastify from "fastify";

// =============================================================================
// A source is addressable by uuid only if it is PUBLIC (MIRROR-AUDIT §3, S16).
//
// `external_sources` is one shared row per (protocol, source_uri), and two
// routes take that row's uuid straight from the caller with no protocol check:
// `GET /sources/:id` reads its items, and `POST /workspace/feeds/:id/sources`
// with an `externalSourceId` adds it to a feed AND mints the caller an
// `external_subscriptions` row against it. For an `email` source that means
// reading another member's private newsletter out of a uuid — and, on the add
// path, subscribing to it in that member's name. An email source is reached
// through `external_sources.ingest_address`, a per-subscriber secret alias, and
// `feeds/formulas.ts` already refuses to let one travel in a share link for
// exactly this reason.
//
// WHAT THESE CASES ASSERT, AND WHY NOT ONLY THE STATUS CODE. A route that
// refuses AFTER reading the items has still read them, and on the add path a
// route that refuses after the INSERT has still subscribed the caller. So the
// read case asserts THE ITEMS QUERY NEVER RAN and the add case asserts NO
// SUBSCRIPTION WAS WRITTEN. The 404 is checked too, and is deliberately a 404
// rather than a 403: a private source must not be distinguishable from one that
// does not exist, or the route stays an oracle for which uuids name a
// newsletter even after it stops serving one.
//
// THE PUBLIC CASE IS THE ONE THAT MATTERS. A guard written as a blanket refusal
// — or an allow-list that lost an entry — breaks every ordinary RSS and Bluesky
// source on the site, which a suite testing only the email case goes green
// against. Hence every case below is paired with its rss control.
//
// Mutation-proved: drop either guard and its case goes red; add "email" to
// PUBLIC_SOURCE_PROTOCOLS and both email cases go red.
// =============================================================================

const VIEWER = "00000000-0000-4000-8000-0000000000a1";
const EMAIL_SOURCE = "00000000-0000-4000-8000-0000000000e1";
const RSS_SOURCE = "00000000-0000-4000-8000-0000000000f2";
const FEED_ID = "00000000-0000-4000-8000-0000000000c3";

let calls: Array<{ sql: string; params: unknown[] }> = [];

const ran = (fragment: string) => calls.some((c) => c.sql.includes(fragment));

function scriptedQuery(sql: string, params: unknown[] = []) {
  calls.push({ sql, params });

  // The source row — answered from the id it is HANDED, not from a fixture.
  if (sql.includes("FROM external_sources") && sql.includes("WHERE id = $1")) {
    if (params[0] === EMAIL_SOURCE) {
      return Promise.resolve({
        rows: [
          {
            id: EMAIL_SOURCE,
            protocol: "email",
            source_uri: "mailto:secret-alias@in.all.haus",
            display_name: "Somebody's newsletter",
            description: null,
          },
        ],
        rowCount: 1,
      });
    }
    if (params[0] === RSS_SOURCE) {
      return Promise.resolve({
        rows: [
          {
            id: RSS_SOURCE,
            protocol: "rss",
            source_uri: "https://example.com/feed.xml",
            display_name: "A public feed",
            description: null,
          },
        ],
        rowCount: 1,
      });
    }
    return Promise.resolve({ rows: [], rowCount: 0 });
  }

  if (sql.includes("FROM external_subscriptions")) {
    return Promise.resolve({ rows: [], rowCount: 0 });
  }
  if (sql.includes("INSERT INTO external_subscriptions")) {
    return Promise.resolve({ rows: [], rowCount: 1 });
  }
  if (sql.includes("UPDATE external_sources")) {
    return Promise.resolve({ rows: [], rowCount: 1 });
  }
  if (sql.includes("pg_advisory_xact_lock")) {
    return Promise.resolve({ rows: [], rowCount: 0 });
  }
  if (sql.includes("INSERT INTO feed_sources")) {
    return Promise.resolve({ rows: [{ id: "fs-1" }], rowCount: 1 });
  }
  // The hydration read insertSource does after the INSERT, to project the row.
  if (sql.includes("FROM feed_sources") && sql.includes("WHERE fs.id = $1")) {
    return Promise.resolve({
      rows: [
        {
          id: "fs-1",
          source_type: "external_source",
          external_source_id: RSS_SOURCE,
          account_id: null,
          publication_id: null,
          tag_name: null,
          weight: 1,
          sampling_mode: "random",
          exclude_replies: false,
          muted_at: null,
          created_at: new Date(),
          external_protocol: "rss",
          external_source_uri: "https://example.com/feed.xml",
          external_display_name: "A public feed",
        },
      ],
      rowCount: 1,
    });
  }
  return Promise.resolve({ rows: [], rowCount: 0 });
}

vi.mock("@platform-pub/shared/db/client.js", () => ({
  pool: { query: (sql: string, p: unknown[] = []) => scriptedQuery(sql, p) },
  withTransaction: (cb: (c: { query: typeof scriptedQuery }) => Promise<unknown>) =>
    cb({ query: scriptedQuery }),
}));

vi.mock("@platform-pub/shared/lib/logger.js", () => ({
  default: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

vi.mock("../src/middleware/auth.js", () => ({
  requireAuth: async (req: { session?: { sub: string } }) => {
    req.session = { sub: VIEWER };
  },
  optionalAuth: async (req: { session?: { sub: string } }) => {
    req.session = { sub: VIEWER };
  },
}));

vi.mock("../src/lib/discovery-publish.js", () => ({
  markFollowListDirty: vi.fn(async () => {}),
}));

async function buildReadApp() {
  const { sourcesRoutes } = await import("../src/routes/sources.js");
  const app = Fastify({ logger: false });
  await app.register(sourcesRoutes);
  await app.ready();
  return app;
}

beforeEach(() => {
  calls = [];
});

describe("GET /sources/:id — the read path", () => {
  it("refuses an email source, and never reads its items", async () => {
    const app = await buildReadApp();
    const res = await app.inject({ method: "GET", url: `/sources/${EMAIL_SOURCE}` });
    expect(res.statusCode).toBe(404);
    // The refusal has to land BEFORE the items query, or the newsletter has been
    // read out of the database whatever the status code says.
    expect(ran("FROM feed_items")).toBe(false);
    await app.close();
  });

  it("answers for an rss source — the guard is an allow-list, not a wall", async () => {
    const app = await buildReadApp();
    const res = await app.inject({ method: "GET", url: `/sources/${RSS_SOURCE}` });
    expect(res.statusCode).toBe(200);
    expect(ran("FROM feed_items")).toBe(true);
    await app.close();
  });

  it("gives a private source the SAME answer as one that does not exist", async () => {
    const app = await buildReadApp();
    const missing = "00000000-0000-4000-8000-00000000dead";
    const a = await app.inject({ method: "GET", url: `/sources/${EMAIL_SOURCE}` });
    const b = await app.inject({ method: "GET", url: `/sources/${missing}` });
    expect(a.statusCode).toBe(b.statusCode);
    expect(a.body).toBe(b.body);
    await app.close();
  });
});

describe("addSource by externalSourceId — the write path", () => {
  it("refuses an email source, and never writes a subscription", async () => {
    const { addSource } = await import("../src/routes/feeds/sources.js");
    await expect(
      addSource(FEED_ID, VIEWER, {
        sourceType: "external_source",
        externalSourceId: EMAIL_SOURCE,
      } as never),
    ).rejects.toThrow(/TARGET_NOT_FOUND/);
    // The finding is the SUBSCRIPTION, not the error: a guard that refused after
    // the upsert would have subscribed the caller to somebody else's newsletter
    // and then said no.
    expect(ran("INSERT INTO external_subscriptions")).toBe(false);
    expect(ran("INSERT INTO feed_sources")).toBe(false);
  });

  it("adds an rss source normally", async () => {
    const { addSource } = await import("../src/routes/feeds/sources.js");
    await addSource(FEED_ID, VIEWER, {
      sourceType: "external_source",
      externalSourceId: RSS_SOURCE,
    } as never);
    expect(ran("INSERT INTO external_subscriptions")).toBe(true);
    expect(ran("INSERT INTO feed_sources")).toBe(true);
  });
});
