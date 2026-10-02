import { describe, it, expect } from "vitest";
import { isUuid, parseLimit, parseOffset } from "../src/lib/request-inputs.js";

// =============================================================================
// The two shapes that 500 the gateway.
//
// `Math.min(parseInt(raw, 10), cap)` — the spelling at ~30 sites — is NaN for
// `?limit=x` and NEGATIVE for `?limit=-1`, and both reach `LIMIT $n` and raise.
// The `|| DEFAULT` variant covers only the first: `parseInt("-5")` is `-5`,
// which is truthy, so the fallback never fires. Both are pinned below, because
// the negative case is the one every existing site thought it had handled.
//
// The uuid half is thinner on purpose — `lib/uuid.ts` owns the regex, and what
// is added here is the `typeof` guard, which is what stops `UUID_RE.test(
// undefined)` stringifying its argument into a refusal-that-looks-like-a-check.
// =============================================================================

describe("parseLimit", () => {
  it("takes a valid limit and caps it", () => {
    expect(parseLimit("10", 20, 50)).toBe(10);
    expect(parseLimit("999", 20, 50)).toBe(50);
    expect(parseLimit("50", 20, 50)).toBe(50);
  });

  it("falls back rather than refusing — a limit is a client hint", () => {
    expect(parseLimit(undefined, 20, 50)).toBe(20);
    expect(parseLimit(null, 20, 50)).toBe(20);
    expect(parseLimit("", 20, 50)).toBe(20);
    expect(parseLimit("abc", 20, 50)).toBe(20);
    expect(parseLimit("NaN", 20, 50)).toBe(20);
  });

  it("falls back on a NEGATIVE limit — the case `|| DEFAULT` misses", () => {
    // `parseInt("-5", 10)` is -5, which is truthy, so every site spelled
    // `parseInt(x) || DEFAULT` passed -5 through to `LIMIT -5`.
    expect(parseLimit("-5", 20, 50)).toBe(20);
    expect(parseLimit("-1", 20, 50)).toBe(20);
    expect(parseLimit("0", 20, 50)).toBe(20);
  });

  it("never returns NaN or a non-integer, whatever it is handed", () => {
    for (const raw of ["1e999", "Infinity", "-Infinity", "1.9", " 7 ", "7px", "0x10"]) {
      const n = parseLimit(raw, 20, 50);
      expect(Number.isInteger(n), raw).toBe(true);
      expect(n >= 1 && n <= 50, raw).toBe(true);
    }
  });
});

describe("parseOffset", () => {
  it("takes a valid offset, including zero", () => {
    expect(parseOffset("0")).toBe(0);
    expect(parseOffset("40")).toBe(40);
  });

  it("floors at zero and caps the far end", () => {
    // An offset of 1e12 is not a position, it is a sequential scan somebody
    // typed. Same reason the cursor codec range-clamps its epoch.
    expect(parseOffset("-1")).toBe(0);
    expect(parseOffset("abc")).toBe(0);
    expect(parseOffset(undefined)).toBe(0);
    expect(parseOffset("999999999")).toBe(100_000);
    expect(parseOffset("999999999", 1000)).toBe(1000);
  });
});

describe("isUuid", () => {
  it("accepts what this platform mints, either case", () => {
    expect(isUuid("3f2504e0-4f89-11d3-9a0c-0305e82c3301")).toBe(true);
    expect(isUuid("3F2504E0-4F89-11D3-9A0C-0305E82C3301")).toBe(true);
  });

  it("refuses the values Postgres would raise on", () => {
    for (const raw of [
      "",
      "not-a-uuid",
      "------------------------------------", // 36 chars, right class, still a cast error
      "3f2504e04f8911d39a0c0305e82c3301", // unhyphenated: Postgres takes it, we do not
      "{3f2504e0-4f89-11d3-9a0c-0305e82c3301}",
      "3f2504e0-4f89-11d3-9a0c-0305e82c3301 ",
      "3f2504e0-4f89-11d3-9a0c-0305e82c3301'; SELECT 1",
    ]) {
      expect(isUuid(raw), raw).toBe(false);
    }
  });

  it("refuses a non-string instead of stringifying it", () => {
    // The half `UUID_RE.test(x)` gets wrong: `.test` coerces, so a value that
    // is not a string at all can still be compared against the pattern.
    expect(isUuid(undefined)).toBe(false);
    expect(isUuid(null)).toBe(false);
    expect(isUuid(42)).toBe(false);
    expect(isUuid(["3f2504e0-4f89-11d3-9a0c-0305e82c3301"])).toBe(false);
  });
});
