import { describe, it, expect, vi, beforeEach } from "vitest";
import Fastify from "fastify";

// =============================================================================
// GET /author/:authorId/profile is READABLE LOGGED OUT (2026-09-02), and what an
// anonymous reader gets back is the SUBJECT, never a fabricated relationship.
//
// WHY IT EXISTS. The route was `requireAuth`, so a stranger opening one of the
// two standalone profile pages got a 401 that the web rendered as "Something
// went wrong loading this profile." — an outage sentence for a permissions
// state, on a share/SEO surface. Widening it was not the one-line change its
// two siblings (/posts, /replies) took, because this route genuinely reads the
// viewer: `followTarget` (do I follow them) and `linkedSources` (my own
// identity assertions ∪ global detections − my own tombstones).
//
// THE DISCRIMINATOR IS WHICH SQL RAN, not the status code. A route that defaults
// the viewer to "nobody follows anybody" also answers 200 with plausible JSON —
// the failure this pins is a fabricated `isFollowing: false`, which renders as a
// Follow button that cannot work, and a `linkedSources` set computed for a
// viewer who does not exist. So each anonymous case asserts BOTH that the field
// is absent AND that its query never issued.
//
// Mutation-proved: drop the `!viewerId` guard in resolveNativeAuthor's
// followTarget, or the `&& viewerId` on either branch in author.ts, and the
// anonymous cases go red.
// =============================================================================

const NATIVE = "00000000-0000-4000-8000-0000000000a1";
const EXTERNAL = "00000000-0000-4000-8000-0000000000b2";
const TIERC = "00000000-0000-4000-8000-0000000000c3";
const VIEWER = "00000000-0000-4000-8000-0000000000ff";

let calls: Array<{ sql: string; params: unknown[] }> = [];
// null ⇒ the request carries no session, which is what optionalAuth leaves
// behind for an anonymous reader.
let sessionSub: string | null = null;

function ran(fragment: string): boolean {
  return calls.some((c) => c.sql.includes(fragment));
}

// The mock answers FROM THE SQL IT IS HANDED (house rule): each branch is keyed
// on a fragment unique to one statement, so a query that stops being issued
// stops being answered rather than silently reusing a fixture.
function scriptedQuery(sql: string, params: unknown[] = []) {
  calls.push({ sql, params });

  if (sql.includes("FROM external_authors WHERE id = $1")) {
    const id = params[0];
    if (id === EXTERNAL) {
      return Promise.resolve({
        rows: [
          {
            id: EXTERNAL,
            protocol: "atproto",
            stable_handle: "did:plc:example",
            tier: "A",
            account_id: null,
            source_id: null,
            display_name: "Faine",
            handle: "faine.example",
            handle_uri: null,
            avatar: null,
            bio: "on the firehose",
            website: null,
            lightning_address: null,
            profile_fetched_at: new Date(),
          },
        ],
        rowCount: 1,
      });
    }
    if (id === TIERC) {
      return Promise.resolve({
        rows: [
          {
            id: TIERC,
            protocol: "rss",
            stable_handle: null,
            tier: "C",
            account_id: null,
            source_id: "00000000-0000-4000-8000-0000000000d4",
            display_name: "A Bylined Journalist",
            handle: null,
            handle_uri: null,
            avatar: null,
            bio: null,
            website: null,
            lightning_address: null,
            profile_fetched_at: null,
          },
        ],
        rowCount: 1,
      });
    }
    return Promise.resolve({ rows: [], rowCount: 0 });
  }

  // TWO READS OF `accounts` THAT DIFFER ONLY IN PROJECTION, and the row-shaped
  // one must be matched FIRST: `isNativeAccount` and `resolveNativeAuthor` both
  // end in `FROM accounts WHERE id = $1 AND status = 'active'`, so a mock keyed
  // on that shared tail answers the existence check's `{exists}` to the query
  // that wanted the account ROW — and the profile comes back with no name. That
  // is the house's own same-table/different-projection trap, and it fired here
  // while the file was being written.
  if (sql.includes("EXISTS(SELECT 1 FROM accounts")) {
    return Promise.resolve({
      rows: [{ exists: params[0] === NATIVE }],
      rowCount: 1,
    });
  }
  // resolveNativeAuthor's account row
  if (sql.includes("SELECT id, username, display_name, bio, avatar_blossom_url")) {
    return Promise.resolve({
      rows: [
        {
          id: NATIVE,
          username: "wrenfallow",
          display_name: "Wren Fallow",
          bio: "writes things",
          avatar_blossom_url: null,
        },
      ],
      rowCount: 1,
    });
  }
  if (sql.includes("COUNT(*) AS count FROM follows")) {
    return Promise.resolve({ rows: [{ count: "3" }], rowCount: 1 });
  }
  if (sql.includes("COUNT(*) AS count FROM articles")) {
    return Promise.resolve({ rows: [{ count: "7" }], rowCount: 1 });
  }
  // the viewer-derived follow check
  if (sql.includes("SELECT 1 FROM follows WHERE follower_id = $1")) {
    return Promise.resolve({ rows: [{ exists: true }], rowCount: 1 });
  }
  // tier-C's source lookup (public fields + the viewer's subscription row)
  if (sql.includes("FROM external_sources es") && sql.includes("es.description")) {
    return Promise.resolve({
      rows: [
        {
          source_id: "00000000-0000-4000-8000-0000000000d4",
          source_uri: "https://paper.invalid/feed.xml",
          display_name: "The Paper",
          description: "A paper",
          sub_id: null,
        },
      ],
      rowCount: 1,
    });
  }
  // A/B follow-state lookup
  if (sql.includes("SELECT es.id AS source_id, sub.id AS sub_id")) {
    return Promise.resolve({
      rows: [{ source_id: "00000000-0000-4000-8000-0000000000d5", sub_id: null }],
      rowCount: 1,
    });
  }
  // the representative item (activitypub host fallback only)
  if (sql.includes("FROM feed_items fi")) {
    return Promise.resolve({ rows: [], rowCount: 0 });
  }
  // identity links
  if (sql.includes("FROM external_identity_links l")) {
    return Promise.resolve({ rows: [], rowCount: 0 });
  }
  return Promise.resolve({ rows: [], rowCount: 0 });
}

vi.mock("@platform-pub/shared/db/client.js", () => ({
  pool: {
    query: (sql: string, params: unknown[] = []) => scriptedQuery(sql, params),
  },
  withTransaction: (
    cb: (client: { query: typeof scriptedQuery }) => Promise<unknown>,
  ) => cb({ query: scriptedQuery }),
}));

vi.mock("@platform-pub/shared/lib/logger.js", () => ({
  default: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

// optionalAuth's real contract: a session when there is one, and NOTHING on the
// request when there isn't — the state the route must now survive.
vi.mock("../src/middleware/auth.js", () => ({
  requireAuth: async (req: { session?: { sub: string } }) => {
    req.session = { sub: VIEWER };
  },
  optionalAuth: async (req: { session?: { sub: string } }) => {
    if (sessionSub) req.session = { sub: sessionSub };
  },
}));

// The live-origin fetchers must not reach the network from a unit test.
vi.mock("../src/lib/author-resolve.js", async (importOriginal) => {
  const actual = await importOriginal<Record<string, unknown>>();
  return {
    ...actual,
    fetchBlueskyProfile: async () => null,
    fetchMastodonProfile: async () => null,
    fetchNostrProfile: async () => null,
  };
});

const { authorRoutes } = await import("../src/routes/author.js");

async function build() {
  const app = Fastify();
  await app.register(authorRoutes);
  return app;
}

beforeEach(() => {
  calls = [];
  sessionSub = null;
});

describe("GET /author/:id/profile — anonymous readers", () => {
  it("answers 200 for a stranger (the 401 was rendered as an outage)", async () => {
    const app = await build();
    const res = await app.inject({ url: `/author/${NATIVE}/profile` });
    expect(res.statusCode).toBe(200);
    await app.close();
  });

  it("native: subject facts yes, followTarget no — and the follow query never runs", async () => {
    const app = await build();
    const res = await app.inject({ url: `/author/${NATIVE}/profile` });
    const body = res.json();
    // The subject is public and unchanged.
    expect(body.displayName).toBe("Wren Fallow");
    expect(body.handle).toBe("wrenfallow");
    expect(body.followerCount).toBe(3);
    expect(body.postCount).toBe(7);
    // The relationship is not stated, and not asked for.
    expect(body.followTarget).toBeUndefined();
    expect(ran("SELECT 1 FROM follows WHERE follower_id = $1")).toBe(false);
    await app.close();
  });

  it("external A/B: no followTarget, no linkedSources, neither query runs", async () => {
    const app = await build();
    const res = await app.inject({ url: `/author/${EXTERNAL}/profile` });
    const body = res.json();
    expect(body.displayName).toBe("Faine");
    expect(body.bio).toBe("on the firehose");
    expect(body.followTarget).toBeUndefined();
    expect(body.linkedSources).toBeUndefined();
    expect(ran("SELECT es.id AS source_id, sub.id AS sub_id")).toBe(false);
    expect(ran("FROM external_identity_links l")).toBe(false);
    await app.close();
  });

  it("tier C: the SOURCE is a public fact and survives; the follow target does not", async () => {
    const app = await build();
    const res = await app.inject({ url: `/author/${TIERC}/profile` });
    const body = res.json();
    expect(body.tier).toBe("C");
    expect(body.sourceName).toBe("The Paper");
    expect(body.sourceUrl).toBe("https://paper.invalid/feed.xml");
    expect(body.followTarget).toBeUndefined();
    await app.close();
  });
});

describe("GET /author/:id/profile — signed-in readers are unchanged", () => {
  it("native: the follow query runs and its answer reaches followTarget", async () => {
    sessionSub = VIEWER;
    const app = await build();
    const body = (await app.inject({ url: `/author/${NATIVE}/profile` })).json();
    expect(ran("SELECT 1 FROM follows WHERE follower_id = $1")).toBe(true);
    expect(body.followTarget).toEqual({
      type: "user",
      id: NATIVE,
      isFollowing: true,
    });
    await app.close();
  });

  it("external A/B: the two viewer-derived queries run, keyed on the viewer", async () => {
    sessionSub = VIEWER;
    const app = await build();
    const body = (await app.inject({ url: `/author/${EXTERNAL}/profile` })).json();
    expect(body.followTarget?.type).toBe("source");
    expect(body.followTarget?.isFollowing).toBe(false);
    const sub = calls.find((c) =>
      c.sql.includes("SELECT es.id AS source_id, sub.id AS sub_id"),
    );
    expect(sub?.params[0]).toBe(VIEWER);
    expect(ran("FROM external_identity_links l")).toBe(true);
    await app.close();
  });

  it("a viewer never gets a followTarget for their OWN account", async () => {
    sessionSub = NATIVE;
    const app = await build();
    const body = (await app.inject({ url: `/author/${NATIVE}/profile` })).json();
    expect(body.followTarget).toBeUndefined();
    await app.close();
  });
});
