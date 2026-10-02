import { describe, it, expect, beforeAll, afterAll, beforeEach, afterEach } from "vitest";
import pg from "pg";

// =============================================================================
// The precision invariant, demonstrated rather than asserted.
//
// Four descending keyset cursors carried their position through a JS `Date`:
// the DM pager, the notifications pager, the traffology observation feed and
// the daily engagement sweep. `timestamptz` keeps MICROseconds and a `Date`
// keeps milliseconds, so every one of them rounded its position DOWN by up to
// 999µs before feeding it back.
//
// Which way that hurts depends on the comparison, and this family is the bad
// half. These are DESCENDING cursors compared with `<`. A position rounded
// down is EARLIER, so the rows between the truncated microsecond and the true
// one fall outside both pages: page 1 stopped above them, page 2 starts below
// them, and nothing ever revisits them. The symptom is a notification, a
// message or an observation that nobody sees — never an error, never a
// duplicate, and invisible from the outside. The ascending case (the waitlist
// digest watermark) truncates the same way and re-sends instead, which is the
// visible half; both are pinned below so the two cannot be conflated.
//
// Only Postgres can evaluate this. A mocked `pool.query` cannot produce a
// microsecond in the first place, so it agrees with whatever the test author
// believed; the route-level suite (`notifications-cursor.test.ts`) pins that
// the route READS the `::text` projection, and this file pins what reading it
// buys. Both are needed: either alone passes against the bug.
//
// The subject is a bare three-row table of the same shape, deliberately not
// any route's SQL — what is under test is Postgres's behaviour on a keyset
// comparison, which is the same fact for all four call sites and is not a fact
// about any of them.
//
// Fixtures live inside a transaction that is ALWAYS rolled back. Skipped
// without a DB URL — CI supplies one (it boots Postgres and FAILS on a skip).
// Run locally:
//   POSTGRES_PASSWORD=$(grep -E '^POSTGRES_PASSWORD=' ../.env | cut -d= -f2-) \
//   TEST_DATABASE_URL=postgresql://platformpub:$POSTGRES_PASSWORD@localhost:5432/platformpub \
//     npx vitest run tests/timestamp-cursor-precision.test.ts
// =============================================================================

const DB_URL = process.env.TEST_DATABASE_URL ?? process.env.DATABASE_URL;

describe.skipIf(!DB_URL)("timestamptz keyset cursors carried through a Date", () => {
  let client: pg.Client;

  beforeAll(async () => {
    client = new pg.Client({ connectionString: DB_URL });
    await client.connect();
  });
  afterAll(async () => {
    await client.end();
  });

  beforeEach(async () => {
    await client.query("BEGIN");
    // Three rows inside ONE millisecond. A Date cannot tell them apart.
    await client.query(`
      CREATE TEMP TABLE cursor_fixture (
        label text PRIMARY KEY,
        created_at timestamptz NOT NULL
      ) ON COMMIT DROP
    `);
    await client.query(`
      INSERT INTO cursor_fixture (label, created_at) VALUES
        ('oldest', '2026-09-10 12:00:00.001000+00'),
        ('middle', '2026-09-10 12:00:00.001001+00'),
        ('newest', '2026-09-10 12:00:00.001002+00')
    `);
  });
  afterEach(async () => {
    await client.query("ROLLBACK");
  });

  /** One page: newest-first, `LIMIT 1`, below `cursor` when there is one. */
  async function page(cursor: string | null) {
    const { rows } = await client.query<{
      label: string;
      created_at: Date;
      created_at_exact: string;
    }>(
      `SELECT label, created_at, created_at::text AS created_at_exact
         FROM cursor_fixture
        WHERE ($1::timestamptz IS NULL OR created_at < $1::timestamptz)
        ORDER BY created_at DESC
        LIMIT 1`,
      [cursor],
    );
    return rows[0] ?? null;
  }

  it("the premise: three rows one Date apart, three microseconds apart to Postgres", async () => {
    // Without this the rest of the file could pass for the wrong reason — e.g.
    // against a driver that had started handing back strings on its own.
    const first = await page(null);
    expect(first!.label).toBe("newest");
    expect(first!.created_at).toBeInstanceOf(Date);
    expect(first!.created_at.toISOString()).toBe("2026-09-10T12:00:00.001Z");
    expect(first!.created_at_exact).toContain(".001002");
  });

  it("carried as ::text, every row is reached", async () => {
    const seen: string[] = [];
    let cursor: string | null = null;
    for (let i = 0; i < 4; i++) {
      const row: Awaited<ReturnType<typeof page>> = await page(cursor);
      if (!row) break;
      seen.push(row.label);
      cursor = row.created_at_exact;
    }
    expect(seen).toEqual(["newest", "middle", "oldest"]);
  });

  it("carried as a Date, the rows inside the lost microseconds are SKIPPED", async () => {
    // The shipped bug, run. Not an error and not a duplicate: page 2 is simply
    // empty, and the reader is told there is no more history.
    const first = await page(null);
    const truncated = first!.created_at.toISOString();
    expect(truncated).not.toBe(first!.created_at_exact);

    expect(await page(truncated)).toBeNull();
  });

  it("the same truncation on an ASCENDING `>` cursor re-sends instead", async () => {
    // Stated so the two halves cannot be conflated. Position at 'middle'
    // (.001001); truncated to .001 it is EARLIER, so `>` re-includes the row
    // the cursor was minted from. A repeated digest entry is visible; a
    // notification that fell into the gap above is not.
    const exact = "2026-09-10 12:00:00.001001+00";
    const truncated = "2026-09-10 12:00:00.001+00";

    const after = (cursor: string) =>
      client
        .query<{ label: string }>(
          `SELECT label FROM cursor_fixture
            WHERE created_at > $1::timestamptz
            ORDER BY created_at ASC`,
          [cursor],
        )
        .then((r) => r.rows.map((x) => x.label));

    expect(await after(exact)).toEqual(["newest"]);
    expect(await after(truncated)).toEqual(["middle", "newest"]);
  });
});
