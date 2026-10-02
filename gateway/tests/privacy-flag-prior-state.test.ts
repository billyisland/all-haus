import { describe, it, expect, beforeAll, afterAll, beforeEach, afterEach } from "vitest";
import pg from "pg";
import {
  PRIOR_DISCOVERY_FLAGS_SQL,
  SET_DISCOVERY_ENABLED_SQL,
  SET_PUBLISH_FOLLOW_GRAPH_SQL,
  wasPublishingFollowList,
} from "../src/routes/privacy-preferences.js";

// =============================================================================
// Does flipping a discovery flag actually report what the flag WAS?
// (MIRROR-AUDIT §4 / S22.)
//
// WHY THIS EXISTS, and it is the whole point of the file: the mocked-pool test
// next door (`follow-list-retract.test.ts`) went green against an implementation
// that could not work. The first cut read the prior flags out of a CTE —
//
//     WITH prev AS (SELECT … FROM accounts WHERE id = $2 FOR UPDATE)
//     UPDATE accounts SET … WHERE id = $2
//     RETURNING (SELECT discovery_enabled FROM prev) AS was_discovery_enabled, …
//
// — which Postgres answers with **NULL**. `wasPublishing` would therefore have
// been false for everybody and NO retraction would ever have fired, including
// the legitimate one: a member who really was publishing, opting out, and
// leaving their follow list on the public mesh for good. That is a worse defect
// than the one the change was written to fix, and every mocked assertion passed
// against it, because a mock answers from its fixture and cannot evaluate SQL.
//
// So this drives the REAL route handler's statements against real Postgres, in
// a rolled-back transaction. It is the third rule of the mock discipline: the
// class that survives dispatching-on-SQL is what DB-backed tests are for.
//
// THE THREE FIXTURES ARE THE THREE ANSWERS. Both flags on (was publishing),
// discovery off (never published anything), follow-graph off within an opted-in
// account (kind 0 and 10002 went out, kind 3 never did).
// =============================================================================

const DB_URL = process.env.TEST_DATABASE_URL ?? process.env.DATABASE_URL;

// The route's own statements and its own predicate, IMPORTED. A copy retyped
// here would agree with itself about the very thing that was wrong — that is
// how the CTE version passed — so nothing in this file restates the SQL.

describe.skipIf(!DB_URL)("prior discovery flags across a flag flip", () => {
  let client: pg.Client;
  let account: string;

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

  async function seed(discovery: boolean, followGraph: boolean) {
    const { rows } = await client.query<{ id: string }>(
      `INSERT INTO accounts
         (nostr_pubkey, nostr_privkey_enc, discovery_enabled, publish_follow_graph)
       VALUES ($1, 'fixture-enc', $2, $3) RETURNING id`,
      [
        `fixture-privflag-${process.hrtime.bigint().toString(16)}`,
        discovery,
        followGraph,
      ],
    );
    account = rows[0].id;
  }

  /** The route's own sequence, on the route's own statements: locked read,
   *  then the write, then the route's own predicate over what came back. */
  async function flip(updateSql: string, value: boolean): Promise<boolean> {
    const { rows } = await client.query<{
      discovery_enabled: boolean;
      publish_follow_graph: boolean;
    }>(PRIOR_DISCOVERY_FLAGS_SQL, [account]);
    await client.query(updateSql, [value, account]);
    return wasPublishingFollowList(rows[0]);
  }

  const flipFollowGraph = (v: boolean) => flip(SET_PUBLISH_FOLLOW_GRAPH_SQL, v);
  const flipDiscovery = (v: boolean) => flip(SET_DISCOVERY_ENABLED_SQL, v);

  async function currentFlags() {
    const { rows } = await client.query<{
      discovery_enabled: boolean;
      publish_follow_graph: boolean;
    }>(
      `SELECT discovery_enabled, publish_follow_graph FROM accounts WHERE id = $1`,
      [account],
    );
    return rows[0];
  }

  it("reports TRUE for a member who was publishing — the case a broken read silently refuses", async () => {
    await seed(true, true);

    // This is the assertion the CTE version failed: it answered NULL, so this
    // was false, and the member's follow list would have stayed on the mesh.
    expect(await flipFollowGraph(false)).toBe(true);
  });

  it("reports FALSE for a member who never opted into discovery", async () => {
    // The default shape of the settings pane: publish_follow_graph TRUE,
    // discovery_enabled FALSE. Nothing was ever published for them.
    await seed(false, true);

    expect(await flipFollowGraph(false)).toBe(false);
  });

  it("reports FALSE when the follow graph was already opted out", async () => {
    // Opted into discovery but not the follow graph: kind 0 and 10002 went out
    // and kind 3 never did, so turning discovery off has no kind 3 to retract.
    await seed(true, false);

    expect(await flipDiscovery(false)).toBe(false);
  });

  it("reports TRUE for a publishing member turning discovery itself off", async () => {
    await seed(true, true);

    expect(await flipDiscovery(false)).toBe(true);
  });

  it("the write still lands — the read must not be the whole statement", async () => {
    await seed(true, true);
    await flipFollowGraph(false);

    // A fix that reads the prior state and forgets to write is exactly as
    // green on the assertions above as one that does both.
    expect(await currentFlags()).toEqual({
      discovery_enabled: true,
      publish_follow_graph: false,
    });

    await flipDiscovery(false);
    expect((await currentFlags()).discovery_enabled).toBe(false);
  });

  it("a row that is not there reads as NOT publishing, rather than as undefined", async () => {
    await seed(true, true);
    const missing = "00000000-0000-4000-8000-00000000dead";

    const { rows } = await client.query<{
      discovery_enabled: boolean;
      publish_follow_graph: boolean;
    }>(PRIOR_DISCOVERY_FLAGS_SQL, [missing]);

    // An account deleted between the request arriving and the flag flip. The
    // read returns nothing, and the predicate must answer FALSE for it — the
    // absent row is the case where "we don't know" and "they were publishing"
    // could most easily be collapsed, and collapsing them puts an event on the
    // mesh for an account that is gone. (No mutation distinguishes `=== true`
    // from truthiness here, both columns being NOT NULL booleans; the guard
    // that is real is the one on the row's ABSENCE, which is what this asserts.)
    expect(rows).toHaveLength(0);
    expect(wasPublishingFollowList(rows[0])).toBe(false);
  });

  // A FACT ABOUT POSTGRES, not about our code — and it is the whole reason this
  // file exists. Pinned so nobody "simplifies" the read-then-write pair back
  // into one statement: the form below looks obviously equivalent, is what was
  // written first, and answers NULL. Every mocked assertion passed against it.
  it("the prior read is NOT satisfiable by a CTE in the UPDATE — Postgres answers NULL", async () => {
    await seed(true, true);

    const { rows } = await client.query<{
      was_discovery_enabled: boolean | null;
      was_publish_follow_graph: boolean | null;
    }>(
      `WITH prev AS (
         SELECT discovery_enabled, publish_follow_graph
           FROM accounts WHERE id = $2 FOR UPDATE
       )
       UPDATE accounts SET publish_follow_graph = $1, updated_at = now()
       WHERE id = $2
       RETURNING (SELECT discovery_enabled FROM prev) AS was_discovery_enabled,
                 (SELECT publish_follow_graph FROM prev) AS was_publish_follow_graph`,
      [false, account],
    );

    expect(rows[0].was_discovery_enabled).toBeNull();
    expect(rows[0].was_publish_follow_graph).toBeNull();
  });
});
