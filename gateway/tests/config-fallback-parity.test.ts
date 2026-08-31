import { describe, it, expect, vi, beforeEach } from "vitest";
import { diffAgainstDefaults } from "@platform-pub/shared/db/config-defaults-parse.js";

// =============================================================================
// §0h.7 — the feed-ranking fallbacks must match config-defaults.sql.
//
// Twin of feed-ingest/tests/config-fallback-parity.test.ts; see that file for
// the full rationale. The gateway half matters for a specific reason: these
// four dials drive the D6 read-time blend, whose entire design premise is that
// it can be retuned by an UPDATE instead of a deploy (CLAUDE.md's
// tuning-dials rule). A fallback that drifted from the seeded value would
// quietly defeat that premise on any DB where the row went missing — the
// operator's tuning surface would be a number that is never read.
// =============================================================================

// admin-dashboard.ts requireEnv()s these at module scope (the ingest-heartbeat
// fallback below imports it). Values are irrelevant — nothing here calls out.
process.env.PAYMENT_SERVICE_URL ??= "http://payment-service.test";
process.env.INTERNAL_SERVICE_TOKEN ??= "test-token";

const configMock = { current: new Map<string, string>() };
vi.mock("../src/lib/platform-config.js", () => ({
  getPlatformConfig: async () => configMock.current,
}));

const { loadProofBlendParams } = await import("../src/lib/feed-rank.js");
const { formulaMaxSources } = await import("../src/routes/feeds/formulas.js");

describe("feed-rank fallbacks vs config-defaults.sql", () => {
  beforeEach(() => {
    configMock.current = new Map();
  });

  it("every fallback matches the seeded default", async () => {
    const p = await loadProofBlendParams();
    const bad = diffAgainstDefaults({
      feed_alpha_following: p.alphaFollowing,
      feed_alpha_explore: p.alphaExplore,
      feed_gravity: p.gravity,
      feed_proof_floor: p.floor,
    });
    expect(bad).toEqual([]);
  });

  it("a seeded value wins over the fallback", async () => {
    configMock.current = new Map([["feed_gravity", "2.25"]]);
    const p = await loadProofBlendParams();
    expect(p.gravity).toBe(2.25);
  });
});

describe("feed-formula source cap fallback vs config-defaults.sql", () => {
  beforeEach(() => {
    configMock.current = new Map();
  });

  it("the in-code fallback matches the seeded default", async () => {
    // Same rule, one dial: the fallback is a SECOND copy of the number, and it
    // substitutes silently in exactly the case it exists for — the row missing.
    // A drifted copy means the operator's UPDATE tunes a value nothing reads.
    expect(diffAgainstDefaults({ feed_formula_max_sources: await formulaMaxSources() }))
      .toEqual([]);
  });

  it("a seeded value wins over the fallback", async () => {
    configMock.current = new Map([["feed_formula_max_sources", "12"]]);
    expect(await formulaMaxSources()).toBe(12);
  });

  it("falls back rather than trusting junk in the row", async () => {
    // A non-numeric or non-positive value must not become a cap of NaN or 0 —
    // the first compares false against everything (so the cap never fires) and
    // the second refuses every formula ever published.
    for (const junk of ["", "not-a-number", "0", "-5"]) {
      configMock.current = new Map([["feed_formula_max_sources", junk]]);
      expect(await formulaMaxSources()).toBeGreaterThan(0);
      expect(
        diffAgainstDefaults({ feed_formula_max_sources: await formulaMaxSources() }),
      ).toEqual([]);
    }
  });
});

describe("ingest-heartbeat alert threshold fallback vs config-defaults.sql", () => {
  it("the in-code fallback matches the seeded default", async () => {
    // Same rule, and here the drift would be quiet in the worst direction: the
    // fallback is only reached when the row is missing, which is precisely the
    // freshly-bootstrapped database where nobody has yet learned what a normal
    // tick gap looks like. Too low and the ingest banner cries wolf until it is
    // ignored; too high and it reproduces the 21-hour outage it exists to end.
    const { INGEST_HEARTBEAT_ALERT_SECONDS_FALLBACK } = await import(
      "../src/routes/admin-dashboard.js"
    );
    expect(
      diffAgainstDefaults({
        ingest_heartbeat_alert_seconds: INGEST_HEARTBEAT_ALERT_SECONDS_FALLBACK,
      }),
    ).toEqual([]);
  });
});

describe("dead-job arrival window fallback vs config-defaults.sql", () => {
  it("the in-code fallback matches the seeded default", async () => {
    // Third copy of the same rule (§8.15). This one governs a window rather than
    // an alarm, so a drift is quieter still: nothing errors, nothing goes red,
    // the recent-arrivals figure beside a pile of a thousand rows is simply
    // measured over a period nobody chose.
    const { DEAD_JOB_ARRIVAL_WINDOW_HOURS_FALLBACK } = await import(
      "../src/routes/admin-dashboard.js"
    );
    expect(
      diffAgainstDefaults({
        dead_job_arrival_window_hours: DEAD_JOB_ARRIVAL_WINDOW_HOURS_FALLBACK,
      }),
    ).toEqual([]);
  });
});
