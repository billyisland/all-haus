import { describe, it, expect } from "vitest";
import fs from "fs";
import {
  externalEExpr,
  nativeEExpr,
  nativeEngagementJoins,
  EXTERNAL_RESONANCE_SQL,
  NATIVE_RESONANCE_SQL,
} from "../src/lib/resonance.js";

// =============================================================================
// §0h.6 — E must be the same formula in both modules.
//
// E is computed twice: engagement-baseline-refresh.ts builds the reference
// distribution, resonance.ts divides by it. Numerator and denominator of one
// ratio, in separate files, previously as two independent copies of the same
// arithmetic.
//
// The failure mode is what makes this worth a test. A term added, dropped or
// reweighted on one side throws nothing and breaks no type. It scores every
// post against a distribution built from a different formula, and surfaces as
// bands that look mis-tuned — which sends the next person to retune the band
// gates, i.e. to compensate for the drift by bending the thing that wasn't
// wrong. The ADR's own D2a lesson, one level up.
//
// The expression now lives in one builder, so most of this is a structural
// guard: it fails if anyone inlines a copy again, which is exactly how the
// duplication arose the first time.
// =============================================================================

const SRC = (p: string) => fs.readFileSync(new URL(p, import.meta.url), "utf8");
const BASELINE_SRC = "../src/tasks/engagement-baseline-refresh.ts";
const SCORER_SRC = "../src/lib/resonance.ts";

describe("resonance E — one formula, two modules", () => {
  it("external E is like + reply + repost, in that weighting order", () => {
    expect(externalEExpr("$1", "$2", "$3")).toBe(
      "(ei.like_count * $1 + ei.reply_count * $2 + ei.repost_count * $3)::numeric",
    );
  });

  it("native E is up + gate + reply, in that weighting order", () => {
    expect(nativeEExpr("$1", "$2", "$3", "r")).toBe(
      "(COALESCE(v.up, 0) * $1 + COALESCE(g.passes, 0) * $2 + COALESCE(r.replies, 0) * $3)::numeric",
    );
  });

  // The reply LATERAL is joined under different aliases in the two callers
  // (`r` baseline, `rp` scorer, which already uses `r` for its results CTE).
  // Threading the alias is what let one expression serve both; pin it, since a
  // hardcoded alias would force the next person to fork the builder.
  it("native joins honour the caller's reply alias", () => {
    expect(nativeEngagementJoins("rp")).toContain(") rp ON true");
    expect(nativeEngagementJoins("r")).toContain(") r ON true");
    expect(nativeEngagementJoins("rp")).not.toContain(") r ON true");
  });

  it("the scorer's SQL is built from the shared expression", () => {
    expect(EXTERNAL_RESONANCE_SQL).toContain(externalEExpr("$2", "$3", "$4"));
    expect(NATIVE_RESONANCE_SQL).toContain(nativeEExpr("$2", "$3", "$4", "rp"));
  });

  // The structural half: neither module may carry an inline copy. These
  // patterns match the arithmetic itself, not the builder call, so they fire on
  // a re-inlined formula in either file.
  it("neither module inlines its own E arithmetic", () => {
    for (const p of [BASELINE_SRC, SCORER_SRC]) {
      const src = SRC(p);
      const inlineExternal = /ei\.like_count\s*\*\s*\$\d/.test(src);
      const inlineNative = /COALESCE\(v\.up,\s*0\)\s*\*\s*\$\d/.test(src);
      expect(
        { file: p, inlineExternal, inlineNative },
        `${p} inlines an E formula — it must call the shared builder`,
      ).toEqual({ file: p, inlineExternal: false, inlineNative: false });
    }
  });

  it("the baseline cron imports the builders rather than redefining them", () => {
    const src = SRC(BASELINE_SRC);
    expect(src).toMatch(/import\s*\{[^}]*externalEExpr[^}]*\}\s*from\s*"\.\.\/lib\/resonance\.js"/s);
    expect(src).toContain("nativeEExpr");
    expect(src).toContain("nativeEngagementJoins");
  });
});

// =============================================================================
// Population divergence — KNOWN, deliberately unchanged, tracked as a decision.
//
// The two modules select different row populations, and unlike the formula this
// is NOT obviously a bug to be closed:
//
//   baseline  external: fi.deleted_at IS NULL AND ei.deleted_at IS NULL
//                       AND ei.is_context_only = false  (+ protocol, age window)
//   scorer    external: fi.deleted_at IS NULL  (+ the caller's explicit id set)
//
// So the scorer bands context-only rows that the baseline excluded from the
// distribution. Reachable: external-engagement-refresh selects on
// `deleted_at IS NULL` without an is_context_only filter.
//
// Why it is not "fixed" here: context-only rows are hidden from FEED queries
// but are visible in threads and on hydrated profile timelines, so excluding
// them from scoring would leave visible posts with no band. Which population is
// correct is a product question for the ADR owner, and the glyph is dark
// (RESONANCE_GLYPH_ENABLED=0), so nothing is user-visible either way today.
// Changing scoring population unmeasured, while dark, is precisely what the
// dial discipline warns against.
//
// This test pins the CURRENT divergence so it cannot change silently — if
// someone aligns the populations deliberately, this fails and they update it
// along with the ADR. Tracked in CONSOLIDATED-TODO §0h.6.
// =============================================================================
describe("resonance E — population divergence is deliberate and pinned", () => {
  it("the scorer does not filter context-only rows (baseline does)", () => {
    expect(EXTERNAL_RESONANCE_SQL).not.toContain("is_context_only");
    expect(SRC(BASELINE_SRC)).toContain("ei.is_context_only = false");
  });
});
