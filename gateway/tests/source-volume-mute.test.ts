import { describe, it, expect, beforeAll, afterAll, vi } from "vitest";
import pg from "pg";
import Fastify from "fastify";

// =============================================================================
// Muting a source does not spend its volume level.
//
// THE BUG THIS PINS. Step 0 is mute, and it is the one step with no throughput
// of its own: `VOLUME_THROUGHPUT[0]` is a 1.0 placeholder that exists only to
// satisfy the `throughput > 0` CHECK — and 1.0 is also "everything". Both write
// paths stored it. So a reader who turned a source down to 20% and then muted
// it had the 20% overwritten with 100%, and met that on unmute.
//
// It was invisible, and would have stayed invisible, because no surface
// currently unmutes without naming a level — while the PATCH API has always
// accepted a bare `{ muted: false }`. Two things in the tree already said this
// was not the intent: `shared.ts` called index 0 INERT, and FeedComposer's
// optimistic row deliberately keeps `source.throughput` when muting and then
// had it overwritten by the authoritative response.
//
// DB-BACKED, AND IT HAS TO BE. What is under test is which COLUMNS a write
// touches. A mocked pool would answer "what is stored now?" out of the mock,
// which is to say out of the same assumption the bug was made of; only a real
// row can say that the fraction survived. Both routes are driven, because both
// carried the fault in different spellings — a SET list in PATCH, an
// ON CONFLICT DO UPDATE in PUT.
//
// MUTATION LOG (each reverted, suite re-run, then restored):
//   1. sources.ts: `step !== undefined && step > 0` → `step !== undefined`
//      ⇒ "a PATCH mute keeps the level" fails (1.0, expected 0.2).  DETECTED
//   2. author-volume.ts: drop the CASE, back to `EXCLUDED.throughput`
//      ⇒ "a PUT mute keeps the level" fails (1.0, expected 0.4).     DETECTED
//   3. sources.ts: delete the `sets.length === 0` guard
//      ⇒ "a bare step 0 is refused" fails with a 500 and a Postgres
//        syntax error at `SET  WHERE`, which is what that guard is for.
//                                                                    DETECTED
//   4. author-volume.ts: `sampling` back to `.default("top")` AND
//      `sampling_mode = EXCLUDED.sampling_mode` — the defect as it shipped
//      ⇒ "a PUT mute does not spend the MODE either" fails ('scored',
//        expected 'random'), and nothing else in the suite moves.  DETECTED
//
// Run locally (both vars — fixtures use their own client, the routes use the
// shared pool, which reads DATABASE_URL):
//   DATABASE_URL=postgresql://platformpub:password@localhost:5432/platformpub \
//   TEST_DATABASE_URL=$DATABASE_URL npx vitest run tests/source-volume-mute.test.ts
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

const { registerFeedSourcesRoutes } = await import("../src/routes/feeds/sources.js");
const { registerAuthorVolumeRoutes } = await import(
  "../src/routes/feeds/author-volume.js"
);

describe.skipIf(!DB_URL)("mute keeps the level", () => {
  let client: pg.Client;
  let app: Awaited<ReturnType<typeof build>>;
  const cleanupAccounts: string[] = [];
  // Deleting the owner cascades the feed and its feed_sources, but an
  // external_sources row is nobody's child — left behind it is litter in a dev
  // database that outlives the run (the GC would reach it eventually; that is
  // not a reason to leave it).
  const cleanupSources: string[] = [];
  let feedId = "unset";

  async function build() {
    const a = Fastify({ logger: false });
    registerFeedSourcesRoutes(a);
    registerAuthorVolumeRoutes(a);
    await a.ready();
    return a;
  }

  beforeAll(async () => {
    client = new pg.Client({ connectionString: DB_URL });
    await client.connect();
    const { rows } = await client.query<{ id: string }>(
      `INSERT INTO accounts (nostr_pubkey, nostr_privkey_enc, display_name)
       VALUES ($1, 'fixture-enc', 'Fixture mute') RETURNING id`,
      // 64-hex, because the author-volume routes refuse any other shape and the
      // self-source case below names the owner by pubkey.
      [uniq().padEnd(64, "0").slice(0, 64)],
    );
    ownerId = rows[0].id;
    cleanupAccounts.push(rows[0].id);
    const f = await client.query<{ id: string }>(
      `INSERT INTO feeds (owner_id, name, sort_rank) VALUES ($1, 'mute', 1)
       RETURNING id`,
      [ownerId],
    );
    feedId = f.rows[0].id;
    app = await build();
  });

  afterAll(async () => {
    if (cleanupAccounts.length)
      await client.query(`DELETE FROM accounts WHERE id = ANY($1::uuid[])`, [
        cleanupAccounts,
      ]);
    if (cleanupSources.length)
      await client.query(
        `DELETE FROM external_sources WHERE id = ANY($1::uuid[])`,
        [cleanupSources],
      );
    await app?.close();
    await client.end();
  });

  /** The row itself. The responses echo the request, so reading one back would
   *  not distinguish "stored" from "accepted" — which is the whole bug. */
  async function stored(
    sourceId: string,
  ): Promise<{ throughput: number; muted: boolean }> {
    const { rows } = await client.query<{
      throughput: string;
      muted_at: Date | null;
    }>(`SELECT throughput, muted_at FROM feed_sources WHERE id = $1`, [
      sourceId,
    ]);
    return { throughput: Number(rows[0].throughput), muted: !!rows[0].muted_at };
  }

  /** The stored sampling mode alone — the column one over from the level, and
   *  the one the PUT was spending on every mute. */
  async function storedMode(sourceId: string): Promise<string> {
    const { rows } = await client.query<{ sampling_mode: string }>(
      `SELECT sampling_mode FROM feed_sources WHERE id = $1`,
      [sourceId],
    );
    return rows[0].sampling_mode;
  }

  async function externalSourceRow(): Promise<string> {
    const ext = await client.query<{ id: string }>(
      `INSERT INTO external_sources (protocol, source_uri)
       VALUES ('atproto', $1) RETURNING id`,
      [`https://mute.test/${uniq()}`],
    );
    cleanupSources.push(ext.rows[0].id);
    const fs = await client.query<{ id: string }>(
      `INSERT INTO feed_sources (feed_id, source_type, external_source_id)
       VALUES ($1, 'external_source', $2) RETURNING id`,
      [feedId, ext.rows[0].id],
    );
    return fs.rows[0].id;
  }

  it("a PATCH mute keeps the level, and unmute returns to it", async () => {
    const sourceId = await externalSourceRow();

    const down = await app.inject({
      method: "PATCH",
      url: `/feeds/${feedId}/sources/${sourceId}`,
      payload: { step: 1 },
    });
    expect(down.statusCode).toBe(200);
    expect((await stored(sourceId)).throughput).toBe(0.2);

    // Exactly what SourceVolume and FeedComposer send for step 0.
    const mute = await app.inject({
      method: "PATCH",
      url: `/feeds/${feedId}/sources/${sourceId}`,
      payload: { step: 0, muted: true },
    });
    expect(mute.statusCode).toBe(200);
    expect(await stored(sourceId)).toEqual({ throughput: 0.2, muted: true });

    // The bare unmute the API has always accepted and nothing currently sends —
    // the call that would have surfaced the loss.
    const back = await app.inject({
      method: "PATCH",
      url: `/feeds/${feedId}/sources/${sourceId}`,
      payload: { muted: false },
    });
    expect(back.statusCode).toBe(200);
    expect(await stored(sourceId)).toEqual({ throughput: 0.2, muted: false });
  });

  it("a bare step 0 is refused rather than writing an empty SET list", async () => {
    const sourceId = await externalSourceRow();
    const res = await app.inject({
      method: "PATCH",
      url: `/feeds/${feedId}/sources/${sourceId}`,
      payload: { step: 0 },
    });
    expect(res.statusCode).toBe(400);
    // Untouched: a refused write is a write that did not happen.
    expect(await stored(sourceId)).toEqual({ throughput: 1, muted: false });
  });

  it("a PUT mute on the author-volume route keeps the level too", async () => {
    const { rows } = await client.query<{ id: string; nostr_pubkey: string }>(
      `INSERT INTO accounts (nostr_pubkey, nostr_privkey_enc, display_name)
       VALUES ($1, 'fixture-enc', 'Fixture author') RETURNING id, nostr_pubkey`,
      [uniq().padEnd(64, "0").slice(0, 64)],
    );
    cleanupAccounts.push(rows[0].id);
    const pubkey = rows[0].nostr_pubkey;
    const url = `/feeds/${feedId}/author-volume/${pubkey}`;

    const down = await app.inject({
      method: "PUT",
      url,
      payload: { step: 2, sampling: "top" },
    });
    expect(down.statusCode).toBe(200);

    const { rows: before } = await client.query<{ id: string }>(
      `SELECT id FROM feed_sources
        WHERE feed_id = $1 AND source_type = 'account' AND account_id = $2`,
      [feedId, rows[0].id],
    );
    const sourceId = before[0].id;
    expect((await stored(sourceId)).throughput).toBe(0.4);

    const mute = await app.inject({
      method: "PUT",
      url,
      payload: { step: 0, sampling: "top" },
    });
    expect(mute.statusCode).toBe(200);
    expect(await stored(sourceId)).toEqual({ throughput: 0.4, muted: true });
  });

  it("a first PUT at step 0 takes the schema default, having no level to keep", async () => {
    const { rows } = await client.query<{ id: string; nostr_pubkey: string }>(
      `INSERT INTO accounts (nostr_pubkey, nostr_privkey_enc, display_name)
       VALUES ($1, 'fixture-enc', 'Fixture fresh') RETURNING id, nostr_pubkey`,
      [uniq().padEnd(64, "0").slice(0, 64)],
    );
    cleanupAccounts.push(rows[0].id);

    const res = await app.inject({
      method: "PUT",
      url: `/feeds/${feedId}/author-volume/${rows[0].nostr_pubkey}`,
      payload: { step: 0, sampling: "top" },
    });
    expect(res.statusCode).toBe(200);
    const { rows: fs } = await client.query<{ id: string }>(
      `SELECT id FROM feed_sources
        WHERE feed_id = $1 AND source_type = 'account' AND account_id = $2`,
      [feedId, rows[0].id],
    );
    expect(await stored(fs[0].id)).toEqual({ throughput: 1, muted: true });
  });

  it("a PUT mute does not spend the MODE either, and neither does a call that never named one", async () => {
    // The level's twin one column over. `sampling` used to carry a zod
    // `.default("top")`, so a bare `{ step: 0 }` — which this API accepts, and
    // which is mute — arrived at the UPDATE as `sampling_mode = 'scored'` and
    // silently flipped a source the reader had set to RANDOM. Mute says
    // nothing about ranking; nor does a request that omits the field.
    const { rows } = await client.query<{ id: string; nostr_pubkey: string }>(
      `INSERT INTO accounts (nostr_pubkey, nostr_privkey_enc, display_name)
       VALUES ($1, 'fixture-enc', 'Fixture mode') RETURNING id, nostr_pubkey`,
      [uniq().padEnd(64, "0").slice(0, 64)],
    );
    cleanupAccounts.push(rows[0].id);
    const url = `/feeds/${feedId}/author-volume/${rows[0].nostr_pubkey}`;

    const random = await app.inject({
      method: "PUT",
      url,
      payload: { step: 2, sampling: "random" },
    });
    expect(random.statusCode).toBe(200);
    const { rows: fs } = await client.query<{ id: string }>(
      `SELECT id FROM feed_sources
        WHERE feed_id = $1 AND source_type = 'account' AND account_id = $2`,
      [feedId, rows[0].id],
    );
    const sourceId = fs[0].id;
    expect(await storedMode(sourceId)).toBe("random");

    // Mute, saying nothing about sampling: the shape the API accepts.
    const mute = await app.inject({ method: "PUT", url, payload: { step: 0 } });
    expect(mute.statusCode).toBe(200);
    expect(await storedMode(sourceId)).toBe("random");
    expect(await stored(sourceId)).toEqual({ throughput: 0.4, muted: true });
    // And the response states the ROW, not the request.
    expect(mute.json().sampling).toBe("random");

    // A level change with no sampling term is not a mode change either.
    const up = await app.inject({ method: "PUT", url, payload: { step: 4 } });
    expect(up.statusCode).toBe(200);
    expect(await storedMode(sourceId)).toBe("random");
    expect((await stored(sourceId)).throughput).toBe(0.8);

    // Asked for explicitly, it still moves — the guard is not a lock.
    const top = await app.inject({
      method: "PUT",
      url,
      payload: { step: 4, sampling: "top" },
    });
    expect(top.statusCode).toBe(200);
    expect(await storedMode(sourceId)).toBe("scored");
  });

  it("a first PUT with no sampling takes the fresh-row default", async () => {
    // Absent means "unchanged" only where there is something to keep. A row
    // being created has nothing, and the schema's own default is what it gets.
    const { rows } = await client.query<{ id: string; nostr_pubkey: string }>(
      `INSERT INTO accounts (nostr_pubkey, nostr_privkey_enc, display_name)
       VALUES ($1, 'fixture-enc', 'Fixture default') RETURNING id, nostr_pubkey`,
      [uniq().padEnd(64, "0").slice(0, 64)],
    );
    cleanupAccounts.push(rows[0].id);
    const res = await app.inject({
      method: "PUT",
      url: `/feeds/${feedId}/author-volume/${rows[0].nostr_pubkey}`,
      payload: { step: 3 },
    });
    expect(res.statusCode).toBe(200);
    const { rows: fs } = await client.query<{ id: string }>(
      `SELECT id FROM feed_sources
        WHERE feed_id = $1 AND source_type = 'account' AND account_id = $2`,
      [feedId, rows[0].id],
    );
    expect(await storedMode(fs[0].id)).toBe("scored");
  });

  // ===========================================================================
  // THE ROW IS MADE THROUGH `addSource`, WITHOUT THE FOLLOW FLAG, AND UNMADE
  // BY NOBODY HERE (CA-A9, 2026-09-29). The PUT INSERTed a bare account row
  // when none existed — no self refusal, no block check, no lock — and the
  // DELETE removed the row past `removeSource`'s last-feed teardown, leaving
  // a follow with no source. Each case reads the ROWS: a refusal that wrote
  // the row anyway passes a status check perfectly.
  //
  // MUTATION LOG: PUT back to the bare INSERT ⇒ self-source and blocked cases
  // fail (a row appears); `ownerChose: true` on the add ⇒ "not a follow"
  // fails (a `follows` row appears); DELETE back to the DELETE ⇒ the reset
  // case fails (row and follow gone).
  // ===========================================================================

  async function author(label: string): Promise<{ id: string; pubkey: string }> {
    const { rows } = await client.query<{ id: string; nostr_pubkey: string }>(
      `INSERT INTO accounts (nostr_pubkey, nostr_privkey_enc, display_name, status)
       VALUES ($1, 'fixture-enc', $2, 'active') RETURNING id, nostr_pubkey`,
      [uniq().padEnd(64, "0").slice(0, 64), label],
    );
    cleanupAccounts.push(rows[0].id);
    return { id: rows[0].id, pubkey: rows[0].nostr_pubkey };
  }
  async function sourceRows(accountId: string): Promise<number> {
    const { rows } = await client.query(
      `SELECT 1 FROM feed_sources WHERE feed_id = $1 AND source_type = 'account' AND account_id = $2`,
      [feedId, accountId],
    );
    return rows.length;
  }
  async function followRows(accountId: string): Promise<number> {
    const { rows } = await client.query(
      `SELECT 1 FROM follows WHERE follower_id = $1 AND followee_id = $2`,
      [ownerId, accountId],
    );
    return rows.length;
  }

  it("a first PUT makes the source through addSource — and it is NOT a follow", async () => {
    const a = await author("Fixture not-a-follow");
    const res = await app.inject({
      method: "PUT",
      url: `/feeds/${feedId}/author-volume/${a.pubkey}`,
      payload: { step: 1 },
    });
    expect(res.statusCode).toBe(200);
    expect(await sourceRows(a.id)).toBe(1);
    // Turning an author down is not following them: no graph row, and so no
    // kind-3 claim the member never made.
    expect(await followRows(a.id)).toBe(0);
    const { rows } = await client.query<{ id: string }>(
      `SELECT id FROM feed_sources WHERE feed_id = $1 AND account_id = $2`,
      [feedId, a.id],
    );
    expect((await stored(rows[0].id)).throughput).toBe(0.2);
  });

  it("you are not a source of your own feed — refused, and no row", async () => {
    const { rows } = await client.query<{ nostr_pubkey: string }>(
      `SELECT nostr_pubkey FROM accounts WHERE id = $1`,
      [ownerId],
    );
    const res = await app.inject({
      method: "PUT",
      url: `/feeds/${feedId}/author-volume/${rows[0].nostr_pubkey}`,
      payload: { step: 0 },
    });
    expect(res.statusCode).toBe(400);
    expect(res.json().error).toBe("self_source");
    expect(await sourceRows(ownerId)).toBe(0);
  });

  it("a block either way refuses with one neutral answer, and writes no row", async () => {
    const a = await author("Fixture blocked");
    await client.query(`INSERT INTO blocks (blocker_id, blocked_id) VALUES ($1, $2)`, [a.id, ownerId]);
    const res = await app.inject({
      method: "PUT",
      url: `/feeds/${feedId}/author-volume/${a.pubkey}`,
      payload: { step: 0 },
    });
    expect(res.statusCode).toBe(403);
    expect(res.json().error).toBe("target_blocked");
    expect(await sourceRows(a.id)).toBe(0);
    await client.query(`DELETE FROM blocks WHERE blocker_id = $1`, [a.id]);
  });

  it("a DELETE resets the volume and leaves the row AND the follow alone", async () => {
    const a = await author("Fixture reset");
    // A source the member CHOSE (the composer's door), so it carries a follow.
    const { addSource } = await import("../src/routes/feeds/sources.js");
    await addSource(feedId, ownerId, { sourceType: "account", accountId: a.id }, { ownerChose: true });
    expect(await followRows(a.id)).toBe(1);
    const url = `/feeds/${feedId}/author-volume/${a.pubkey}`;
    const down = await app.inject({ method: "PUT", url, payload: { step: 1, sampling: "random" } });
    expect(down.statusCode).toBe(200);
    const mute = await app.inject({ method: "PUT", url, payload: { step: 0 } });
    expect(mute.statusCode).toBe(200);

    const reset = await app.inject({ method: "DELETE", url });
    expect(reset.statusCode).toBe(204);

    // Still a source, still followed, back at the passive default the header
    // describes — the column DEFAULTs, not a second spelling of them.
    expect(await sourceRows(a.id)).toBe(1);
    expect(await followRows(a.id)).toBe(1);
    const { rows } = await client.query<{ id: string }>(
      `SELECT id FROM feed_sources WHERE feed_id = $1 AND account_id = $2`,
      [feedId, a.id],
    );
    expect(await stored(rows[0].id)).toEqual({ throughput: 1, muted: false });
    expect(await storedMode(rows[0].id)).toBe("scored");
    const after = await app.inject({ method: "GET", url });
    expect(after.json()).toMatchObject({ step: 5, sampling: "top", muted: false });
  });
});
