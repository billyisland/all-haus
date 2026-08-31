import { describe, it, expect, vi, beforeEach } from "vitest";
import Fastify from "fastify";

// =============================================================================
// Ingest liveness on the owner dashboard (prod incident 2026-08-11).
//
// feed-ingest took a stray SIGTERM at 14:07 UTC and nothing restarted it. Every
// container reported healthy, /health was green, every number on the overview
// page was fine, and no content was ingested for 21 hours — found only because
// the operator noticed their own feeds were stale. This block is the answer,
// and what it must get right is the shape of the signal rather than the
// plumbing:
//
//   · the alarm is derived from an ABSENCE (a heartbeat the worker stamps every
//     60s), so a stopped worker cannot report itself alive — unlike
//     jetstream_healthy, a self-declared boolean that sat at `true` for the
//     whole outage because the process that owns it was gone;
//   · a heartbeat that has NEVER been written is `down`, not "unknown" — the
//     reassuring reading of an absence is the bug class this repo keeps
//     re-learning;
//   · the threshold is a dial, and a dial with no reader is not a dial, so the
//     seeded value must be shown to actually reach the verdict;
//   · per-protocol times are context, NOT alarms, and a never-fetched protocol
//     must survive as null rather than becoming a zero.
//
// The mock answers from the SQL it is handed: the two ingest queries are
// matched on their own text, so a route that stopped selecting the heartbeat
// would fail here rather than pass against a fixture.
// =============================================================================

process.env.PAYMENT_SERVICE_URL ??= "http://payment-service.test";
process.env.INTERNAL_SERVICE_TOKEN ??= "test-token";

let heartbeat: string | null = null;
let alertSeconds: string | null = null;
let protocols: Array<{
  protocol: string;
  active_sources: number;
  last_fetched_at: Date | null;
}> = [];

// Dead-job fixtures (§8.15). Rows are shaped as the SQL returns them, since
// what is under test here is the route's handling and not the query.
let deadJobRows: Array<Record<string, unknown>> = [];
let deadJobsFails = false;
let deadJobWindow: string | null = null;

function query(sql: string) {
  if (sql.includes("dead_job_arrival_window_hours")) {
    return Promise.resolve({ rows: deadJobWindow === null ? [] : [{ value: deadJobWindow }], rowCount: 1 });
  }
  if (sql.includes("graphile_worker._private_jobs")) {
    // The failure this panel has to survive: graphile moving its private tables
    // under us. Rejecting here is the real shape of that — a Postgres error
    // from the pool, mid-round-trip.
    if (deadJobsFails) {
      return Promise.reject(new Error('relation "graphile_worker._private_jobs" does not exist'));
    }
    return Promise.resolve({ rows: deadJobRows, rowCount: deadJobRows.length });
  }
  if (sql.includes("feed_ingest_heartbeat")) {
    return Promise.resolve({
      rows: [{ heartbeat, alert_seconds: alertSeconds }],
      rowCount: 1,
    });
  }
  if (sql.includes("FROM external_sources") && sql.includes("GROUP BY protocol")) {
    return Promise.resolve({ rows: protocols, rowCount: protocols.length });
  }
  // Every other panel on this route. One empty object, not zero rows: the
  // handler destructures `.rows[0]` for most of them, and this test is about
  // the ingest block, not about them.
  return Promise.resolve({ rows: [{}], rowCount: 1 });
}

vi.mock("@platform-pub/shared/db/client.js", () => ({
  pool: { query: (sql: string) => query(sql) },
  withTransaction: vi.fn(),
  loadConfig: async () => ({ tabSettlementThresholdPence: 500 }),
}));

vi.mock("@platform-pub/shared/lib/logger.js", () => ({
  default: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

vi.mock("../src/middleware/admin.js", () => ({
  requireAdmin: (req: any, _reply: any, done: any) => {
    req.session = { sub: "admin-id" };
    done();
  },
  getAdminIds: () => Promise.resolve(["admin-id"]),
}));

const { adminDashboardRoutes } = await import("../src/routes/admin-dashboard.js");

async function overview() {
  const app = Fastify({ logger: false });
  await app.register(adminDashboardRoutes);
  const res = await app.inject({
    method: "GET",
    url: "/admin/dashboard/overview",
  });
  await app.close();
  return res;
}

async function ingest() {
  const res = await overview();
  expect(res.statusCode).toBe(200);
  return res.json().ingest;
}

async function jobs() {
  const res = await overview();
  expect(res.statusCode).toBe(200);
  return res.json().jobs;
}

const secondsAgo = (n: number) => new Date(Date.now() - n * 1000).toISOString();

beforeEach(() => {
  heartbeat = null;
  alertSeconds = null;
  protocols = [];
  deadJobRows = [];
  deadJobsFails = false;
  deadJobWindow = null;
});

describe("ingest worker liveness", () => {
  it("reads a recent heartbeat as running", async () => {
    heartbeat = secondsAgo(30);
    const i = await ingest();
    expect(i.worker.down).toBe(false);
    expect(i.worker.ageSeconds).toBeGreaterThanOrEqual(29);
    expect(i.worker.ageSeconds).toBeLessThan(60);
  });

  it("reads a stale heartbeat as DOWN", async () => {
    // 21 hours — the actual outage.
    heartbeat = secondsAgo(21 * 3600);
    const i = await ingest();
    expect(i.worker.down).toBe(true);
  });

  it("treats a heartbeat that has NEVER been written as down, not unknown", async () => {
    // The whole point. An absent signal is the loud verdict, not the quiet one:
    // the only ways to reach this state on a live database are a worker that
    // has never run and one that stopped writing, and both want an operator
    // looking at it.
    heartbeat = null;
    const i = await ingest();
    expect(i.worker.heartbeatAt).toBeNull();
    expect(i.worker.ageSeconds).toBeNull();
    expect(i.worker.down).toBe(true);
  });

  it("honours the seeded dial rather than the in-code fallback", async () => {
    // A dial with no reader is not a dial. Chosen so the two answers DIFFER:
    // 90s is inside the 600s fallback (would read as running) and outside a
    // seeded 60s — so this passes only if the seeded row reached the verdict.
    heartbeat = secondsAgo(90);
    alertSeconds = "60";
    const tightened = await ingest();
    expect(tightened.worker.alertSeconds).toBe(60);
    expect(tightened.worker.down).toBe(true);

    alertSeconds = null;
    const fallback = await ingest();
    expect(fallback.worker.alertSeconds).toBe(600);
    expect(fallback.worker.down).toBe(false);
  });

  it("falls back rather than trusting junk in the row", async () => {
    heartbeat = secondsAgo(30);
    for (const junk of ["", "not-a-number", "0", "-5"]) {
      alertSeconds = junk;
      const i = await ingest();
      // A NaN threshold compares false against everything, so the alarm would
      // never fire; a 0 threshold fires permanently. Both are worse than the
      // default.
      expect(i.worker.alertSeconds).toBe(600);
      expect(i.worker.down).toBe(false);
    }
  });
});

describe("per-protocol freshness — context, not an alarm", () => {
  it("passes each protocol through with its own last fetch", async () => {
    heartbeat = secondsAgo(10);
    protocols = [
      { protocol: "atproto", active_sources: 623, last_fetched_at: new Date() },
      { protocol: "rss", active_sources: 4, last_fetched_at: new Date() },
    ];
    const i = await ingest();
    expect(i.protocols).toHaveLength(2);
    expect(i.protocols[0]).toMatchObject({ protocol: "atproto", activeSources: 623 });
  });

  it("keeps a never-fetched protocol as null, never as zero", async () => {
    // email is push-delivered and never sets last_fetched_at at all. Rendering
    // that as a timestamp of 0 (1970) or as "stale" would put a permanent false
    // alarm on the page, which is how a real one stops being read.
    heartbeat = secondsAgo(10);
    protocols = [{ protocol: "email", active_sources: 1, last_fetched_at: null }];
    const i = await ingest();
    expect(i.protocols[0].lastFetchedAt).toBeNull();
    expect(i.protocols[0].activeSources).toBe(1);
    // And it does not drag the worker verdict down with it.
    expect(i.worker.down).toBe(false);
  });

  it("says nothing at all when there are no active sources", async () => {
    heartbeat = secondsAgo(10);
    protocols = [];
    const i = await ingest();
    expect(i.protocols).toEqual([]);
  });
});

// =============================================================================
// Dead background jobs (§8.15) — the ROUTE's half of the panel.
//
// The query itself is pinned against real Postgres in dead-jobs-integration
// (the json probe, the FILTERs, the recency window — none of which a mock can
// evaluate). What is left here is what the route does with the rows: which arm
// each lands in, the sums, and the third state when the table cannot be read at
// all — which is the one path the DB test cannot produce, because it needs the
// query to FAIL.
// =============================================================================

describe("dead background jobs", () => {
  it("splits the rows into the two arms and sums each", async () => {
    heartbeat = secondsAgo(10);
    deadJobRows = [
      { task: "relay_outbox_prune", is_cron: true, failed: 84, abandoned: 0, retrying: 2, recent: 1, last_dead_at: new Date(), last_error: "column does not exist" },
      { task: "feed_ingest_nostr", is_cron: false, failed: 0, abandoned: 642, retrying: 0, recent: 9, last_dead_at: new Date(), last_error: null },
      { task: "feed_ingest_activitypub", is_cron: false, failed: 3, abandoned: 381, retrying: 0, recent: 0, last_dead_at: null, last_error: "timeout" },
    ];
    const j = await jobs();
    expect(j.readable).toBe(true);
    expect(j.cron.dead).toBe(84);
    expect(j.cron.retrying).toBe(2);
    expect(j.cron.tasks).toHaveLength(1);
    // dead is failed + abandoned: both mean the work will not happen, which is
    // what the operator is being told.
    expect(j.perEntity.dead).toBe(1026);
    expect(j.perEntity.failed).toBe(3);
    expect(j.perEntity.abandoned).toBe(1023);
    expect(j.perEntity.recent).toBe(9);
  });

  it("reports an unreadable table as a THIRD state, never as zero", async () => {
    // This panel is the one query on the overview that reads past a supported
    // graphile API, so it can fail on its own terms. Rendering that as "no dead
    // jobs" would be this feature committing the exact silence it was built to
    // end — and it would do so on the page an operator trusts most.
    heartbeat = secondsAgo(10);
    deadJobsFails = true;
    const j = await jobs();
    expect(j.readable).toBe(false);
    expect(j.cron).toBeUndefined();
    expect(j.perEntity).toBeUndefined();
    // The window still ships, so the surface can still say what it would have
    // been measuring.
    expect(j.windowHours).toBe(24);
  });

  it("does not let an unreadable job table take down the money page", async () => {
    // The whole reason the caller catches rather than letting the round trip
    // reject: a graphile upgrade that moved its tables must cost this panel and
    // not the settlement, payout and custody figures rendered beside it.
    heartbeat = secondsAgo(10);
    deadJobsFails = true;
    const res = await overview();
    expect(res.statusCode).toBe(200);
    expect(res.json().settlement).toBeDefined();
    expect(res.json().ingest.worker.down).toBe(false);
  });

  it("honours the seeded window dial rather than the in-code fallback", async () => {
    heartbeat = secondsAgo(10);
    deadJobWindow = "72";
    expect((await jobs()).windowHours).toBe(72);

    // And junk falls back rather than becoming a window of NaN (nothing is ever
    // recent) or of zero (every arrival is old news).
    for (const junk of ["", "not-a-number", "0", "-5"]) {
      deadJobWindow = junk;
      expect((await jobs()).windowHours).toBe(24);
    }
  });
});
