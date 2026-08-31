import { describe, it, expect, beforeAll, afterAll, beforeEach, afterEach } from "vitest";
import pg from "pg";

// The route module reads these at import time (it also proxies to
// payment-service); this file only wants its SQL.
process.env.PAYMENT_SERVICE_URL ??= "http://payment-service.test";
process.env.INTERNAL_SERVICE_TOKEN ??= "test-token";

const { DEAD_JOBS_SQL, deadJobWindowHoursDial } = await import(
  "../src/routes/admin-dashboard.js"
);

// =============================================================================
// Dead background jobs — what the surface counts, and what it must not
// (CONSOLIDATED-TODO §8.15).
//
// The heartbeat alarm answers *is the worker running*. It cannot answer *is the
// worker failing everything it picks up*: a job that exhausts its attempts stops
// being retried and sits in graphile_worker's table forever, mentioning itself
// to nobody. `relay_outbox_prune` was red for 84 consecutive nights on prod
// that way, and the fault underneath it had silently deactivated members'
// feeds.
//
// WHY THIS RUNS AGAINST REAL POSTGRES. Every claim the query makes is one only
// a database can settle — a `json ->` probe for the cron marker, four aggregate
// FILTERs, `make_interval` recency, and a three-way split of one attempts/
// locked_at/last_error state space. A mocked `pool.query` would hand back
// whatever this file already believed, which is the same epistemic mistake
// §8.16 was. The route-level shaping (arms, sums, the unreadable third state)
// is pinned separately in admin-ingest-liveness.test.ts against the mock.
//
// The SQL is IMPORTED, never retyped: a copy would pin the copy, and the copy
// is the one thing that cannot drift out of step with itself.
//
// Fixtures live inside a transaction that is ALWAYS rolled back, so the target
// DB's real job queue is never touched. Skipped without a DB URL so the
// no-Postgres CI job stays green. Run locally:
//   POSTGRES_PASSWORD=$(grep -E '^POSTGRES_PASSWORD=' ../.env | cut -d= -f2-) \
//   TEST_DATABASE_URL=postgresql://platformpub:$POSTGRES_PASSWORD@localhost:5432/platformpub \
//     npx vitest run tests/dead-jobs-integration.test.ts
// =============================================================================

const DB_URL = process.env.TEST_DATABASE_URL ?? process.env.DATABASE_URL;

// Deliberately unlike any real task name, so a fixture can never be confused
// with a live row and the assertions can filter to this test's own rows.
const CRON_TASK = "zz_test_cron_task";
const ENTITY_TASK = "zz_test_entity_task";

type Row = {
  task: string;
  is_cron: boolean;
  failed: number;
  abandoned: number;
  retrying: number;
  recent: number;
  last_dead_at: Date | null;
  last_error: string | null;
};

describe.skipIf(!DB_URL)("dead background jobs", () => {
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
  });

  afterEach(async () => {
    await client.query("ROLLBACK");
  });

  /**
   * One job row. `cron` decides the payload shape, which is the only thing the
   * query uses to tell the two arms apart — graphile stamps `_cron` into the
   * payload of everything it queues from the crontab, and a per-entity job
   * carries its `sourceId` instead.
   */
  async function job(opts: {
    task: string;
    cron: boolean;
    attempts: number;
    maxAttempts: number;
    error?: string | null;
    locked?: boolean;
    diedHoursAgo?: number;
  }) {
    const payload = opts.cron
      ? '{"_cron":{"ts":"2026-08-13T03:30:00.000Z","backfilled":false}}'
      : '{"sourceId":"00000000-0000-0000-0000-000000000001"}';
    await client.query(
      `WITH t AS (
         INSERT INTO graphile_worker._private_tasks (identifier) VALUES ($1)
         ON CONFLICT (identifier) DO UPDATE SET identifier = EXCLUDED.identifier
         RETURNING id
       )
       INSERT INTO graphile_worker._private_jobs
         (task_id, payload, attempts, max_attempts, last_error, locked_at, updated_at)
       SELECT t.id, $2::json, $3, $4, $5,
              CASE WHEN $6::boolean THEN now() ELSE NULL END,
              now() - make_interval(hours => $7::int)
         FROM t`,
      [
        opts.task,
        payload,
        opts.attempts,
        opts.maxAttempts,
        opts.error ?? null,
        opts.locked ?? false,
        opts.diedHoursAgo ?? 0,
      ],
    );
  }

  async function run(windowHours = 24): Promise<Record<string, Row>> {
    const { rows } = await client.query<Row>(DEAD_JOBS_SQL, [windowHours]);
    const mine: Record<string, Row> = {};
    for (const r of rows) if (r.task === CRON_TASK || r.task === ENTITY_TASK) mine[r.task] = r;
    return mine;
  }

  it("splits cron from per-entity on the payload marker, not on the task name", async () => {
    // The structural discriminator. A hand-maintained list of cron task names
    // would drift out of step with feed-ingest's crontab the first time one is
    // added, and would misfile the `?id=`-aliased entries (trust_epoch_*) whose
    // crontab identifier is not their task identifier. Two rows identical in
    // every respect EXCEPT the payload must land in different arms.
    await job({ task: CRON_TASK, cron: true, attempts: 25, maxAttempts: 25, error: "boom" });
    await job({ task: ENTITY_TASK, cron: false, attempts: 25, maxAttempts: 25, error: "boom" });

    const r = await run();
    expect(r[CRON_TASK].is_cron).toBe(true);
    expect(r[ENTITY_TASK].is_cron).toBe(false);
  });

  it("counts an exhausted job with an error as FAILED", async () => {
    await job({ task: CRON_TASK, cron: true, attempts: 25, maxAttempts: 25, error: "boom" });

    const r = await run();
    expect(r[CRON_TASK].failed).toBe(1);
    expect(r[CRON_TASK].abandoned).toBe(0);
    expect(r[CRON_TASK].retrying).toBe(0);
    expect(r[CRON_TASK].last_error).toBe("boom");
  });

  it("counts an exhausted job with NO error as ABANDONED, not failed", async () => {
    // 1013 of dev's 1038 dead rows are this: the worker was interrupted
    // mid-job, attempts had already been incremented, and the poll's per-source
    // enqueue sets maxAttempts 1 — so the job is dead having never failed.
    // Reporting them as failures would state a fault that is not there, on the
    // one page built to be believed.
    await job({ task: ENTITY_TASK, cron: false, attempts: 1, maxAttempts: 1, error: null });

    const r = await run();
    expect(r[ENTITY_TASK].abandoned).toBe(1);
    expect(r[ENTITY_TASK].failed).toBe(0);
    expect(r[ENTITY_TASK].last_error).toBeNull();
  });

  it("counts a job that has failed but has attempts left as RETRYING, not dead", async () => {
    // The seven relay_outbox_prune rows found on dev while building this sat at
    // attempts 10-24 of 25 — a cron task failing all day, which the briefed
    // predicate (attempts >= max_attempts) rendered as nothing at all.
    await job({ task: CRON_TASK, cron: true, attempts: 10, maxAttempts: 25, error: "boom" });

    const r = await run();
    expect(r[CRON_TASK].retrying).toBe(1);
    expect(r[CRON_TASK].failed).toBe(0);
    expect(r[CRON_TASK].abandoned).toBe(0);
  });

  it("does NOT count a job locked on its final attempt", async () => {
    // It may yet succeed. Without the locked_at guard, every running job of a
    // maxAttempts-1 task — which is every feed ingest, ten at a time — reports
    // as a permanent failure for as long as it runs, and the per-entity arm
    // becomes a live count of work in progress.
    await job({
      task: ENTITY_TASK,
      cron: false,
      attempts: 1,
      maxAttempts: 1,
      error: null,
      locked: true,
    });

    expect(await run()).toEqual({});
  });

  it("ignores a healthy pending job entirely", async () => {
    await job({ task: ENTITY_TASK, cron: false, attempts: 0, maxAttempts: 1, error: null });

    expect(await run()).toEqual({});
  });

  it("counts only deaths inside the arrival window", async () => {
    // The pile is cumulative and grows by construction, so the total is noise
    // and the arrival rate is the signal. Both rows are equally dead; only one
    // is news.
    await job({
      task: ENTITY_TASK,
      cron: false,
      attempts: 1,
      maxAttempts: 1,
      error: "old",
      diedHoursAgo: 72,
    });
    await job({
      task: ENTITY_TASK,
      cron: false,
      attempts: 1,
      maxAttempts: 1,
      error: "new",
      diedHoursAgo: 1,
    });

    const r = await run(24);
    expect(r[ENTITY_TASK].failed).toBe(2);
    expect(r[ENTITY_TASK].recent).toBe(1);

    // And the window is honoured rather than hard-coded: widen it and the older
    // death becomes recent too. A dial with no reader is not a dial.
    const wide = await run(96);
    expect(wide[ENTITY_TASK].recent).toBe(2);
  });

  it("reports the most recent error, and the most recent death", async () => {
    await job({
      task: CRON_TASK,
      cron: true,
      attempts: 25,
      maxAttempts: 25,
      error: "stale",
      diedHoursAgo: 48,
    });
    await job({
      task: CRON_TASK,
      cron: true,
      attempts: 25,
      maxAttempts: 25,
      error: "latest",
      diedHoursAgo: 1,
    });

    const r = await run();
    expect(r[CRON_TASK].last_error).toBe("latest");
    const ageHours = (Date.now() - new Date(r[CRON_TASK].last_dead_at!).getTime()) / 3_600_000;
    expect(ageHours).toBeGreaterThan(0.5);
    expect(ageHours).toBeLessThan(2);
  });

  it("keeps last_dead_at about the DEAD rows, not the retrying ones", async () => {
    // A task that died last week and is failing again right now must still
    // report last week as when a run was lost — the live failure is reported by
    // `retrying`, and folding it into the death time would make an old, unfixed
    // fault look like it had just started.
    await job({
      task: CRON_TASK,
      cron: true,
      attempts: 25,
      maxAttempts: 25,
      error: "died",
      diedHoursAgo: 168,
    });
    await job({
      task: CRON_TASK,
      cron: true,
      attempts: 3,
      maxAttempts: 25,
      error: "failing now",
      diedHoursAgo: 0,
    });

    const r = await run();
    expect(r[CRON_TASK].failed).toBe(1);
    expect(r[CRON_TASK].retrying).toBe(1);
    const ageHours = (Date.now() - new Date(r[CRON_TASK].last_dead_at!).getTime()) / 3_600_000;
    expect(ageHours).toBeGreaterThan(160);
  });

  it("rejects a fractional window at the bind — why the dial truncates", async () => {
    // The negative control for the dial test below (§0s.2): make_interval's
    // hours argument is $1::int, and Postgres refuses the text form of a
    // fractional value outright. Were the SQL ever changed to floor()::int
    // this starts passing the other way — then the dial's trunc is the second
    // copy of the coercion and one of the two should go.
    await expect(client.query(DEAD_JOBS_SQL, [36.5])).rejects.toThrow(
      /invalid input syntax for type integer/,
    );
  });
});

// The dial reads platform_config through the SHARED POOL — a different
// connection from the fixture client above, so the rolled-back-transaction
// pattern cannot serve it: these writes commit and are restored in finally.
// The key has no seeded row on a DB that has not re-run migrate since it was
// added to config-defaults.sql, which is exactly why each case writes its own.
describe.skipIf(!DB_URL)("the arrival-window dial", () => {
  let client: pg.Client;
  const KEY = "dead_job_arrival_window_hours";

  beforeAll(async () => {
    client = new pg.Client({ connectionString: DB_URL });
    await client.connect();
  });

  afterAll(async () => {
    await client.end();
  });

  async function withDialValue(value: string | null, fn: () => Promise<void>) {
    const { rows: prior } = await client.query<{ value: string }>(
      `SELECT value FROM platform_config WHERE key = $1`,
      [KEY],
    );
    try {
      if (value === null) {
        await client.query(`DELETE FROM platform_config WHERE key = $1`, [KEY]);
      } else {
        await client.query(
          `INSERT INTO platform_config (key, value) VALUES ($1, $2)
           ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value`,
          [KEY, value],
        );
      }
      await fn();
    } finally {
      if (prior.length === 0) {
        await client.query(`DELETE FROM platform_config WHERE key = $1`, [KEY]);
      } else {
        await client.query(
          `INSERT INTO platform_config (key, value) VALUES ($1, $2)
           ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value`,
          [KEY, prior[0].value],
        );
      }
    }
  }

  it("truncates a fractional value instead of darkening the panel", async () => {
    // An operator setting 36.5 — or 0.5 to watch arrivals during an incident —
    // must get a working window, not "unavailable" with graphile blamed.
    await withDialValue("36.5", async () => {
      expect(await deadJobWindowHoursDial()).toBe(36);
    });
    await withDialValue("0.5", async () => {
      // Sub-hour truncates to 0, which as a window means "nothing is ever
      // recent" — floored to the narrowest working window instead.
      expect(await deadJobWindowHoursDial()).toBe(1);
    });
  });

  it("falls back on junk, non-positive, and absent values", async () => {
    await withDialValue("not-a-number", async () => {
      expect(await deadJobWindowHoursDial()).toBe(24);
    });
    await withDialValue("-3", async () => {
      expect(await deadJobWindowHoursDial()).toBe(24);
    });
    await withDialValue(null, async () => {
      expect(await deadJobWindowHoursDial()).toBe(24);
    });
  });
});
