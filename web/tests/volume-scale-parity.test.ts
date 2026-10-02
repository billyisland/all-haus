import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { VOLUME_THROUGHPUT, throughputToStep, stepPercent } from "../src/lib/volume-scale";

// =============================================================================
// The web's volume scale must equal the gateway's.
//
// The number in this array IS the fraction stored in feed_sources.throughput —
// the bar does not send a step and let the server decide, it sends a step that
// the server maps with ITS copy of the same array. Drift is silent: the bar
// renders one thing, the query selects another, and nothing anywhere errors.
//
// Reads the gateway source rather than importing it, because there is no module
// path between the two workspaces. That is also why this test has to exist.
// =============================================================================

const GATEWAY = join(__dirname, "../../gateway/src/routes/feeds/shared.ts");

describe("volume scale parity with the gateway", () => {
  it("is the same five steps the gateway maps", () => {
    const src = readFileSync(GATEWAY, "utf8");
    const m = src.match(/VOLUME_THROUGHPUT\s*=\s*\[([^\]]+)\]/);
    // Assert we actually FOUND it: a renamed constant would otherwise make this
    // suite pass by testing nothing, which is the failure it exists to catch.
    expect(m, "gateway VOLUME_THROUGHPUT not found — was it renamed?").toBeTruthy();
    const gateway = m![1].split(",").map((n) => Number(n.trim()));
    expect(gateway).toEqual(VOLUME_THROUGHPUT);
  });

  it("round-trips every committed step", () => {
    for (let s = 1; s <= 5; s++) {
      expect(throughputToStep(VOLUME_THROUGHPUT[s])).toBe(s);
    }
  });

  it("reads back a hand-edited value as the nearest step", () => {
    expect(throughputToStep(0.55)).toBe(3); // 0.6
    expect(throughputToStep(0.95)).toBe(5); // 1.0
  });

  it("renders the percentage the reader is being promised", () => {
    expect(stepPercent(1)).toBe("20%");
    expect(stepPercent(3)).toBe("60%");
    expect(stepPercent(5)).toBe("100%");
  });
});
