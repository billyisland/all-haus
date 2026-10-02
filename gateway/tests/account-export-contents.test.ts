import { describe, it, expect, beforeAll, afterAll, vi } from "vitest";
import Fastify from "fastify";
import pg from "pg";

// =============================================================================
// GET /account/export — what is actually IN the bundle (L7.1; D8 §7).
//
// The route was an author-migration kit: a key, a list of article pointers, and
// a reading log. D8 §3 *Access* asks for something else — everything we hold
// about the person asking — and the gap was not a matter of degree: a member's
// comments, notes, private messages, ledger, moderation record and key-access
// log were all absent, and the route refused anyone who was not `active`.
//
// WHY DB-BACKED. Almost every claim here is a WHERE clause against a real row.
// A mocked `pool.query` dispatching on query text hands back whichever fixture
// it holds whether or not the query is right, and the two things most worth
// pinning are exactly the ones it cannot see: that `status = 'deactivated'`
// passes the account query AND the middleware, and that a comment written by
// THIS member and not another one comes back. The access check in particular is
// two predicates in two files that have to agree, and a mock would agree with
// itself.
//
// THE CONTROLS ARE THE POINT. A second account writes a comment of its own in
// every run, and the assertion is that it is NOT in the bundle — an export that
// returned every comment on the platform would pass a bare "contains a comment"
// test perfectly.
//
// Run locally:
//   POSTGRES_PASSWORD=$(grep -E '^POSTGRES_PASSWORD=' .env | cut -d= -f2-) \
//   DATABASE_URL=postgresql://platformpub:$POSTGRES_PASSWORD@localhost:5432/platformpub \
//     npx vitest run tests/account-export-contents.test.ts
// =============================================================================

const DB_URL = process.env.TEST_DATABASE_URL ?? process.env.DATABASE_URL;

process.env.KEY_SERVICE_URL = "http://key-service.test";
process.env.INTERNAL_SECRET = "test-internal";

/** Whose session the middleware sees. Set per test, before the inject. */
let sessionSub = "";

vi.mock("@platform-pub/shared/auth/session.js", () => ({
  verifySession: async () => (sessionSub ? { sub: sessionSub, iat: 1 } : null),
  refreshIfNeeded: async () => undefined,
  destroySession: () => undefined,
}));

// The two service hops, and ONLY those. Everything else — the middleware, the
// step-up claim, every query — runs for real against the database, because that
// is what the file is for.
vi.mock("../src/lib/key-custody-client.js", () => ({
  exportSecretKey: async () => ({ privkeyHex: "11".repeat(32), nsec: "nsec1test" }),
  signEvent: async () => ({ id: "x", sig: "y" }),
  nip44EncryptBatch: async () => ({ ciphertexts: [] }),
  nip44DecryptBatch: async (
    _signer: string,
    items: { senderPubkey: string; ciphertext: string }[],
  ) => ({
    // Stands in for NIP-44: the export's job is to ask for the right rows and
    // carry back what it is given, and that is what is asserted.
    results: items.map((i) => ({ plaintext: `opened:${i.ciphertext}` })),
  }),
}));

vi.mock("@platform-pub/shared/lib/email.js", () => ({
  sendKeyExportStepUpEmail: async () => undefined,
  sendKeyExportNoticeEmail: async () => undefined,
}));

import { exportRoutes, EXPORT_FEED_SOURCES_SQL } from "../src/routes/export.js";
import { requestStepUpToken } from "@platform-pub/shared/auth/magic-links.js";

const uniq = () => Math.random().toString(36).slice(2, 10);
const hex64 = () =>
  Array.from({ length: 64 }, () => "0123456789abcdef"[Math.floor(Math.random() * 16)]).join("");

describe.skipIf(!DB_URL)("account export — the contents", () => {
  let client: pg.Client;
  const made: string[] = [];

  let subject = "";
  let stranger = "";
  const subjectComment = `subject comment ${uniq()}`;
  const strangerComment = `stranger comment ${uniq()}`;
  const dmCiphertext = `ct-${uniq()}`;

  async function makeAccount(status: string): Promise<string> {
    const u = `l71_${uniq()}`;
    const { rows } = await client.query<{ id: string }>(
      `INSERT INTO accounts (username, email, display_name, status, nostr_pubkey,
                             nostr_privkey_enc)
       VALUES ($1, $2, 'L7 Tester', $3, $4, 'not-a-real-blob')
       RETURNING id`,
      [u, `${u}@example.com`, status, hex64()],
    );
    made.push(rows[0].id);
    return rows[0].id;
  }

  beforeAll(async () => {
    client = new pg.Client({ connectionString: DB_URL });
    await client.connect();

    // The member asking is DEACTIVATED — their own state, and the one the
    // route used to refuse.
    subject = await makeAccount("deactivated");
    stranger = await makeAccount("active");

    for (const [author, body] of [
      [subject, subjectComment],
      [stranger, strangerComment],
    ] as const) {
      await client.query(
        `INSERT INTO comments (author_id, nostr_event_id, target_event_id, target_kind, content)
         VALUES ($1, $2, $3, 1, $4)`,
        [author, hex64(), hex64(), body],
      );
    }

    // A private message each way, so `direction` has something to be wrong
    // about and the counterparty join has two shapes to get right.
    const { rows: convo } = await client.query<{ id: string }>(
      `INSERT INTO conversations (created_by) VALUES ($1) RETURNING id`,
      [subject],
    );
    await client.query(
      `INSERT INTO direct_messages (conversation_id, sender_id, recipient_id, content_enc)
       VALUES ($1, $2, $3, $4), ($1, $3, $2, $5)`,
      [convo[0].id, subject, stranger, `${dmCiphertext}-sent`, `${dmCiphertext}-recv`],
    );

    await client.query(
      `INSERT INTO key_access_log (account_id, purpose, actor_account_id)
       VALUES ($1, 'dm_decrypt', $1)`,
      [subject],
    );

    // An UNPUBLISHED article — `published_at IS NULL`, which is what unpublish
    // leaves behind. It is here because that one NULL used to take the entire
    // export down with a 500: the whole bundle, unobtainable, because the
    // member had once unpublished something.
    await client.query(
      `INSERT INTO articles (writer_id, nostr_event_id, nostr_d_tag, title, slug,
                             content_free, access_mode, published_at)
       VALUES ($1, $2, $3, 'Unpublished', $3, 'the free half', 'public', NULL)`,
      [subject, hex64(), `l71-${uniq()}`],
    );
  });

  afterAll(async () => {
    if (!client) return;
    // `key_access_log` is append-only in the SCHEMA (a BEFORE DELETE trigger
    // raises), which is the point of it — and it also means a fixture row
    // cannot be cleaned up any other way, while leaving it blocks the account
    // delete on the foreign key. Disabled for the teardown alone, and put back.
    await client.query(
      "ALTER TABLE key_access_log DISABLE TRIGGER key_access_log_append_only_trg",
    );
    for (const id of made) {
      await client.query("DELETE FROM key_access_log WHERE account_id = $1", [id]);
      await client.query("DELETE FROM direct_messages WHERE sender_id = $1 OR recipient_id = $1", [id]);
      await client.query("DELETE FROM conversations WHERE created_by = $1", [id]);
      await client.query("DELETE FROM comments WHERE author_id = $1", [id]);
      await client.query("DELETE FROM articles WHERE writer_id = $1", [id]);
      await client.query("DELETE FROM magic_links WHERE account_id = $1", [id]);
      await client.query("DELETE FROM account_key_exports WHERE account_id = $1", [id]);
    }
    for (const id of made) {
      await client.query("DELETE FROM accounts WHERE id = $1", [id]);
    }
    await client.query(
      "ALTER TABLE key_access_log ENABLE TRIGGER key_access_log_append_only_trg",
    );
    await client.end();
  });

  async function exportAs(
    accountId: string,
    keysBody: Record<string, unknown> = { keys: [] },
  ) {
    sessionSub = accountId;
    // key-service's export-keys leg. The route fetches it directly.
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => ({ ok: true, json: async () => keysBody })),
    );
    const { token } = await requestStepUpToken(accountId, "key_export");
    const app = Fastify();
    await app.register(exportRoutes, { prefix: "/api/v1" });
    const res = await app.inject({
      method: "GET",
      url: `/api/v1/account/export?token=${encodeURIComponent(token)}`,
    });
    await app.close();
    return res;
  }

  it("names a paywalled article whose key would not open, rather than failing the bundle (CA-F14(a))", async () => {
    const skipped = "3f0a2b1c-0000-4000-8000-00000000000b";
    const res = await exportAs(subject, { keys: [], skipped: [skipped] });
    expect(res.statusCode).toBe(200);
    expect(res.json().notice.contentKeysUnavailable).toEqual([skipped]);
  });

  it("lets a DEACTIVATED member export, and the archive holds what they wrote", async () => {
    const res = await exportAs(subject);
    expect(res.statusCode).toBe(200);
    const body = res.json();

    // The account state that used to refuse the request, carried in the bundle
    // rather than inferred from the fact that one arrived.
    expect(body.account.status).toBe("deactivated");
    expect(body.account.nostrPrivkeyNsec).toBe("nsec1test");

    // *Done when*: the archive contains a comment they wrote.
    const contents = body.comments.map((c: { content: string }) => c.content);
    expect(contents).toContain(subjectComment);

    // The control. Without the `author_id = $1` predicate this passes on the
    // line above and fails here, which is the only way round that says the
    // scoping is real.
    expect(contents).not.toContain(strangerComment);

    // Their messages, both directions, opened.
    const dirs = body.messages.items.map((m: { direction: string }) => m.direction).sort();
    expect(dirs).toEqual(["received", "sent"]);
    expect(body.messages.items[0].content).toMatch(/^opened:/);

    // L6.6's outstanding half: the member can see when their key was used.
    expect(body.keyAccessLog.length).toBeGreaterThan(0);
    expect(body.keyAccessLog[0].purpose).toBe("dm_decrypt");
    expect(body.keyAccessLog[0].askedByYou).toBe(true);

    // The body travels, both halves. An article with no `published_at` is
    // carried with a null rather than throwing the export away.
    const unpublished = body.articles.find((a: { title: string }) => a.title === "Unpublished");
    expect(unpublished.publishedAt).toBeNull();
    expect(unpublished.contentFree).toBe("the free half");

    // Nothing was reported unreadable, so an empty list means empty.
    expect(body.notice.incomplete).toEqual([]);
    // An older key-service image sends no `skipped`, which means none were.
    expect(body.notice.contentKeysUnavailable).toEqual([]);

    // And nothing was reported CUT either (§0ab item 5c). The fixture is far
    // under every cap, so this is the over-reporting control: a `truncated`
    // that named families on a three-row account would be worse than none.
    expect(body.notice.truncated).toEqual([]);
    expect(body.notice.capPerList).toBeGreaterThan(0);
    expect(body.messages.truncated).toBe(false);
    expect(body.reading.truncated).toBe(false);

    // §0z item 16: the families a member would recognise as theirs are
    // carried (empty lists here — the fixture holds none — but PRESENT, which
    // is the difference between "you have none" and "we did not look"), the
    // two acceptances ride the account, and what is withheld is named.
    for (const key of [
      "drafts", "media", "library", "keyExports", "presences", "notifications",
      "notificationPreferences", "votes", "following", "blocks", "mutes", "feeds", "formulas",
      "externalSubscriptions", "followImports", "outboundPosts", "identityLinks", "giftLinks",
    ]) {
      expect(Array.isArray(body[key]), `${key} is not a list`).toBe(true);
    }
    expect(body.subscriptions).toMatchObject({ asReader: [], subscribers: [], offers: [] });
    expect(body.money).toHaveProperty("settlements");
    expect(body.account.terms).toHaveProperty("reader");
    expect(body.notice.withheld.length).toBeGreaterThan(20);
    expect(body.notice.withheld.every((w: { table: string; why: string }) => w.table && w.why)).toBe(true);
  });

  // --- §0ab item 5: the three ways the bundle was not keeping its own rules ---

  it("a family that FAILS lands in `incomplete` and the rest of the bundle still ships", async () => {
    // ITEM 5(a). Rule (2) says each family fails alone — but `family()` was
    // declared BENEATH the first four queries, so a fault in the articles, the
    // receipt whitelist, the reading log or the reading positions reached the
    // global error handler and answered `internal_error` for the WHOLE bundle:
    // a member could not obtain their data because one SELECT went wrong.
    //
    // POISON ONE REAL QUERY, let every other run for real. A mock of the whole
    // pool would answer out of the same assumption the route was written from;
    // this fails exactly the statement named and nothing else, which is the
    // only arrangement that says where the boundary actually falls.
    const { pool } = await import("@platform-pub/shared/db/client.js");
    const real = pool.query.bind(pool);
    const spy = vi
      .spyOn(pool, "query")
      .mockImplementation((...args: unknown[]) => {
        const sql = typeof args[0] === "string" ? args[0] : (args[0] as { text?: string })?.text ?? "";
        if (sql.includes("FROM reading_log")) {
          return Promise.reject(new Error("poisoned: reading_log"));
        }
        return (real as (...a: unknown[]) => unknown)(...args) as never;
      });

    try {
      const res = await exportAs(subject);
      // Not a 500. That is the whole claim.
      expect(res.statusCode).toBe(200);
      const body = res.json();
      expect(body.notice.incomplete).toContain("readingLog");
      // And the family is an empty list rather than an absent key — "we could
      // not read this" must not arrive as the same JSON as "you have none".
      expect(body.reading.log).toEqual([]);
      // The CONTROL: everything else came back. A route that answered 200 with
      // an empty bundle would pass the two lines above perfectly.
      expect(body.comments.map((c: { content: string }) => c.content)).toContain(subjectComment);
      expect(body.articles.length).toBeGreaterThan(0);
      expect(body.notice.incomplete).not.toContain("comments");
    } finally {
      spy.mockRestore();
    }
  });

  it("a report about the member's PROFILE is in their own bundle", async () => {
    // ITEM 5(b). `subject_account_id` is stamped at RESOLUTION, so on its own
    // the family answered "nothing" for every report still open — and
    // `target_profile_id` is one of the five target kinds migration 223 added,
    // so a report filed about this member's profile was absent from their
    // bundle for its whole life and then appeared. The coverage test pins
    // tables by foreign key and cannot see a missing column.
    const { rows: rep } = await client.query<{ id: string }>(
      `INSERT INTO moderation_reports (reporter_id, category, target_profile_id)
       VALUES ($1, 'harassment', $2) RETURNING id`,
      [stranger, subject],
    );
    try {
      const body = (await exportAs(subject)).json();
      const ids = body.moderation.aboutYou.map((r: { id: string }) => r.id);
      expect(ids).toContain(rep[0].id);

      // The control, and it is the one that matters: this must be the family
      // about THEM, not a widened query returning the platform's reports. The
      // report the stranger filed is theirs to see in `moderationReportsFiled`,
      // and the subject is not the stranger.
      const filed = (await exportAs(stranger)).json();
      expect(filed.moderation.filedByYou.map((r: { id: string }) => r.id)).toContain(rep[0].id);
      expect(filed.moderation.aboutYou.map((r: { id: string }) => r.id)).not.toContain(rep[0].id);
    } finally {
      await client.query("DELETE FROM moderation_reports WHERE id = $1", [rep[0].id]);
    }
  });

  it("the feed-sources cap is taken INSIDE each feed, not across all of them", async () => {
    // ITEM 5(c). The route ran one `LIMIT` over every feed the member owns and
    // then partitioned the result with `.filter(s => s.feed_id === f.id)`, so a
    // member past the cap lost whole LATER feeds' sources — silently, because
    // every feed still rendered and the tail ones simply looked empty.
    //
    // RUN THE ROUTE'S OWN STATEMENT at a cap of 1: a hand-written copy of the
    // query in a test agrees with whatever it was written from, and what is
    // under test here is what Postgres does with the window function.
    const feeds: string[] = [];
    for (const name of ["cap A", "cap B"]) {
      const { rows } = await client.query<{ id: string }>(
        `INSERT INTO feeds (owner_id, name, sort_rank) VALUES ($1, $2, 1) RETURNING id`,
        [subject, name],
      );
      feeds.push(rows[0].id);
    }
    try {
      for (const f of feeds) {
        await client.query(
          `INSERT INTO feed_sources (feed_id, source_type, tag_name)
           VALUES ($1, 'tag', 'one'), ($1, 'tag', 'two')`,
          [f],
        );
      }
      const { rows } = await client.query<{ feed_id: string }>(
        EXPORT_FEED_SOURCES_SQL,
        [subject, 1],
      );
      const mine = rows.filter((r) => feeds.includes(r.feed_id));
      // One per feed — BOTH feeds. Under one flat `LIMIT 1` the second feed
      // would be absent entirely, which is the loss.
      expect(mine).toHaveLength(2);
      expect(new Set(mine.map((r) => r.feed_id))).toEqual(new Set(feeds));
    } finally {
      for (const f of feeds) {
        await client.query("DELETE FROM feed_sources WHERE feed_id = $1", [f]);
        await client.query("DELETE FROM feeds WHERE id = $1", [f]);
      }
    }
  });

  it("refuses a SUSPENDED member — the operator's state, not theirs", async () => {
    const suspended = await makeAccount("suspended");
    const res = await exportAs(suspended);
    // The split is the whole point of widening the middleware at all: if
    // `deactivated` had been let in by dropping the status check rather than by
    // naming it, this would be a 200.
    expect(res.statusCode).toBe(403);
  });
});
