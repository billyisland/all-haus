import {
  describe,
  it,
  expect,
  beforeAll,
  afterAll,
  beforeEach,
  afterEach,
  vi,
} from "vitest";
import pg from "pg";
import Fastify from "fastify";

// =============================================================================
// Feed sharing — live links, owned copies (FEED-SHARE-LIVE-LINKS-ADR).
//
// DB-backed because what must hold spans feed_formulas → feeds → feed_sources →
// external_subscriptions, and three of the guarantees are Postgres's own: the
// partial unique index that caps a feed at one live link, the
// snapshot-iff-seed CHECK that keeps a link from carrying a snapshot, and the
// generated/joined provenance a mocked pool.query would answer from its own
// fixture rather than from the allow-list and the SQL the code actually runs.
//
// THREE regimes, deliberately:
//
//   "freezeSource"      — pure, no database at all.
//   "projection"        — client-threaded, so its fixtures live in a
//                         transaction that is ALWAYS rolled back and the target
//                         DB is never mutated.
//   "links" / "redeem"  — CANNOT be, and this is a property of the design
//                         rather than a shortcut: redemption is deliberately
//                         not one transaction (§6), because N sources means N
//                         addSource calls each taking the per-owner advisory
//                         lock, and wrapping the loop would serialise the whole
//                         account. addSource therefore opens its own
//                         transactions on the shared pool and cannot see an
//                         uncommitted fixture. So those halves COMMIT and clean
//                         up after themselves in a finally, keyed on the
//                         fixture accounts (feeds, feed_sources,
//                         external_subscriptions and feed_formulas all CASCADE
//                         from accounts; external_sources is owner-less and is
//                         deleted explicitly).
//
// Skipped without a DB URL — CI supplies one (it boots Postgres and FAILS on a skip). Run locally
// (both vars: the fixtures use their own client, the code under test uses the
// shared pool, which reads DATABASE_URL):
//   DATABASE_URL=postgresql://platformpub:PASSWORD@localhost:5432/platformpub \
//   TEST_DATABASE_URL=$DATABASE_URL npx vitest run tests/formula-integration.test.ts
// =============================================================================

// The brake gates every route under test. Set before the module is imported so
// `formulasEnabled()` reads it — and so the suite proves the LIVE behaviour
// rather than the 404 the flag serves on prod today.
process.env.FEED_FORMULAS_ENABLED = "1";

// Who the routes think is calling. A mutable fixture id, so a redeemer and an
// author can be different accounts within one injected request sequence.
let caller = "unset";
vi.mock("../src/middleware/auth.js", () => ({
  requireAuth: async (req: { session?: { sub: string } }) => {
    req.session = { sub: caller };
  },
  optionalAuth: async (req: { session?: { sub: string } }) => {
    req.session = { sub: caller };
  },
}));

const {
  freezeSource,
  freezeFeedSources,
  freezeFeedIntoFormula,
  populateFeedFromFormula,
  populateFeedFromSources,
  registerFeedFormulaRoutes,
  formulaPublicRoutes,
} = await import("../src/routes/feeds/formulas.js");
const { loadFeed } = await import("../src/routes/feeds/shared.js");

const DB_URL = process.env.TEST_DATABASE_URL ?? process.env.DATABASE_URL;
const uniq = () => process.hrtime.bigint().toString(16);

// -----------------------------------------------------------------------------
// freezeSource is pure, so the branches the database cannot produce are driven
// directly. The dangling-target branches are the point: accounts.nostr_pubkey is
// NOT NULL and feed_sources.account_id is a real FK, so a NULL pubkey can only
// arise from a LEFT JOIN that missed — unreachable through the schema, and
// exactly the shape that would ship a dangling identity if it ever weren't.
// -----------------------------------------------------------------------------
describe("freezeSource — the portability rules, without a database", () => {
  const base = {
    weight: "4.0",
    sampling_mode: "chronological",
    exclude_replies: false,
    tag_name: null,
    account_pubkey: null,
    account_display_name: null,
    account_username: null,
    publication_pubkey: null,
    publication_name: null,
    external_protocol: null,
    external_source_uri: null,
    external_display_name: null,
    external_relay_urls: null,
  };

  it("excludes an account whose target has gone", () => {
    expect(
      freezeSource({ ...base, source_type: "account", account_pubkey: null }),
    ).toBeNull();
  });

  it("excludes a publication whose target has gone", () => {
    expect(freezeSource({ ...base, source_type: "publication" })).toBeNull();
  });

  it("carries a nostr relay hint in the hint slot, never in the identity", () => {
    const f = freezeSource({
      ...base,
      source_type: "external_source",
      external_protocol: "nostr_external",
      external_source_uri: "abc123def456",
      external_relay_urls: ["wss://relay.example", "wss://other.example"],
    });
    // tag_value stays the BARE pubkey — the relay-free-identity invariant bans
    // hints from identity fields, because two relays would otherwise mint two
    // different identities for one person.
    expect(f?.tagValue).toBe("abc123def456");
    expect(f?.tagKind).toBe("p");
    expect(f?.tagHint).toBe("wss://relay.example");
  });

  it("gives an rss source no hint even if the row somehow carries relays", () => {
    const f = freezeSource({
      ...base,
      source_type: "external_source",
      external_protocol: "rss",
      external_source_uri: "https://example.com/feed.xml",
      external_relay_urls: ["wss://relay.example"],
    });
    expect(f?.tagKind).toBe("r");
    expect(f?.tagHint).toBeNull();
  });

  it("fails closed on a protocol nobody has thought about yet", () => {
    // The allow-list is the whole of D5-as-amended: external_protocol already
    // carries farcaster/matrix/telegram with no composer path, and a future
    // protocol must not leak into a share link by simply existing. Live links
    // widen what a link EXPOSES over time (L1's accepted cost) and change
    // nothing about what may travel.
    for (const p of ["email", "farcaster", "matrix", "telegram", "whatever"]) {
      expect(
        freezeSource({
          ...base,
          source_type: "external_source",
          external_protocol: p,
          external_source_uri: "x",
        }),
      ).toBeNull();
    }
  });
});

// -----------------------------------------------------------------------------
// The replay's suspended-protocol skip (§0u.2)
//
// No database, and that is the point: the guard runs BEFORE resolution, so a
// suspended row never reaches addSource at all. Mutate the guard away and this
// falls through to the resolve-and-add path, which files the failure under the
// generic `error` arm — which is exactly the bug, a seed silently delivering
// less than it names at every signup with no reason anyone can read.
// -----------------------------------------------------------------------------
describe("the replay's suspended-protocol skip, without a database", () => {
  const publicationRow = {
    tagKind: "p" as const,
    tagValue: "a".repeat(64),
    tagHint: null,
    sourceType: "publication" as const,
    protocol: null,
    displayName: "The Quarterly",
    avatarUrl: null,
    weight: "4.0",
    samplingMode: "chronological",
    excludeReplies: false,
  };

  it("counts a publication row as `suspended` while publications are dark", async () => {
    // PUBLICATIONS_ENABLED is unset in the suite, which is the shipping state
    // (suspended 2026-08-31) and the state every signup is currently running
    // in.
    expect(process.env.PUBLICATIONS_ENABLED).not.toBe("1");
    const out = await populateFeedFromSources(
      "00000000-0000-0000-0000-000000000000",
      "00000000-0000-0000-0000-000000000000",
      [publicationRow],
    );
    expect(out.added).toBe(0);
    expect(out.failed).toEqual([
      { position: 0, label: "The Quarterly", reason: "suspended" },
    ]);
  });
});

describe.skipIf(!DB_URL)("projection — what a feed would hand over", () => {
  let client: pg.Client;
  let owner: string;
  let feedId: string;
  let memberPubkey: string;

  beforeAll(async () => {
    client = new pg.Client({ connectionString: DB_URL });
    await client.connect();
  });
  afterAll(async () => {
    await client.end();
  });

  async function account(slug: string): Promise<{ id: string; pubkey: string }> {
    const pubkey = `fixture-${slug}-${uniq()}`;
    const { rows } = await client.query<{ id: string }>(
      `INSERT INTO accounts (nostr_pubkey, nostr_privkey_enc, display_name)
       VALUES ($1, 'fixture-enc', $2) RETURNING id`,
      [pubkey, `Fixture ${slug}`],
    );
    return { id: rows[0].id, pubkey };
  }

  async function externalSource(
    protocol: string,
    uri: string,
    extra: { ingest_address?: string } = {},
  ): Promise<string> {
    const { rows } = await client.query<{ id: string }>(
      `INSERT INTO external_sources (protocol, source_uri, display_name, is_active, ingest_address)
       VALUES ($1::external_protocol, $2, $3, TRUE, $4) RETURNING id`,
      [protocol, uri, `${protocol} source`, extra.ingest_address ?? null],
    );
    return rows[0].id;
  }

  const project = (cap = 200) =>
    freezeFeedSources(client as never, feedId, cap);

  const cutSeed = (overrides: Record<string, unknown> = {}) =>
    freezeFeedIntoFormula(client as never, {
      feedId,
      ownerId: owner,
      name: "Long Reads",
      description: "A test composition",
      appearance: { scheme: "autumn" },
      maxSources: 200,
      ...overrides,
    });

  beforeEach(async () => {
    await client.query("BEGIN");
    const o = await account("freeze-owner");
    owner = o.id;
    const m = await account("freeze-member");
    memberPubkey = m.pubkey;

    const { rows: feed } = await client.query<{ id: string }>(
      `INSERT INTO feeds (owner_id, name, sort_rank, appearance)
       VALUES ($1, 'Long Reads', 1, '{"scheme":"autumn"}'::jsonb) RETURNING id`,
      [owner],
    );
    feedId = feed[0].id;

    // Sources inserted with EXPLICIT ascending created_at so composer order is
    // a real assertion and not an accident of insertion speed.
    const rss = await externalSource("rss", `https://fixture.example/${uniq()}.xml`);
    const email = await externalSource("email", `inbox-${uniq()}`, {
      ingest_address: `secret-alias-${uniq()}@in.all.haus`,
    });
    await client.query(
      `INSERT INTO feed_sources (feed_id, source_type, account_id, created_at, weight, sampling_mode, exclude_replies)
       VALUES ($1, 'account', $2, now() - INTERVAL '4 min', 2.0, 'scored', TRUE)`,
      [feedId, m.id],
    );
    await client.query(
      `INSERT INTO feed_sources (feed_id, source_type, external_source_id, created_at)
       VALUES ($1, 'external_source', $2, now() - INTERVAL '3 min')`,
      [feedId, rss],
    );
    await client.query(
      `INSERT INTO feed_sources (feed_id, source_type, tag_name, created_at)
       VALUES ($1, 'tag', 'longform', now() - INTERVAL '2 min')`,
      [feedId],
    );
    // The one that must NOT travel: ingest_address is a per-subscriber secret.
    await client.query(
      `INSERT INTO feed_sources (feed_id, source_type, external_source_id, created_at)
       VALUES ($1, 'external_source', $2, now() - INTERVAL '1 min')`,
      [feedId, email],
    );
  });
  afterEach(async () => {
    await client.query("ROLLBACK");
  });

  it("carries the three portable sources and excludes the email one", async () => {
    const p = await project();
    expect(p.sources).toHaveLength(3);
    // Counted, not silently dropped — an author who cannot see this believes
    // they shared their whole feed (D5).
    expect(p.excludedCount).toBe(1);
    expect(p.refusal).toBeNull();
  });

  it("never lets the email source's secret alias into the projection", async () => {
    const p = await project();
    for (const s of p.sources) {
      expect(s.protocol).not.toBe("email");
      expect(s.tagValue).not.toContain("in.all.haus");
      expect(s.displayName ?? "").not.toContain("in.all.haus");
    }
  });

  it("names each source by portable identity, in composer order", async () => {
    const p = await project();
    expect(p.sources.map((s) => [s.tagKind, s.sourceType])).toEqual([
      ["p", "account"],
      ["r", "external_source"],
      ["t", "tag"],
    ]);
    // The account travels as a PUBKEY, never as its local row id (D4).
    expect(p.sources[0].tagValue).toBe(memberPubkey);
    expect(p.sources[0].tagValue).not.toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/,
    );
    expect(p.sources[2].tagValue).toBe("longform");
  });

  it("carries the tuning, because the composition is the feed", async () => {
    const p = await project();
    expect(Number(p.sources[0].weight)).toBe(2);
    expect(p.sources[0].samplingMode).toBe("scored");
    expect(p.sources[0].excludeReplies).toBe(true);
  });

  it("reports the refusals rather than throwing them", async () => {
    const big = await project(2);
    expect(big.refusal).toBe("too_large");
    expect(big.sources).toHaveLength(3);

    await client.query(
      `DELETE FROM feed_sources WHERE feed_id = $1 AND source_type <> 'external_source'`,
      [feedId],
    );
    await client.query(
      `DELETE FROM feed_sources fs USING external_sources xs
        WHERE fs.external_source_id = xs.id AND fs.feed_id = $1 AND xs.protocol = 'rss'`,
      [feedId],
    );
    const empty = await project();
    expect(empty.refusal).toBe("empty");
    expect(empty.sources).toHaveLength(0);
    // The count that explains the refusal arrives WITH it.
    expect(empty.excludedCount).toBe(1);
  });

  it("writes nothing — it is a read, and looking must share nothing", async () => {
    await project();
    const { rows } = await client.query(
      `SELECT 1 FROM feed_formulas WHERE source_feed_id = $1`,
      [feedId],
    );
    expect(rows).toHaveLength(0);
  });

  // ---------------------------------------------------------------------------
  // The seed cut is the ONE remaining writer of a frozen composition (L3, L5).
  // ---------------------------------------------------------------------------
  describe("the seed cut", () => {
    it("freezes the same rows the projection names, and lands kind = 'seed'", async () => {
      const p = await project();
      const r = await cutSeed();
      if (!r.ok) throw new Error("cut refused");
      expect(r.sourceCount).toBe(p.sources.length);
      expect(r.excludedCount).toBe(p.excludedCount);

      const { rows } = await client.query<{
        kind: string;
        name: string | null;
        source_count: number;
        excluded_count: number;
      }>(
        `SELECT kind, name, source_count, excluded_count FROM feed_formulas WHERE id = $1`,
        [r.formulaId],
      );
      expect(rows[0].kind).toBe("seed");
      // A seed carries its snapshot columns; feed_formulas_snapshot_iff_seed
      // is what makes that a fact rather than a habit.
      expect(rows[0].name).toBe("Long Reads");
      expect(rows[0].source_count).toBe(3);
      expect(rows[0].excluded_count).toBe(1);

      const { rows: frozen } = await client.query<{
        position: number;
        tag_kind: string;
        tag_value: string;
        source_type: string;
      }>(
        `SELECT position, tag_kind, tag_value, source_type
           FROM feed_formula_sources WHERE formula_id = $1 ORDER BY position`,
        [r.formulaId],
      );
      expect(frozen.map((x) => [x.tag_kind, x.source_type])).toEqual(
        p.sources.map((s) => [s.tagKind, s.sourceType]),
      );
      expect(frozen.map((x) => x.tag_value)).toEqual(
        p.sources.map((s) => s.tagValue),
      );
    });

    it("refuses an empty feed and writes nothing when it does", async () => {
      // The seed cut is the one path that still must refuse: a sourceless seed
      // feed auto-serves the explore placeholder, so every new member would be
      // shown the platform stream. A LINK's mint deliberately does not refuse
      // (L2) — the refusal there belongs at redeem, where somebody is present
      // to be told.
      await client.query(`DELETE FROM feed_sources WHERE feed_id = $1`, [feedId]);
      const r = await cutSeed();
      expect(r.ok).toBe(false);
      if (r.ok) return;
      expect(r.reason).toBe("empty");
      const { rows } = await client.query(
        `SELECT 1 FROM feed_formulas WHERE source_feed_id = $1`,
        [feedId],
      );
      expect(rows).toHaveLength(0);
    });

    it("refuses a feed over the cap, and writes nothing when it does", async () => {
      const r = await cutSeed({ maxSources: 2 });
      expect(r.ok).toBe(false);
      if (r.ok) return;
      expect(r.reason).toBe("too_large");
      expect(r.sourceCount).toBe(3);
      const { rows } = await client.query(
        `SELECT 1 FROM feed_formulas WHERE source_feed_id = $1`,
        [feedId],
      );
      expect(rows).toHaveLength(0);
    });
  });
});

// =============================================================================
// The link — minting, resolving live, and freezing at redeem.
// =============================================================================
describe.skipIf(!DB_URL)("share links", () => {
  let client: pg.Client;
  let app: Awaited<ReturnType<typeof build>>;
  const cleanupAccounts: string[] = [];
  const cleanupSources: string[] = [];

  async function build() {
    const a = Fastify({ logger: false });
    await a.register(
      async (scope) => {
        registerFeedFormulaRoutes(scope);
      },
      { prefix: "/workspace" },
    );
    await a.register(formulaPublicRoutes);
    return a;
  }

  beforeAll(async () => {
    client = new pg.Client({ connectionString: DB_URL });
    await client.connect();
    app = await build();
  });
  afterAll(async () => {
    // Committed fixtures, so cleanup is not optional.
    if (cleanupAccounts.length)
      await client.query(`DELETE FROM accounts WHERE id = ANY($1::uuid[])`, [
        cleanupAccounts,
      ]);
    if (cleanupSources.length)
      await client.query(`DELETE FROM external_sources WHERE id = ANY($1::uuid[])`, [
        cleanupSources,
      ]);
    await app?.close();
    await client.end();
  });

  async function account(slug: string): Promise<{ id: string; pubkey: string }> {
    const pubkey = `fixture-${slug}-${uniq()}`;
    const { rows } = await client.query<{ id: string }>(
      `INSERT INTO accounts (nostr_pubkey, nostr_privkey_enc, display_name)
       VALUES ($1, 'fixture-enc', $2) RETURNING id`,
      [pubkey, `Fixture ${slug}`],
    );
    cleanupAccounts.push(rows[0].id);
    return { id: rows[0].id, pubkey };
  }

  async function feed(ownerId: string, name = "Long Reads"): Promise<string> {
    const { rows } = await client.query<{ id: string }>(
      `INSERT INTO feeds (owner_id, name, sort_rank, appearance)
       VALUES ($1, $2, 1, '{"scheme":"winter"}'::jsonb) RETURNING id`,
      [ownerId, name],
    );
    return rows[0].id;
  }

  async function follow(feedId: string, accountId: string) {
    await client.query(
      `INSERT INTO feed_sources (feed_id, source_type, account_id) VALUES ($1, 'account', $2)`,
      [feedId, accountId],
    );
  }

  /** A source addSource's known-healthy short-circuit will not probe. */
  async function healthyRssSource(): Promise<{ id: string; uri: string }> {
    const uri = `https://fixture.example/${uniq()}.xml`;
    const { rows } = await client.query<{ id: string }>(
      `INSERT INTO external_sources
         (protocol, source_uri, display_name, is_active, error_count, last_fetched_at)
       VALUES ('rss', $1, 'Fixture RSS', TRUE, 0, now()) RETURNING id`,
      [uri],
    );
    cleanupSources.push(rows[0].id);
    return { id: rows[0].id, uri };
  }

  const mint = (feedId: string) =>
    app.inject({ method: "POST", url: `/workspace/feeds/${feedId}/formula` });
  const statusOf = (feedId: string) =>
    app.inject({ method: "GET", url: `/workspace/feeds/${feedId}/formula` });

  async function liveLinks(feedId: string): Promise<number> {
    const { rows } = await client.query<{ count: string }>(
      `SELECT COUNT(*) AS count FROM feed_formulas
        WHERE source_feed_id = $1 AND kind = 'link' AND revoked_at IS NULL`,
      [feedId],
    );
    return Number(rows[0].count);
  }

  // ---------------------------------------------------------------------------
  // Mint — one link per feed, idempotent, never refusing
  // ---------------------------------------------------------------------------

  it("mints once and hands the same link back forever", async () => {
    // The idempotence is what lets the composer be ONE button: it never has to
    // know whether it is creating or fetching. A 409 on the second press would
    // put that distinction back on the surface.
    const author = await account("mint-author");
    caller = author.id;
    const f = await feed(author.id);
    await follow(f, (await account("mint-followee")).id);

    const first = await mint(f);
    const second = await mint(f);
    expect(first.statusCode).toBe(200);
    expect(second.statusCode).toBe(200);
    expect(second.json().link.token).toBe(first.json().link.token);
    expect(second.json().link.id).toBe(first.json().link.id);
    expect(await liveLinks(f)).toBe(1);
  });

  it("mints one link when two presses race", async () => {
    // Genuinely concurrent: each request awaits a real round trip, so both
    // pre-checks complete before either INSERT and the second meets the partial
    // unique index. The 23505 must resolve to "here is the link that exists",
    // not to a 500.
    const author = await account("race-author");
    caller = author.id;
    const f = await feed(author.id);
    await follow(f, (await account("race-followee")).id);

    const [a, b] = await Promise.all([mint(f), mint(f)]);
    expect(a.statusCode).toBe(200);
    expect(b.statusCode).toBe(200);
    expect(a.json().link.token).toBe(b.json().link.token);
    expect(await liveLinks(f)).toBe(1);
  });

  it("mints a link for an empty feed, and redeem is what refuses", async () => {
    // L2 + L8 together, and the whole reason mint stopped refusing: a link to a
    // feed nobody can add YET is a valid link, and it starts working the moment
    // the author adds a source. The old freeze had to refuse because it was
    // minting a snapshot of nothing.
    const author = await account("empty-author");
    caller = author.id;
    const f = await feed(author.id);

    const minted = await mint(f);
    expect(minted.statusCode).toBe(200);
    const token = minted.json().link.token as string;
    expect(minted.json().link.refusal).toBe("empty");

    const redeemer = await account("empty-redeemer");
    caller = redeemer.id;
    const refused = await app.inject({
      method: "POST",
      url: `/formulas/${token}/redeem`,
    });
    expect(refused.statusCode).toBe(410);
    expect(refused.json().error).toBe("formula_empty");
    // Refused BEFORE the feed is minted, or every attempt leaves a stray empty
    // feed behind (the §12 departure-1 property, one object over).
    const { rows: none } = await client.query(
      `SELECT 1 FROM feeds WHERE owner_id = $1`,
      [redeemer.id],
    );
    expect(none).toHaveLength(0);

    await follow(f, (await account("empty-followee")).id);
    const ok = await app.inject({
      method: "POST",
      url: `/formulas/${token}/redeem`,
    });
    expect(ok.statusCode).toBe(201);
    expect(ok.json().added).toBe(1);
  });

  it("reports the live projection on the status route, link or no link", async () => {
    const author = await account("status-author");
    caller = author.id;
    const f = await feed(author.id);
    await follow(f, (await account("status-followee")).id);
    const email = await client.query<{ id: string }>(
      `INSERT INTO external_sources (protocol, source_uri, display_name, is_active, ingest_address)
       VALUES ('email', $1, 'A newsletter', TRUE, $2) RETURNING id`,
      [`inbox-${uniq()}`, `secret-${uniq()}@in.all.haus`],
    );
    cleanupSources.push(email.rows[0].id);
    await client.query(
      `INSERT INTO feed_sources (feed_id, source_type, external_source_id)
       VALUES ($1, 'external_source', $2)`,
      [f, email.rows[0].id],
    );

    const before = await statusOf(f);
    expect(before.statusCode).toBe(200);
    expect(before.json().link).toBeNull();
    // The count is the point of the status line, and it is true NOW rather
    // than at some moment in the past (D5 as moved by L8).
    expect(before.json().excludedCount).toBe(1);
    expect(before.json().sourceCount).toBe(1);

    await mint(f);
    const after = await statusOf(f);
    expect(after.json().link).not.toBeNull();
    expect(after.json().excludedCount).toBe(1);
  });

  it("refuses to mint or read a link for somebody else's feed", async () => {
    const author = await account("owner-author");
    const stranger = await account("owner-stranger");
    const f = await feed(author.id);
    caller = stranger.id;
    expect((await mint(f)).statusCode).toBe(404);
    expect((await statusOf(f)).statusCode).toBe(404);
  });

  // ---------------------------------------------------------------------------
  // Live resolution — the whole point
  // ---------------------------------------------------------------------------

  it("hands a recipient the feed as it stands, not as it stood", async () => {
    const author = await account("live-author");
    caller = author.id;
    const f = await feed(author.id);
    const first = await account("live-followee-1");
    await follow(f, first.id);
    const token = (await mint(f)).json().link.token as string;

    // The edit that a frozen snapshot would have missed.
    const second = await account("live-followee-2");
    await follow(f, second.id);

    const redeemer = await account("live-redeemer");
    caller = redeemer.id;
    const page = await app.inject({ method: "GET", url: `/formulas/${token}` });
    expect(page.json().formula.sourceCount).toBe(2);

    const res = await app.inject({
      method: "POST",
      url: `/formulas/${token}/redeem`,
    });
    expect(res.statusCode).toBe(201);
    const { rows } = await client.query<{ account_id: string }>(
      `SELECT account_id FROM feed_sources WHERE feed_id = $1 ORDER BY created_at`,
      [res.json().feedId],
    );
    expect(rows.map((r) => r.account_id).sort()).toEqual(
      [first.id, second.id].sort(),
    );
  });

  it("refuses a feed edited to empty, and mints nothing when it does", async () => {
    const author = await account("emptied-author");
    caller = author.id;
    const f = await feed(author.id);
    const followee = await account("emptied-followee");
    await follow(f, followee.id);
    const token = (await mint(f)).json().link.token as string;

    await client.query(`DELETE FROM feed_sources WHERE feed_id = $1`, [f]);

    const redeemer = await account("emptied-redeemer");
    caller = redeemer.id;
    const res = await app.inject({
      method: "POST",
      url: `/formulas/${token}/redeem`,
    });
    expect(res.statusCode).toBe(410);
    expect(res.json().error).toBe("formula_empty");
    const { rows } = await client.query(`SELECT 1 FROM feeds WHERE owner_id = $1`, [
      redeemer.id,
    ]);
    expect(rows).toHaveLength(0);
  });

  it("keeps the link row and everyone's provenance when the feed is deleted", async () => {
    // L7 — a dangling link is a STATE, not a deleted row. Deleting the row is
    // what would erase the provenance of every feed already redeemed from it:
    // feeds.from_formula_id is ON DELETE SET NULL, so the author's later act
    // would reach into somebody else's workspace.
    const author = await account("gone-author");
    caller = author.id;
    const f = await feed(author.id, "Doomed Feed");
    await follow(f, (await account("gone-followee")).id);
    const link = (await mint(f)).json().link;

    const redeemer = await account("gone-redeemer");
    caller = redeemer.id;
    const redeemed = await app.inject({
      method: "POST",
      url: `/formulas/${link.token}/redeem`,
    });
    expect(redeemed.statusCode).toBe(201);

    await client.query(`DELETE FROM feeds WHERE id = $1`, [f]);

    const { rows: survives } = await client.query<{ source_feed_id: string | null }>(
      `SELECT source_feed_id FROM feed_formulas WHERE id = $1`,
      [link.id],
    );
    expect(survives).toHaveLength(1);
    expect(survives[0].source_feed_id).toBeNull();

    // The recipient's feed is untouched, and still says where it came from.
    const theirs = await loadFeed(redeemed.json().feedId, redeemer.id);
    expect(theirs?.origin_formula_name).toBe("Doomed Feed");
    expect(theirs?.from_starter).toBe(false);

    const page = await app.inject({
      method: "GET",
      url: `/formulas/${link.token}`,
    });
    expect(page.json().formula.gone).toBe(true);
    expect(page.json().formula.sources).toEqual([]);

    caller = (await account("gone-latecomer")).id;
    const late = await app.inject({
      method: "POST",
      url: `/formulas/${link.token}/redeem`,
    });
    expect(late.statusCode).toBe(410);
    expect(late.json().error).toBe("source_feed_gone");
  });

  it("stamps the origin label, so renaming the feed does not rewrite it", async () => {
    // L6 — attribution is a fact about the RECIPIENT's feed at the moment they
    // added it. Joined live, the author renaming their feed would silently
    // rewrite the "from …" line in somebody else's workspace.
    const author = await account("rename-author");
    caller = author.id;
    const f = await feed(author.id, "Original Name");
    await follow(f, (await account("rename-followee")).id);
    const token = (await mint(f)).json().link.token as string;

    const redeemer = await account("rename-redeemer");
    caller = redeemer.id;
    const res = await app.inject({
      method: "POST",
      url: `/formulas/${token}/redeem`,
    });

    await client.query(`UPDATE feeds SET name = 'Renamed Later' WHERE id = $1`, [f]);

    const theirs = await loadFeed(res.json().feedId, redeemer.id);
    expect(theirs?.origin_formula_name).toBe("Original Name");
    // The author's NAME stays a live join — a person's display name changing
    // should follow.
    expect(theirs?.origin_author_name).toContain("rename-author");
    // And the public page, which is the LIVE object, does move.
    const page = await app.inject({ method: "GET", url: `/formulas/${token}` });
    expect(page.json().formula.name).toBe("Renamed Later");
  });

  it("arrives styled, owned, and reading as origin rather than from_starter", async () => {
    const author = await account("owned-author");
    caller = author.id;
    const f = await feed(author.id, "Winter Reads");
    await follow(f, (await account("owned-followee")).id);
    const token = (await mint(f)).json().link.token as string;

    const redeemer = await account("owned-redeemer");
    caller = redeemer.id;
    const res = await app.inject({
      method: "POST",
      url: `/formulas/${token}/redeem`,
    });
    const { rows } = await client.query<{
      appearance: Record<string, unknown>;
      from_formula_id: string;
      origin_label: string;
    }>(
      `SELECT appearance, from_formula_id, origin_label FROM feeds WHERE id = $1`,
      [res.json().feedId],
    );
    expect(rows[0].appearance).toEqual({ scheme: "winter" });
    expect(rows[0].origin_label).toBe("Winter Reads");

    const theirs = await loadFeed(res.json().feedId, redeemer.id);
    // Redeeming somebody's link is the OTHER provenance question from being
    // seeded by the platform, and they stay disjoint (L9).
    expect(theirs?.from_starter).toBe(false);
    expect(theirs?.origin_formula_name).toBe("Winter Reads");
  });

  it("gives the redeemer their own subscription for every external source", async () => {
    // THE property. A redeemed feed holding feed_sources rows with no
    // external_subscriptions row is the GC-orphan bug the clone path shipped
    // for years: the source survives only while somebody else keeps it, and
    // vanishes out of this member's feed the day they let go.
    const author = await account("sub-author");
    caller = author.id;
    const f = await feed(author.id);
    const rss = await healthyRssSource();
    await client.query(
      `INSERT INTO feed_sources (feed_id, source_type, external_source_id)
       VALUES ($1, 'external_source', $2)`,
      [f, rss.id],
    );
    await client.query(
      `INSERT INTO external_subscriptions (subscriber_id, source_id) VALUES ($1, $2)
       ON CONFLICT DO NOTHING`,
      [author.id, rss.id],
    );
    const token = (await mint(f)).json().link.token as string;

    const redeemer = await account("sub-redeemer");
    caller = redeemer.id;
    const res = await app.inject({
      method: "POST",
      url: `/formulas/${token}/redeem`,
    });
    expect(res.json().added).toBe(1);
    expect(res.json().failed).toEqual([]);

    const { rows } = await client.query(
      `SELECT 1 FROM external_subscriptions WHERE subscriber_id = $1 AND source_id = $2`,
      [redeemer.id, rss.id],
    );
    expect(rows).toHaveLength(1);
  });

  it("carries the tuning across, because the composition is the feed", async () => {
    const author = await account("tune-author");
    caller = author.id;
    const f = await feed(author.id);
    const followee = await account("tune-followee");
    await client.query(
      `INSERT INTO feed_sources (feed_id, source_type, account_id, weight, sampling_mode, exclude_replies)
       VALUES ($1, 'account', $2, 0.5, 'scored', TRUE)`,
      [f, followee.id],
    );
    const token = (await mint(f)).json().link.token as string;

    const redeemer = await account("tune-redeemer");
    caller = redeemer.id;
    const res = await app.inject({
      method: "POST",
      url: `/formulas/${token}/redeem`,
    });
    const { rows } = await client.query<{
      account_id: string;
      weight: string;
      sampling_mode: string;
      exclude_replies: boolean;
    }>(
      `SELECT account_id, weight, sampling_mode, exclude_replies
         FROM feed_sources WHERE feed_id = $1`,
      [res.json().feedId],
    );
    expect(rows[0].account_id).toBe(followee.id);
    expect(Number(rows[0].weight)).toBe(0.5);
    expect(rows[0].sampling_mode).toBe("scored");
    expect(rows[0].exclude_replies).toBe(true);
  });

  it("never hands a departed member's identity to a recipient", async () => {
    // A LIVE link projects at redeem, which is what closes the window a frozen
    // one leaves open: a member who deletes their account between the link
    // being sent and being opened cannot be named in what the recipient
    // receives. `feed_sources.account_id` is ON DELETE CASCADE, so the row is
    // gone by the time the projection runs and the feed simply reads smaller —
    // which is why freezeSource's null-pubkey branch is unreachable through the
    // schema and is driven directly in the pure tests above.
    const author = await account("gonesource-author");
    caller = author.id;
    const f = await feed(author.id);
    const keeper = await account("gonesource-keeper");
    const leaver = await account("gonesource-leaver");
    await follow(f, keeper.id);
    await follow(f, leaver.id);
    const token = (await mint(f)).json().link.token as string;
    expect((await mint(f)).json().link.sourceCount).toBe(2);

    await client.query(`DELETE FROM accounts WHERE id = $1`, [leaver.id]);
    cleanupAccounts.splice(cleanupAccounts.indexOf(leaver.id), 1);

    const page = await app.inject({ method: "GET", url: `/formulas/${token}` });
    expect(page.json().formula.sourceCount).toBe(1);
    expect(
      page.json().formula.sources.map((s: { label: string }) => s.label),
    ).not.toContain(`Fixture gonesource-leaver`);

    const redeemer = await account("gonesource-redeemer");
    caller = redeemer.id;
    const res = await app.inject({
      method: "POST",
      url: `/formulas/${token}/redeem`,
    });
    expect(res.statusCode).toBe(201);
    expect(res.json().added).toBe(1);
    expect(res.json().failed).toEqual([]);
    const { rows } = await client.query<{ account_id: string }>(
      `SELECT account_id FROM feed_sources WHERE feed_id = $1`,
      [res.json().feedId],
    );
    expect(rows.map((r) => r.account_id)).toEqual([keeper.id]);
  });

  it("reports what a SEED's frozen rows can no longer resolve", async () => {
    // A partial redeem is a real outcome, not an error state (§6), and it is
    // the FROZEN path where it genuinely arises: a seed cut months ago can name
    // a member who has since deleted their account. The member keeps everything
    // that worked and is TOLD what did not, rather than silently receiving a
    // shorter version of the composition.
    const operator = await account("frozen-operator");
    const alive = await account("frozen-alive");
    const { rows } = await client.query<{ id: string }>(
      `INSERT INTO feed_formulas
         (author_id, kind, name, appearance, token, source_count, excluded_count)
       VALUES ($1, 'seed', 'Frozen Seed', '{}'::jsonb, $2, 2, 0) RETURNING id`,
      [operator.id, `tok-${uniq()}`],
    );
    await client.query(
      `INSERT INTO feed_formula_sources (formula_id, position, tag_kind, tag_value, source_type)
       VALUES ($1, 0, 'p', $2, 'account'), ($1, 1, 'p', 'pubkey-of-nobody-at-all', 'account')`,
      [rows[0].id, alive.pubkey],
    );

    const member = await account("frozen-member");
    const target = await feed(member.id, "Seeded");
    const result = await populateFeedFromFormula(target, member.id, rows[0].id);
    expect(result.added).toBe(1);
    expect(result.failed).toEqual([
      { position: 1, label: "pubkey-of-nobody-at-all", reason: "unresolvable" },
    ]);
  });

  it("is idempotent about a composition naming the same target twice", async () => {
    // Unreachable through a LIVE link — feed_sources_account_uniq means a feed
    // cannot name the same account twice, so the projection never can either.
    // It IS reachable through a seed's frozen rows, which are ordinary rows
    // with no such constraint, so the core's DUPLICATE branch is driven there.
    // The second add must be a silent no-op and NOT a reported failure: the
    // source is on the feed either way, and calling it a failure would tell the
    // member something is wrong when nothing is.
    const operator = await account("dupe-operator");
    const followee = await account("dupe-followee");
    const { rows: seed } = await client.query<{ id: string }>(
      `INSERT INTO feed_formulas
         (author_id, kind, name, appearance, token, source_count, excluded_count)
       VALUES ($1, 'seed', 'Doubled', '{}'::jsonb, $2, 2, 0) RETURNING id`,
      [operator.id, `tok-${uniq()}`],
    );
    await client.query(
      `INSERT INTO feed_formula_sources (formula_id, position, tag_kind, tag_value, source_type)
       VALUES ($1, 0, 'p', $2, 'account'), ($1, 1, 'p', $2, 'account')`,
      [seed[0].id, followee.pubkey],
    );

    const member = await account("dupe-member");
    const target = await feed(member.id, "Seeded");
    const result = await populateFeedFromFormula(target, member.id, seed[0].id);
    expect(result.failed).toEqual([]);
    const { rows } = await client.query<{ count: string }>(
      `SELECT COUNT(*) AS count FROM feed_sources WHERE feed_id = $1`,
      [target],
    );
    expect(rows[0].count).toBe("1");
  });

  // ---------------------------------------------------------------------------
  // Stop
  // ---------------------------------------------------------------------------

  it("stops sharing without touching anybody's workspace, and can share again", async () => {
    // D10 — revoking stops FUTURE copies and nothing else. And because the
    // partial index only counts LIVE links, Stop-then-Create is how a link is
    // rotated; there is deliberately no Replace control.
    const author = await account("stop-author");
    caller = author.id;
    const f = await feed(author.id);
    await follow(f, (await account("stop-followee")).id);
    const first = (await mint(f)).json().link;

    const redeemer = await account("stop-redeemer");
    caller = redeemer.id;
    const kept = await app.inject({
      method: "POST",
      url: `/formulas/${first.token}/redeem`,
    });
    expect(kept.statusCode).toBe(201);

    caller = author.id;
    const stopped = await app.inject({
      method: "DELETE",
      url: `/formulas/${first.id}`,
    });
    expect(stopped.statusCode).toBe(204);

    // The recipient keeps theirs.
    const theirs = await loadFeed(kept.json().feedId, redeemer.id);
    expect(theirs).not.toBeNull();

    caller = (await account("stop-latecomer")).id;
    const late = await app.inject({
      method: "POST",
      url: `/formulas/${first.token}/redeem`,
    });
    expect(late.statusCode).toBe(410);
    expect(late.json().error).toBe("formula_revoked");
    const { rows: noFeed } = await client.query(
      `SELECT 1 FROM feeds WHERE owner_id = $1`,
      [caller],
    );
    expect(noFeed).toHaveLength(0);

    caller = author.id;
    const second = await mint(f);
    expect(second.statusCode).toBe(200);
    expect(second.json().link.token).not.toBe(first.token);
    expect(await liveLinks(f)).toBe(1);
  });

  it("stops projecting a withdrawn feed, including its later edits", async () => {
    // §0u.1. The link's own JOIN is live by design, so before the fix every
    // field it projected tracked the feed AFTER the author pressed Stop: an
    // author who withdrew a link and then renamed the feed to something
    // private had the new name served to anyone still holding the token. The
    // rename below is the whole test — a revoked link that merely omitted the
    // name it had at revoke time would pass a weaker version of this.
    const author = await account("withdrawn-author");
    caller = author.id;
    const f = await feed(author.id);
    await follow(f, (await account("withdrawn-followee")).id);
    const link = (await mint(f)).json().link;
    expect(link.name).not.toBeNull();

    await app.inject({ method: "DELETE", url: `/formulas/${link.id}` });
    await client.query(
      `UPDATE feeds SET name = $2, appearance = '{"scheme":"winter"}'::jsonb
        WHERE id = $1`,
      [f, "Things I am not telling you about"],
    );

    caller = (await account("withdrawn-stranger")).id;
    const page = await app.inject({
      method: "GET",
      url: `/formulas/${link.token}`,
    });
    expect(page.statusCode).toBe(200);
    const body = page.json().formula;
    // The withdrawn sentence and the identity that carries it, nothing else.
    expect(body.revoked).toBe(true);
    // The AUTHOR survives the strip: it is the link's own author, not the
    // feed's composition, and the withdrawn sentence names them.
    expect(body.author.displayName).toBeTruthy();
    expect(body.name).toBeNull();
    expect(body.appearance).toEqual({});
    expect(body.sources).toEqual([]);
    expect(body.sourceCount).toBe(0);
    // Derived from the ROW, not from the redacted name: this feed still
    // exists, and a revoked link must not claim its feed was deleted.
    expect(body.gone).toBe(false);
    expect(JSON.stringify(body)).not.toContain("not telling you");
  });

  it("carries the source cap on the link itself, not only on the status read", async () => {
    // §0u.6. The composer's `too_large` caveat interpolates this, and the
    // branch that runs when the initial status GET blipped had nothing to
    // interpolate — so it fabricated a 0 and told the author to trim the feed
    // to zero sources.
    const author = await account("cap-author");
    caller = author.id;
    const f = await feed(author.id);
    await follow(f, (await account("cap-followee")).id);
    const minted = (await mint(f)).json().link;
    const status = await app.inject({
      method: "GET",
      url: `/workspace/feeds/${f}/formula`,
    });
    expect(minted.maxSources).toBeGreaterThan(0);
    expect(minted.maxSources).toBe(status.json().maxSources);
  });

  // ---------------------------------------------------------------------------
  // A seed has no address (L10)
  // ---------------------------------------------------------------------------

  it("answers a seed's token exactly as it answers an unknown one", async () => {
    // A seed's token was only ever the freeze's by-product. Serving it would
    // project the operator's LIVE feed from a URL whose whole point is a frozen
    // composition — one object, two compositions. The filter is in the SQL, so
    // this is true by construction rather than by a branch somebody could drop.
    const operator = await account("seedaddr-operator");
    const seedToken = `tok-${uniq()}`;
    const { rows } = await client.query<{ id: string }>(
      `INSERT INTO feed_formulas
         (author_id, kind, name, appearance, token, source_count, excluded_count)
       VALUES ($1, 'seed', 'House Starter', '{}'::jsonb, $2, 1, 0) RETURNING id`,
      [operator.id, seedToken],
    );
    await client.query(
      `INSERT INTO feed_formula_sources (formula_id, position, tag_kind, tag_value, source_type)
       VALUES ($1, 0, 'p', $2, 'account')`,
      [rows[0].id, (await account("seedaddr-followee")).pubkey],
    );

    caller = (await account("seedaddr-visitor")).id;
    const page = await app.inject({ method: "GET", url: `/formulas/${seedToken}` });
    const unknown = await app.inject({
      method: "GET",
      url: `/formulas/definitely-not-a-token-${uniq()}`,
    });
    expect(page.statusCode).toBe(404);
    expect(page.json()).toEqual(unknown.json());

    const redeem = await app.inject({
      method: "POST",
      url: `/formulas/${seedToken}/redeem`,
    });
    expect(redeem.statusCode).toBe(404);
    const { rows: none } = await client.query(
      `SELECT 1 FROM feeds WHERE owner_id = $1`,
      [caller],
    );
    expect(none).toHaveLength(0);
  });

  it("permits a seed and a live link on the same feed", async () => {
    // The partial index excludes seeds deliberately (L2/L10): an operator may
    // both seed from a feed and share it, and the two rows are different
    // objects with different lifecycles.
    const operator = await account("both-operator");
    caller = operator.id;
    const f = await feed(operator.id);
    await follow(f, (await account("both-followee")).id);
    expect((await mint(f)).statusCode).toBe(200);

    await client.query(
      `INSERT INTO feed_formulas
         (author_id, source_feed_id, kind, name, appearance, token, source_count, excluded_count)
       VALUES ($1, $2, 'seed', 'House Starter', '{}'::jsonb, $3, 1, 0)`,
      [operator.id, f, `tok-${uniq()}`],
    );
    expect(await liveLinks(f)).toBe(1);
  });

  // ---------------------------------------------------------------------------
  // The schema's own guarantees
  // ---------------------------------------------------------------------------

  it("refuses a link carrying a snapshot, and a seed missing one", async () => {
    // feed_formulas_snapshot_iff_seed is what makes `kind` a discriminator
    // rather than a convention — and it witnesses every snapshot column, not
    // `name` alone, so a seed with a null count and a link carrying an
    // appearance are both illegal rows.
    const author = await account("check-author");
    await expect(
      client.query(
        `INSERT INTO feed_formulas (author_id, token, name, source_count, excluded_count, appearance)
         VALUES ($1, $2, 'Snapshot on a link', 1, 0, '{}'::jsonb)`,
        [author.id, `tok-${uniq()}`],
      ),
    ).rejects.toThrow(/snapshot_iff_seed/);

    await expect(
      client.query(
        `INSERT INTO feed_formulas (author_id, token, kind, name, appearance, excluded_count)
         VALUES ($1, $2, 'seed', 'Seed with no count', '{}'::jsonb, 0)`,
        [author.id, `tok-${uniq()}`],
      ),
    ).rejects.toThrow(/snapshot_iff_seed/);

    await expect(
      client.query(
        `INSERT INTO feed_formulas (author_id, token, description)
         VALUES ($1, $2, 'a link has no description')`,
        [author.id, `tok-${uniq()}`],
      ),
    ).rejects.toThrow(/snapshot_iff_seed/);
  });

  it("refuses to designate a link as the default seed", async () => {
    // feed_formulas_seed_kind. Under L5 designation always cuts a fresh seed,
    // so this is unreachable through the routes — and it is the schema, not the
    // route, that makes it unreachable: a designated row can never be revoked,
    // so seizing a member's link into that slot would remove their ability to
    // withdraw it forever.
    const author = await account("seedkind-author");
    const { rows } = await client.query<{ id: string }>(
      `INSERT INTO feed_formulas (author_id, token) VALUES ($1, $2) RETURNING id`,
      [author.id, `tok-${uniq()}`],
    );
    await expect(
      client.query(`UPDATE feed_formulas SET is_default_seed = TRUE WHERE id = $1`, [
        rows[0].id,
      ]),
    ).rejects.toThrow(/seed_kind/);
  });
});
