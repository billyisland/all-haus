import { describe, it, expect, vi } from "vitest";

// These task modules import the shared pool / logger (and platform-config,
// which reads the pool) at top level; the pure helpers under test don't touch
// the DB, so stub the modules so importing them doesn't reach for a connection.
vi.mock("@platform-pub/shared/db/client.js", () => ({
  pool: {},
  withTransaction: vi.fn(),
}));
vi.mock("@platform-pub/shared/lib/logger.js", () => ({
  default: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

const { nextRssInterval } = await import("./feed-ingest-rss.js");
const { engagementLookbackHours } = await import(
  "./external-engagement-refresh.js"
);

const BOUNDS = { min: 120, max: 3600, up: 1.5, down: 0.5 };

describe("nextRssInterval (B5)", () => {
  it("backs off when there were no new items (304 / quiet feed)", () => {
    expect(nextRssInterval(300, false, BOUNDS)).toBe(450);
  });

  it("tightens when there were new items (active feed)", () => {
    expect(nextRssInterval(300, true, BOUNDS)).toBe(150);
  });

  it("clamps to the minimum", () => {
    // 200 * 0.5 = 100 → clamped up to 120
    expect(nextRssInterval(200, true, BOUNDS)).toBe(120);
  });

  it("clamps to the maximum", () => {
    // 3000 * 1.5 = 4500 → clamped down to 3600
    expect(nextRssInterval(3000, false, BOUNDS)).toBe(3600);
  });

  it("falls back to the 300s default base when current is missing", () => {
    expect(nextRssInterval(null, false, BOUNDS)).toBe(450);
    expect(nextRssInterval(undefined, false, BOUNDS)).toBe(450);
    expect(nextRssInterval(0, false, BOUNDS)).toBe(450);
  });

  it("converges quiet feeds toward max and active feeds toward min", () => {
    let quiet = 300;
    for (let i = 0; i < 20; i++) quiet = nextRssInterval(quiet, false, BOUNDS);
    expect(quiet).toBe(3600);

    let active = 3600;
    for (let i = 0; i < 20; i++)
      active = nextRssInterval(active, true, BOUNDS);
    expect(active).toBe(120);
  });
});

describe("engagementLookbackHours (B6)", () => {
  // Use explicit UTC instants so the test is timezone-independent.
  const at = (utc: string) => new Date(utc);

  it("touches only the <6h tier on a :30 run", () => {
    expect(engagementLookbackHours(at("2026-06-04T13:30:00Z"))).toBe(6);
    expect(engagementLookbackHours(at("2026-06-04T09:45:00Z"))).toBe(6);
  });

  it("sweeps the <24h tier on a top-of-hour run", () => {
    expect(engagementLookbackHours(at("2026-06-04T13:00:00Z"))).toBe(24);
    expect(engagementLookbackHours(at("2026-06-04T13:14:00Z"))).toBe(24);
  });

  it("sweeps the full <7d window on the daily run (04:00 UTC)", () => {
    expect(engagementLookbackHours(at("2026-06-04T04:00:00Z"))).toBe(7 * 24);
    expect(engagementLookbackHours(at("2026-06-04T04:10:00Z"))).toBe(7 * 24);
  });

  it("does not run the daily sweep off the top of the daily hour", () => {
    // 04:30 is past the top-of-hour window → back to the <6h tier.
    expect(engagementLookbackHours(at("2026-06-04T04:30:00Z"))).toBe(6);
  });
});
