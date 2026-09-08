import { describe, it, expect, vi, beforeAll, afterAll, beforeEach, afterEach } from "vitest";
import pg from "pg";

// =============================================================================
// TWO IMPLEMENTATIONS OF ONE RULE AGREE, GRANT FOR GRANT
// (ARTICLE-HEADED-CONVERSATIONS-ADR D5 item 8; CLAUDE.md "a WRITE into gated
// content carries the READ's guard").
//
// `checkArticleAccess` answers for ONE article in 1–3 sequential round-trips.
// `checkArticleAccessSet` answers for a PAGE of them in at most four, because
// the profile's Replies log pages at 50 and a call per row would be ~150
// sequential queries on an anonymous-reachable route. They encode the same four
// grants twice, in two shapes, and nothing made them agree.
//
// WHAT THE DIVERGENCE COSTS, AND WHY IT IS NOT NOTHING. The write path
// (`POST /replies`) uses the SINGLE checker, so a set checker that is too
// GENEROUS cannot let anybody past the gate — it draws an affordance the write
// path then 403s. That is a UI defect rather than a hole. Too STRICT is the
// other way round and equally silent: a reader who has paid is told the
// conversation is locked. Both are the kind of fault nobody reports, and both
// are what this file is for.
//
// THE COLLAPSE THAT PROMPTED IT. Both checkers' subscription arm is a BRANCH,
// not a union — a publication article is answered by a PUBLICATION subscription
// and never by a writer one. Collapsing the set checker's branch to a union
// (`subPubs.has(pubId) || subWriters.has(writerId)`) left all forty of the
// suites that touch these surfaces green, because both existing pins
// (`root-locked-key`, `author-replies-root-locked`) mock `pool.query` and
// neither seeds a publication article. That case is `writer sub does NOT unlock
// a publication article` below.
//
// WHY DB-BACKED. The two implementations differ in their SQL, not in their
// TypeScript: `ANY($2::uuid[])` against four separate reads, one subscription
// query with an OR against two branches, `current_period_end > now()` evaluated
// by Postgres. A mocked `pool.query` would be told what each returns, which is
// to say it would be told they agree.
//
// The real functions run against a real Postgres through a transaction that is
// always rolled back — the shared `pool` is redirected at this file's client, so
// the SQL under test is the shipping SQL.
//
// Run locally:
//   POSTGRES_PASSWORD=$(grep -E '^POSTGRES_PASSWORD=' ../.env | cut -d= -f2-) \
//   TEST_DATABASE_URL=postgresql://platformpub:$POSTGRES_PASSWORD@localhost:5432/platformpub \
//     npx vitest run tests/root-locked-parity.test.ts
// =============================================================================

const DB_URL = process.env.TEST_DATABASE_URL ?? process.env.DATABASE_URL;

let client: pg.Client;

vi.mock("@platform-pub/shared/db/client.js", () => ({
  pool: {
    query: (sql: string, params?: unknown[]) => client.query(sql, params),
  },
}));

const { checkArticleAccess, checkArticleAccessSet } = await import(
  "../src/services/article-access/access-check.js"
);

describe.skipIf(!DB_URL)("the two access checkers agree", () => {
  let seq = 0;
  const uniq = () => `parity-${Date.now().toString(36)}-${seq++}`;

  beforeAll(async () => {
    client = new pg.Client({ connectionString: DB_URL });
    await client.connect();
  });
  afterAll(async () => {
    await client.end();
  });
  beforeEach(async () => {
    await client.query("BEGIN");
  });
  afterEach(async () => {
    await client.query("ROLLBACK");
  });

  async function insertAccount(): Promise<string> {
    const { rows } = await client.query<{ id: string }>(
      `INSERT INTO accounts (nostr_pubkey) VALUES ($1) RETURNING id`,
      [uniq().padEnd(64, "0")],
    );
    return rows[0].id;
  }

  async function insertPublication(): Promise<string> {
    const s = uniq();
    const { rows } = await client.query<{ id: string }>(
      `INSERT INTO publications (slug, name, nostr_pubkey, nostr_privkey_enc)
       VALUES ($1, $2, $3, 'x') RETURNING id`,
      [s, `Pub ${s}`, s.padEnd(64, "0")],
    );
    return rows[0].id;
  }

  async function insertArticle(
    writerId: string,
    publicationId: string | null,
  ): Promise<string> {
    const s = uniq();
    const { rows } = await client.query<{ id: string }>(
      `INSERT INTO articles (writer_id, publication_id, nostr_event_id, nostr_d_tag,
                             title, slug, access_mode, price_pence)
       VALUES ($1, $2, $3, $4, $5, $6, 'paywalled', 300) RETURNING id`,
      [writerId, publicationId, s.padEnd(64, "0"), s, `Article ${s}`, s],
    );
    return rows[0].id;
  }

  /**
   * The whole assertion, in one place: run BOTH checkers over the same subjects
   * for the same viewer and require them to answer identically, article by
   * article. Returns the shared answer so a caller can also say what it should
   * have BEEN — parity alone would be satisfied by two checkers that are wrong
   * together, which is the failure mode the arrival statement's own parity test
   * ran into.
   */
  async function bothAgree(
    readerId: string | null,
    subjects: { id: string; writerId: string; publicationId: string | null }[],
  ): Promise<Set<string>> {
    const set = await checkArticleAccessSet(readerId, subjects);
    for (const s of subjects) {
      const one = readerId
        ? await checkArticleAccess(readerId, s.id, s.writerId, s.publicationId)
        : { hasAccess: false };
      expect(
        { id: s.id, access: one.hasAccess },
        `single vs set disagree on ${s.id}`,
      ).toEqual({ id: s.id, access: set.has(s.id) });
    }
    return set;
  }

  it("agrees across all four grants and a refusal, in one page", async () => {
    // One article per grant, plus one with no grant at all, resolved together —
    // because the set checker's whole shape is that it answers a MIXED page, and
    // a fixture of one grant at a time would never exercise the loop that sorts
    // them.
    const reader = await insertAccount();
    const writer = await insertAccount();
    const pub = await insertPublication();
    const subPub = await insertPublication();

    const own = await insertArticle(reader, null);
    const memberOf = await insertArticle(writer, pub);
    const unlocked = await insertArticle(writer, null);
    const subscribed = await insertArticle(writer, null);
    const subscribedPub = await insertArticle(writer, subPub);
    // A DIFFERENT writer, subscribed to by nobody: `none` has to be reachable by
    // no grant at all, and hanging it off `writer` would hand it the writer
    // subscription two lines below — a refusal case that is not one.
    const stranger = await insertAccount();
    const none = await insertArticle(stranger, null);

    await client.query(
      `INSERT INTO publication_members (publication_id, account_id, role)
       VALUES ($1, $2, 'contributor')`,
      [pub, reader],
    );
    await client.query(
      `INSERT INTO article_unlocks (reader_id, article_id, unlocked_via)
       VALUES ($1, $2, 'purchase')`,
      [reader, unlocked],
    );
    await client.query(
      `INSERT INTO subscriptions (reader_id, writer_id, price_pence, period_anchor_day)
       VALUES ($1, $2, 800, 1)`,
      [reader, writer],
    );
    await client.query(
      `INSERT INTO subscriptions (reader_id, publication_id, price_pence, period_anchor_day)
       VALUES ($1, $2, 800, 1)`,
      [reader, subPub],
    );

    const subjects = [
      { id: own, writerId: reader, publicationId: null },
      { id: memberOf, writerId: writer, publicationId: pub },
      { id: unlocked, writerId: writer, publicationId: null },
      { id: subscribed, writerId: writer, publicationId: null },
      { id: subscribedPub, writerId: writer, publicationId: subPub },
      { id: none, writerId: stranger, publicationId: null },
    ];

    const granted = await bothAgree(reader, subjects);
    // And the shared answer is the right one — parity is satisfied by two
    // checkers wrong together, so the figures are asserted as well.
    expect([...granted].sort()).toEqual(
      [own, memberOf, unlocked, subscribed, subscribedPub].sort(),
    );
    expect(granted.has(none)).toBe(false);
  });

  it("a WRITER subscription does not unlock a PUBLICATION article, in either", async () => {
    // The branch, not a union. This is the mutation the two existing pins go
    // green against, because both mock `pool.query` and neither seeds a
    // publication article. Note the subscription here is to the article's OWN
    // writer, so a union would find it and grant.
    const reader = await insertAccount();
    const writer = await insertAccount();
    const pub = await insertPublication();
    const article = await insertArticle(writer, pub);

    await client.query(
      `INSERT INTO subscriptions (reader_id, writer_id, price_pence, period_anchor_day)
       VALUES ($1, $2, 800, 1)`,
      [reader, writer],
    );

    const granted = await bothAgree(reader, [
      { id: article, writerId: writer, publicationId: pub },
    ]);
    expect(granted.size).toBe(0);
  });

  it("a REMOVED publication member is refused by both", async () => {
    const reader = await insertAccount();
    const writer = await insertAccount();
    const pub = await insertPublication();
    const article = await insertArticle(writer, pub);
    await client.query(
      `INSERT INTO publication_members (publication_id, account_id, role, removed_at)
       VALUES ($1, $2, 'contributor', now())`,
      [pub, reader],
    );
    const granted = await bothAgree(reader, [
      { id: article, writerId: writer, publicationId: pub },
    ]);
    expect(granted.size).toBe(0);
  });

  it("an EXPIRED subscription is refused by both, a CANCELLED-but-live one granted", async () => {
    // `status IN ('active','cancelled') AND current_period_end > now()` — the
    // date test is Postgres's, in both implementations, and cancelled-but-inside-
    // the-period is a paid-for grant rather than an ex-subscriber.
    const reader = await insertAccount();
    const writer = await insertAccount();
    const expiredWriter = await insertAccount();
    const live = await insertArticle(writer, null);
    const expired = await insertArticle(expiredWriter, null);

    await client.query(
      `INSERT INTO subscriptions (reader_id, writer_id, price_pence, status,
                                  current_period_end, period_anchor_day)
       VALUES ($1, $2, 800, 'cancelled', now() + interval '3 days', 1)`,
      [reader, writer],
    );
    await client.query(
      `INSERT INTO subscriptions (reader_id, writer_id, price_pence, status,
                                  current_period_end, period_anchor_day)
       VALUES ($1, $2, 800, 'active', now() - interval '1 day', 1)`,
      [reader, expiredWriter],
    );

    const granted = await bothAgree(reader, [
      { id: live, writerId: writer, publicationId: null },
      { id: expired, writerId: expiredWriter, publicationId: null },
    ]);
    expect(granted.has(live)).toBe(true);
    expect(granted.has(expired)).toBe(false);
  });

  it("an ANONYMOUS viewer is granted nothing, and no query is run for them", async () => {
    // The set checker's anonymous short-circuit is the whole of that path's
    // cost; `checkArticleAccess` has no anonymous form at all, which is why
    // `bothAgree` stands in the false answer for it rather than calling it.
    const writer = await insertAccount();
    const article = await insertArticle(writer, null);
    const granted = await bothAgree(null, [
      { id: article, writerId: writer, publicationId: null },
    ]);
    expect(granted.size).toBe(0);
  });
});
