import { describe, it, expect, beforeAll, afterAll } from "vitest";
import pg from "pg";

// =============================================================================
// One event id, three tables, and the row decides (MIRROR-AUDIT §2.7, S5).
//
// `POST /notes` indexes a note under a client-supplied `nostrEventId` with no
// signer check, and `POST /replies` / `POST /votes` used to pick their table
// from the request's own `targetKind`. Together those made the declared kind a
// way to CHOOSE which table gets searched: mint a note under a paywalled
// article's event id, send `targetKind: 1`, and the article row is never read,
// so the `access_mode` guard both routes carry never runs.
//
// WHY DB-BACKED. The two guard suites (`reply-paywall-guard`,
// `vote-paywall-guard`) prove the routes reach the guard with the right key,
// against a mock that answers from the SQL it is handed. What they cannot prove
// is the thing this file is about: which row actually wins when the SAME id
// exists in more than one table. That is Postgres's answer, not a mock's — and
// the collision check in `POST /notes` is a `UNION ALL … LIMIT 1` that only
// Postgres can evaluate.
//
// Run locally:
//   POSTGRES_PASSWORD=$(grep -E '^POSTGRES_PASSWORD=' .env | cut -d= -f2-) \
//   DATABASE_URL=postgresql://platformpub:$POSTGRES_PASSWORD@localhost:5432/platformpub \
//     npx vitest run tests/event-id-squat.test.ts
// =============================================================================

const DB_URL = process.env.TEST_DATABASE_URL ?? process.env.DATABASE_URL;

describe.skipIf(!DB_URL)("event-id resolution across tables", () => {
  let client: pg.Client;
  let resolveEventTarget: typeof import("../src/lib/event-target.js").resolveEventTarget;
  let eventIdIsTaken: typeof import("../src/lib/event-target.js").eventIdIsTaken;

  let writerId: string;
  let squatterId: string;
  let articleId: string;
  let commentId: string;

  const stamp = Date.now().toString(36);
  const ARTICLE_EVENT = `a${stamp}`.padEnd(64, "0");
  const COMMENT_EVENT = `c${stamp}`.padEnd(64, "0");
  const NOTE_EVENT = `n${stamp}`.padEnd(64, "0");

  beforeAll(async () => {
    process.env.DATABASE_URL = DB_URL;
    client = new pg.Client({ connectionString: DB_URL });
    await client.connect();
    ({ resolveEventTarget, eventIdIsTaken } = await import(
      "../src/lib/event-target.js"
    ));

    const acct = async (suffix: string) => {
      const { rows } = await client.query<{ id: string }>(
        `INSERT INTO accounts (nostr_pubkey) VALUES ($1) RETURNING id`,
        [`squat${stamp}${suffix}`.padEnd(64, "0")],
      );
      return rows[0].id;
    };
    writerId = await acct("w");
    squatterId = await acct("s");

    const art = await client.query<{ id: string }>(
      `INSERT INTO articles
         (writer_id, nostr_event_id, nostr_d_tag, title, slug, access_mode,
          price_pence, published_at)
       VALUES ($1, $2, $3, 'Gated piece', $3, 'paywalled', 300, now())
       RETURNING id`,
      [writerId, ARTICLE_EVENT, `squat-${stamp}`],
    );
    articleId = art.rows[0].id;

    const com = await client.query<{ id: string }>(
      `INSERT INTO comments
         (author_id, nostr_event_id, target_event_id, target_kind, content)
       VALUES ($1, $2, $3, 30023, 'A reply.')
       RETURNING id`,
      [writerId, COMMENT_EVENT, ARTICLE_EVENT],
    );
    commentId = com.rows[0].id;

    // THE SQUAT ITSELF, planted directly. Three notes: one honest, and two
    // under ids that already belong to an article and to a comment. The route
    // now refuses to mint the latter two — proved below — but rows like them
    // may already exist, and the resolver has to lose them anyway.
    for (const ev of [NOTE_EVENT, ARTICLE_EVENT, COMMENT_EVENT]) {
      await client.query(
        `INSERT INTO notes (author_id, nostr_event_id, content)
         VALUES ($1, $2, 'squat')`,
        [squatterId, ev],
      );
    }
  });

  afterAll(async () => {
    await client.query(`DELETE FROM notes WHERE author_id = ANY($1::uuid[])`, [
      [writerId, squatterId],
    ]);
    await client.query(`DELETE FROM comments WHERE author_id = ANY($1::uuid[])`, [
      [writerId, squatterId],
    ]);
    await client.query(`DELETE FROM articles WHERE writer_id = $1`, [writerId]);
    await client.query(`DELETE FROM accounts WHERE id = ANY($1::uuid[])`, [
      [writerId, squatterId],
    ]);
    await client.end();
    const { pool } = await import("@platform-pub/shared/db/client.js");
    await pool.end();
  });

  it("resolves a squatted article id as the ARTICLE, with the paywall on it", async () => {
    // Declared as a note — which is exactly what the attack sends.
    const target = await resolveEventTarget(client, ARTICLE_EVENT, 1);

    expect(target?.kind).toBe(30023);
    if (target?.kind !== 30023) throw new Error("unreachable");
    expect(target.articleId).toBe(articleId);
    expect(target.authorId).toBe(writerId);
    // The guard's ingredients: without these the caller has an article row it
    // cannot gate on, which is the same hole one step in.
    expect(target.accessMode).toBe("paywalled");
    expect(target.publicationId).toBeNull();
  });

  it("resolves a squatted comment id as the COMMENT, carrying its root", async () => {
    const target = await resolveEventTarget(client, COMMENT_EVENT, 1);

    expect(target?.kind).toBe(1111);
    if (target?.kind !== 1111) throw new Error("unreachable");
    expect(target.commentId).toBe(commentId);
    // The root is what joins `articles`, and so what decides whether the
    // conversation is locked.
    expect(target.rootEventId).toBe(ARTICLE_EVENT);
  });

  it("still resolves an honest note as a note, whatever kind is declared", async () => {
    // The rule cuts both ways or it is not a rule: a genuine note must not be
    // dragged into some other table by a wrong declaration either.
    expect((await resolveEventTarget(client, NOTE_EVENT, 1))?.kind).toBe(1);
    expect((await resolveEventTarget(client, NOTE_EVENT, 30023))?.kind).toBe(1);
  });

  it("answers null for an id that names nothing", async () => {
    expect(await resolveEventTarget(client, "f".repeat(64), 1)).toBeNull();
  });

  it("does not resolve a soft-deleted article back into existence", async () => {
    // A deleted article's id is still squatted in `notes` here. The resolver
    // filters `deleted_at IS NULL`, so it falls through — and must land on the
    // note rather than on nothing, or deleting a piece would 404 every vote on
    // every note that ever collided with it.
    await client.query(`UPDATE articles SET deleted_at = now() WHERE id = $1`, [
      articleId,
    ]);
    const target = await resolveEventTarget(client, ARTICLE_EVENT, 30023);
    await client.query(`UPDATE articles SET deleted_at = NULL WHERE id = $1`, [
      articleId,
    ]);

    expect(target?.kind).toBe(1);
  });

  it("the collision check sees both tables — the refusal POST /notes now makes", async () => {
    // The REAL statement, imported rather than retyped: a test holding its own
    // copy of production SQL proves the copy. The route runs it inside the same
    // transaction as its INSERT — checked outside, the two are interleavable.
    //
    // Both arms matter: an article id and a comment id are each a squat, and
    // `notes` is deliberately not an arm (a repeat of a note's own id is an
    // ordinary duplicate the INSERT already answers with a 200).
    expect(await eventIdIsTaken(client, ARTICLE_EVENT)).toBe(true);
    expect(await eventIdIsTaken(client, COMMENT_EVENT)).toBe(true);
    expect(await eventIdIsTaken(client, NOTE_EVENT)).toBe(false);
    expect(await eventIdIsTaken(client, "f".repeat(64))).toBe(false);
  });
});
