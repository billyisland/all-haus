import { describe, it, expect, vi, beforeEach } from "vitest";
import fs from "node:fs";
import path from "node:path";
import { diffAgainstDefaults } from "@platform-pub/shared/db/config-defaults-parse.js";

// =============================================================================
// The FEED-RANKING weights' in-code fallbacks must match config-defaults.sql.
//
// Third family of dials in this repo and the last one with no parity suite —
// the resonance weights next door have one, `loadConfig`'s money dials have
// one, and these five did not. The failure is the same and is silent in the
// same way: the fallback substitutes exactly when the row is absent, which is
// the one case it exists for, so a drifted number never errors. It just ranks
// the feed by a formula no operator can see, and the visible effect is "the
// ordering seems off" — which sends somebody to retune the weights that are
// not the problem.
//
// Drives the REAL loader against an empty table.
// =============================================================================

const rowsMock = { current: [] as Array<{ key: string; value: string }> };
vi.mock("@platform-pub/shared/db/client.js", () => ({
  pool: { query: async () => ({ rows: rowsMock.current }) },
}));

const { loadFeedWeights } = await import("../src/tasks/feed-scores-refresh.js");

describe("feed-ranking fallbacks vs config-defaults.sql", () => {
  beforeEach(() => {
    rowsMock.current = [];
  });

  it("every fallback matches the seeded default", async () => {
    const w = await loadFeedWeights();
    const bad = diffAgainstDefaults({
      feed_gravity: w.gravity,
      feed_weight_reaction: w.reaction,
      feed_weight_reply: w.reply,
      feed_weight_quote_comment: w.quoteComment,
      feed_weight_gate_pass: w.gatePass,
    });
    expect(bad).toEqual([]);
  });

  it("a seeded value wins over the fallback", async () => {
    // The other direction: a fallback that shadowed a present row would pass
    // the parity test above while leaving the dials untunable — which is the
    // failure they exist to prevent, not a variant of it.
    rowsMock.current = [{ key: "feed_gravity", value: "2.25" }];
    expect((await loadFeedWeights()).gravity).toBe(2.25);
  });

  it("covers every dial the loader reads", async () => {
    // The parity map above is hand-written, so a sixth weight added to the
    // loader without a line here would ship unchecked — the exact gap the
    // sibling suites were split out to close.
    const src = fs.readFileSync(
      path.resolve(__dirname, "../src/tasks/feed-scores-refresh.ts"),
      "utf8",
    );
    const read = [...src.matchAll(/map\.get\('([a-z0-9_]+)'\)/g)].map((m) => m[1]);
    expect(read.sort()).toEqual(
      [
        "feed_gravity",
        "feed_weight_gate_pass",
        "feed_weight_quote_comment",
        "feed_weight_reaction",
        "feed_weight_reply",
      ].sort(),
    );
  });
});
