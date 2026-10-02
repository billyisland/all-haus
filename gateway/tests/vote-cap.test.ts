import { describe, it, expect, beforeAll, afterAll, vi } from "vitest";
import Fastify from "fastify";
import pg from "pg";

// =============================================================================
// One free vote per (voter, target, direction), held by the SCHEMA (CA-H1).
//
// The cap used to be an advisory lock plus a COUNT(*) in the route; it is now
// the partial unique index `idx_votes_one_per_direction` (migration 265) and an
// `ON CONFLICT … DO NOTHING`. DB-backed because the claim IS the index: a mocked
// client would be told whether the insert conflicted. The concurrent case is
// FORCED — both requests are in flight before either is awaited — so a route
// that went back to "count, then insert" without a lock would land both.
//
// Run locally (both vars — the route uses the shared pool):
//   export DATABASE_URL=postgresql://platformpub:password@localhost:5432/platformpub
//   TEST_DATABASE_URL="$DATABASE_URL" npx vitest run tests/vote-cap.test.ts
// =============================================================================

const DB_URL = process.env.TEST_DATABASE_URL ?? process.env.DATABASE_URL;

let voterId = "";

vi.mock("../src/middleware/auth.js", () => ({
  requireAuth: async (req: { session?: { sub: string } }) => {
    req.session = { sub: voterId };
  },
}));

// A note target never reaches the paywall guard; mocked only because the
// module reads service env at import.
vi.mock("../src/services/article-access/index.js", () => ({
  checkArticleAccess: async () => ({ hasAccess: true }),
}));

describe.skipIf(!DB_URL)("POST /votes — the cap is the index", () => {
  let client: pg.Client;
  let writerId: string;
  let app: Awaited<ReturnType<typeof build>>;

  const stamp = Date.now().toString(36);
  const NOTE_EVENT = `vcap${stamp}`.padEnd(64, "0");
  const OLD_NOTE_EVENT = `vcapold${stamp}`.padEnd(64, "0");

  async function build() {
    const { voteRoutes } = await import("../src/routes/votes.js");
    const a = Fastify();
    await a.register(voteRoutes);
    return a;
  }

  function vote(targetEventId: string, direction: "up" | "down") {
    return app.inject({
      method: "POST",
      url: "/votes",
      payload: { targetEventId, targetKind: 1, direction },
    });
  }

  async function tally(eventId: string) {
    const { rows } = await client.query<{ upvote_count: number; downvote_count: number }>(
      `SELECT upvote_count, downvote_count FROM vote_tallies WHERE target_nostr_event_id = $1`,
      [eventId],
    );
    return rows[0] ?? { upvote_count: 0, downvote_count: 0 };
  }

  async function voteRows(eventId: string) {
    const { rows } = await client.query<{ direction: string }>(
      `SELECT direction FROM votes WHERE voter_id = $1 AND target_nostr_event_id = $2`,
      [voterId, eventId],
    );
    return rows.map((r) => r.direction).sort();
  }

  beforeAll(async () => {
    client = new pg.Client({ connectionString: DB_URL });
    await client.connect();
    const w = await client.query<{ id: string }>(
      `INSERT INTO accounts (nostr_pubkey) VALUES ($1) RETURNING id`,
      [`vcapw${stamp}`.padEnd(64, "0")],
    );
    writerId = w.rows[0].id;
    const v = await client.query<{ id: string }>(
      `INSERT INTO accounts (nostr_pubkey) VALUES ($1) RETURNING id`,
      [`vcapv${stamp}`.padEnd(64, "0")],
    );
    voterId = v.rows[0].id;
    await client.query(
      `INSERT INTO notes (author_id, nostr_event_id, content)
       VALUES ($1, $2, 'vote cap'), ($1, $3, 'vote cap, voted before')`,
      [writerId, NOTE_EVENT, OLD_NOTE_EVENT],
    );
    // A vote cast before this route existed, written straight to the table —
    // the route must see it through the index, not through its own memory.
    await client.query(
      `INSERT INTO votes (voter_id, target_nostr_event_id, target_author_id, direction, sequence_number)
       VALUES ($1, $2, $3, 'up', 1)`,
      [voterId, OLD_NOTE_EVENT, writerId],
    );
    app = await build();
  });

  afterAll(async () => {
    await app?.close();
    await client.query(`DELETE FROM votes WHERE voter_id = $1`, [voterId]);
    await client.query(
      `DELETE FROM vote_tallies WHERE target_nostr_event_id = ANY($1)`,
      [[NOTE_EVENT, OLD_NOTE_EVENT]],
    );
    await client.query(`DELETE FROM notes WHERE author_id = $1`, [writerId]);
    await client.query(`DELETE FROM accounts WHERE id = ANY($1)`, [[writerId, voterId]]);
    await client.end();
  });

  it("lands exactly one of two CONCURRENT votes in the same direction", async () => {
    const [a, b] = await Promise.all([vote(NOTE_EVENT, "up"), vote(NOTE_EVENT, "up")]);
    const statuses = [a.statusCode, b.statusCode].sort();
    expect(statuses).toEqual([200, 201]);
    const loser = a.statusCode === 200 ? a : b;
    expect(loser.json().counted).toBe(false);
    expect(await voteRows(NOTE_EVENT)).toEqual(["up"]);
    expect((await tally(NOTE_EVENT)).upvote_count).toBe(1);
  });

  it("a later repeat is a no-op that reports the tally it did not move", async () => {
    const res = await vote(NOTE_EVENT, "up");
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ counted: false, tally: { upvoteCount: 1 } });
    expect(await voteRows(NOTE_EVENT)).toEqual(["up"]);
  });

  it("the other direction is its own vote", async () => {
    const res = await vote(NOTE_EVENT, "down");
    expect(res.statusCode).toBe(201);
    expect(res.json().counted).toBe(true);
    expect(await voteRows(NOTE_EVENT)).toEqual(["down", "up"]);
    expect(await tally(NOTE_EVENT)).toMatchObject({ upvote_count: 1, downvote_count: 1 });
  });

  it("a vote already in the table caps the route, though the route never wrote it", async () => {
    const res = await vote(OLD_NOTE_EVENT, "up");
    expect(res.statusCode).toBe(200);
    expect(res.json().counted).toBe(false);
    expect(await voteRows(OLD_NOTE_EVENT)).toEqual(["up"]);
  });
});
