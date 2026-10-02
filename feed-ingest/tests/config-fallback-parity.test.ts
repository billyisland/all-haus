import { describe, it, expect, vi, beforeEach } from "vitest";
import { diffAgainstDefaults } from "@platform-pub/shared/db/config-defaults-parse.js";

// =============================================================================
// §0h.7 — the in-code config fallbacks must match config-defaults.sql.
//
// Every tuning dial is read as `num(key, fallback)`, so each fallback is a
// second copy of a number whose canonical home is config-defaults.sql. Nothing
// held the two in step. That is the masking mechanism 1d6b756 diagnosed, one
// level up: a fallback substitutes silently for a dial that is absent or
// misspelled, so the system runs on a value no operator can see or tune — and
// because the substitution is silent, the symptom is never "config is broken",
// it is "the numbers look a bit off".
//
// The resonance weights make the stakes concrete. They are used in two places:
// the baseline cron (which builds the denominator distribution) and the scorer
// (which computes each post's ratio against it). A weight that drifted between
// the fallback and the seeded value would not error anywhere. It would score
// every post against a distribution built from a different formula, and the
// only visible effect would be bands that seem mis-tuned — sending someone off
// to retune the band gates, which are not the problem.
//
// This drives the REAL loader with an empty config, so it asserts the shipping
// fallback path rather than a copy of the table.
// =============================================================================

const configMock = { current: new Map<string, string>() };
vi.mock("../src/lib/platform-config.js", () => ({
  getPlatformConfig: async () => configMock.current,
}));

// loadFeedWeights (feed-scores-refresh) reads `platform_config` through the
// POOL rather than getPlatformConfig, so the mock above does not reach it. Its
// own mock is what makes its block below drive the fallback path instead of
// whatever the live database happens to hold — which is the difference between
// pinning the shipping fallback and pinning the seed data.
const poolRows = { current: [] as { key: string; value: string }[] };
vi.mock("@platform-pub/shared/db/client.js", () => ({
  pool: { query: async () => ({ rows: poolRows.current, rowCount: poolRows.current.length }) },
}));

const { loadResonanceParams } = await import("../src/lib/resonance.js");

describe("resonance fallbacks vs config-defaults.sql", () => {
  beforeEach(() => {
    // Empty config → every read falls through to its in-code fallback.
    configMock.current = new Map();
  });

  it("every fallback matches the seeded default", async () => {
    const p = await loadResonanceParams();
    const bad = diffAgainstDefaults({
      resonance_weight_like: p.like,
      resonance_weight_reply: p.reply,
      resonance_weight_repost: p.repost,
      resonance_weight_native_up: p.nativeUp,
      resonance_weight_native_gate: p.nativeGate,
      resonance_shrink_k: p.k,
      resonance_band1_min: p.band1,
      resonance_band2_min: p.band2,
      resonance_band3_min: p.band3,
    });
    expect(bad).toEqual([]);
  });

  it("a seeded value wins over the fallback", async () => {
    // Guards the other direction: if the fallback ever shadowed a present row,
    // the parity test above would still pass while operators lost all control.
    configMock.current = new Map([["resonance_band3_min", "9.5"]]);
    const p = await loadResonanceParams();
    expect(p.band3).toBe(9.5);
  });

  it("the baseline cron reads the scorer's loader, not its own copy", async () => {
    // The two used to declare the five weights independently. Pin that they
    // now come from one place — a re-split would silently reintroduce the
    // denominator/numerator formula mismatch described above.
    const src = await import("node:fs").then((fs) =>
      fs.readFileSync(
        new URL("../src/tasks/engagement-baseline-refresh.ts", import.meta.url),
        "utf8",
      ),
    );
    expect(src).toContain("loadResonanceParams");
    expect(src).not.toMatch(/num\(\s*"resonance_weight_/);
  });
});

describe("jetstream replay cap fallback vs config-defaults.sql", () => {
  beforeEach(() => {
    configMock.current = new Map();
  });

  it("the in-code fallback matches the seeded default", async () => {
    const { loadMaxReplayHours } = await import("../src/jetstream/listener.js");
    expect(
      diffAgainstDefaults({
        feed_ingest_atproto_max_replay_hours: await loadMaxReplayHours(),
      }),
    ).toEqual([]);
  });

  it("a retuned value wins, and junk does not", async () => {
    const { loadMaxReplayHours } = await import("../src/jetstream/listener.js");
    configMock.current = new Map([["feed_ingest_atproto_max_replay_hours", "6"]]);
    expect(await loadMaxReplayHours()).toBe(6);
    // 0 or negative would resume from now or the future — the silent-stream
    // state — so they must fall back rather than be honoured.
    for (const junk of ["", "nope", "0", "-3"]) {
      configMock.current = new Map([["feed_ingest_atproto_max_replay_hours", junk]]);
      expect(await loadMaxReplayHours()).toBe(24);
    }
  });
});

describe("feed-score weight fallbacks vs config-defaults.sql", () => {
  beforeEach(() => {
    poolRows.current = [];
  });

  // These five moved here on 2026-09-14. `feed_gravity` used to be parity-tested
  // through the gateway's loadProofBlendParams, which stopped reading it when the
  // age decay went with feed-level ranking (migration 202) — and the four
  // feed_weight_* dials had never been covered anywhere. loadFeedWeights is the
  // shipping fallback path for all five, so it is where they belong.
  it("every feed-score fallback matches the seeded default", async () => {
    const { loadFeedWeights } = await import("../src/tasks/feed-scores-refresh.js");
    const w = await loadFeedWeights();
    expect(
      diffAgainstDefaults({
        feed_gravity: w.gravity,
        feed_weight_reaction: w.reaction,
        feed_weight_reply: w.reply,
        feed_weight_quote_comment: w.quoteComment,
        feed_weight_gate_pass: w.gatePass,
      }),
    ).toEqual([]);
  });

  it("a retuned value wins over the fallback", async () => {
    const { loadFeedWeights } = await import("../src/tasks/feed-scores-refresh.js");
    poolRows.current = [{ key: "feed_gravity", value: "2.25" }];
    expect((await loadFeedWeights()).gravity).toBe(2.25);
  });
});

describe("linked-notification dial fallbacks vs config-defaults.sql", () => {
  // CROSS-NETWORK-ROUNDTRIP-ADR rung C. Driven through `dialInt`, the poll
  // task's own reader, against an empty table — the shipping fallback path.
  it("every fallback matches the seeded default, a seeded value wins, a malformed one falls back", async () => {
    const { dialInt } = await import("../src/tasks/linked-notifications-poll.js");
    const empty = new Map<string, string>();
    expect(
      diffAgainstDefaults({
        linked_notifications_poll_seconds: dialInt(empty, "linked_notifications_poll_seconds"),
        linked_notifications_backfill_hours: dialInt(empty, "linked_notifications_backfill_hours"),
      }),
    ).toEqual([]);
    expect(dialInt(new Map([["linked_notifications_poll_seconds", "120"]]), "linked_notifications_poll_seconds")).toBe(120);
    expect(dialInt(new Map([["linked_notifications_poll_seconds", "5 min"]]), "linked_notifications_poll_seconds")).toBe(300);
  });
});
