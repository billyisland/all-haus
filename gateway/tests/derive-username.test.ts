import { describe, it, expect, vi, beforeEach } from "vitest";

// =============================================================================
// deriveUsername — what a new member is CALLED.
//
// Every closed-beta account is provisioned by
// `provisionAccount(email, email.split('@')[0])`, so this function alone decides
// the handle, and the welcome sheet then SHOWS it to the member and deliberately
// declines to let them change it there (the 30-day cooldown makes a hasty choice
// expensive). A derived handle is therefore what someone lives with for a month,
// which is why the old `user` floor mattered: `ed@all.haus` produced the literal
// `user`, and the next short address `user-a1b2c3`.
//
// Three claims, and the third is the one that had already shipped broken in
// three different ways:
//   1. a usable display name wins, the email's local part is the fallback;
//   2. a taken base is disambiguated, not reused;
//   3. EVERYTHING RETURNED SATISFIES USERNAME_RE — the rule POST
//      /auth/change-username enforces. A handle outside it is one its owner
//      could never have chosen and cannot retype to keep. The three escapes were
//      a short local part collapsing to `user`, an underscore or leading hyphen
//      surviving from the email, and a 30-char base plus a 7-char suffix
//      overflowing the 30-char maximum.
//
// THE MOCK ANSWERS FROM THE SQL IT IS HANDED (CLAUDE.md). It holds a real set of
// taken usernames and evaluates the route's own `username = $1 OR username LIKE
// $2` against it, reading both params — so a derivation that stopped checking
// availability, or checked the wrong string, fails here instead of passing
// against a fixture. Row objects are rebuilt per call, never shared.
//
// Mutation run is recorded at the foot of this file.
// =============================================================================

let takenUsernames = new Set<string>();
const queries: { sql: string; params: unknown[] }[] = [];

vi.mock("@platform-pub/shared/db/client.js", () => ({
  pool: {
    query: vi.fn(async (sql: string, params: unknown[] = []) => {
      queries.push({ sql, params });
      // Evaluate the actual predicate: `username = $1 OR username LIKE $2`.
      const exact = params[0] as string;
      const likePattern = params[1] as string;
      const prefix = likePattern.replace(/%$/, "");
      const rows = [...takenUsernames]
        .filter((u) => u === exact || u.startsWith(prefix))
        .sort()
        .map((username) => ({ username }));
      return { rows, rowCount: rows.length };
    }),
  },
  withTransaction: vi.fn(),
  loadConfig: vi.fn(async () => ({ freeAllowancePence: 500 })),
}));

vi.mock("../src/lib/key-custody-client.js", () => ({
  generateKeypair: vi.fn(),
}));

const { deriveUsername } = await import("../src/lib/account-provision.js");
const { USERNAME_RE } = await import(
  "@platform-pub/shared/auth/username-rule.js"
);

beforeEach(() => {
  takenUsernames = new Set();
  queries.length = 0;
});

describe("deriveUsername — source of the base", () => {
  it("prefers a usable display name over the email", async () => {
    expect(await deriveUsername("member@example.com", "Billy Island")).toBe(
      "billyisland",
    );
  });

  it("falls back to the email's local part when the display name is unusable", async () => {
    // "Jo" cleans to two characters, under the minimum.
    expect(await deriveUsername("joannawyndham@example.com", "Jo")).toBe(
      "joannawyndham",
    );
  });
});

describe("deriveUsername — the short-address floor (the `user` bug)", () => {
  it("keeps a short local part and disambiguates it, rather than discarding the person", async () => {
    const username = await deriveUsername("ed@all.haus", "ed");
    expect(username).toMatch(/^ed-[0-9a-f]{6}$/);
    expect(username).not.toBe("user");
  });

  it("never hands two short addresses the same handle", async () => {
    const first = await deriveUsername("ed@all.haus", "ed");
    takenUsernames.add(first);
    const second = await deriveUsername("ed@all.haus", "ed");
    expect(second).not.toBe(first);
    expect(second).toMatch(/^ed-[0-9a-f]{6}$/);
  });

  it("falls back to `user` only when there is nothing usable at all — and still suffixes it", async () => {
    // A local part of pure punctuation leaves no characters behind.
    const username = await deriveUsername("...@example.com", "!!!");
    expect(username).toMatch(/^user-[0-9a-f]{6}$/);
  });
});

describe("deriveUsername — availability", () => {
  it("uses the bare base when it is free", async () => {
    takenUsernames.add("someoneelse");
    expect(await deriveUsername("x@y.com", "Josie Dyster")).toBe("josiedyster");
  });

  it("suffixes a taken base", async () => {
    takenUsernames.add("josiedyster");
    const username = await deriveUsername("x@y.com", "Josie Dyster");
    expect(username).toMatch(/^josiedyster-[0-9a-f]{6}$/);
  });

  it("does not collide with an existing suffixed handle", async () => {
    takenUsernames.add("josiedyster");
    // Every 6-hex value but one is already taken, so the loop must find the gap
    // rather than returning its first draw.
    const survivor = "josiedyster-abcdef";
    for (let i = 0; i < 4096; i++) {
      const candidate = `josiedyster-${i.toString(16).padStart(6, "0")}`;
      if (candidate !== survivor) takenUsernames.add(candidate);
    }
    const username = await deriveUsername("x@y.com", "Josie Dyster");
    expect(takenUsernames.has(username)).toBe(false);
  });

  it("reads availability with BOTH the exact base and its suffix prefix", async () => {
    await deriveUsername("x@y.com", "Josie Dyster");
    expect(queries).toHaveLength(1);
    expect(queries[0].params[0]).toBe("josiedyster");
    expect(queries[0].params[1]).toBe("josiedyster-%");
  });
});

describe("deriveUsername — everything it returns is a legal username", () => {
  const cases: [string, string][] = [
    ["ed@all.haus", "ed"],
    ["a_b@example.com", ""],
    ["-ed-@example.com", "-"],
    ["...@example.com", "!!!"],
    ["member@example.com", "Billy Island"],
    ["x@y.com", "Ünïcödé Nåme"],
    [`${"a".repeat(40)}@example.com`, ""],
    [`${"b".repeat(40)}@example.com`, "C".repeat(40)],
    ["under_score@example.com", ""],
  ];

  it.each(cases)("%s / %s satisfies USERNAME_RE", async (email, display) => {
    const username = await deriveUsername(email, display);
    expect(username).toMatch(USERNAME_RE);
    expect(username.length).toBeLessThanOrEqual(30);
  });

  it("keeps a suffixed 30-character base inside the limit", async () => {
    const long = "c".repeat(40);
    takenUsernames.add(long.slice(0, 30));
    const username = await deriveUsername("x@y.com", long);
    // 30-char base + "-abc123" would be 37. It must truncate instead.
    expect(username.length).toBeLessThanOrEqual(30);
    expect(username).toMatch(USERNAME_RE);
  });

  it("strips an underscore rather than minting a handle nobody could retype", async () => {
    const username = await deriveUsername("a_b_c@example.com", "");
    expect(username).not.toContain("_");
    expect(username).toMatch(USERNAME_RE);
  });

  it("never leaves a hyphen at either end", async () => {
    const username = await deriveUsername("-ed-@example.com", "");
    expect(username.startsWith("-")).toBe(false);
    expect(username.endsWith("-")).toBe(false);
    expect(username).toMatch(USERNAME_RE);
  });
});

// -----------------------------------------------------------------------------
// MUTATION RUN (2026-08-11) — reverting each part of the fix in turn:
//   · restore the `user` literal floor  → 3 fail (the two short-address cases
//     and the `ed@all.haus` USERNAME_RE case still passes, correctly — `user`
//     IS a legal username; that is exactly why the bug was invisible, and why
//     the short-address tests assert the handle rather than only its legality)
//   · keep `_` in the character class    → 3 fail (both underscore legality
//     cases and the explicit strip test)
//   · drop the leading/trailing trim     → 2 fail (hyphen cases)
//   · slice the base to 30 before suffix → 1 fail (the 30-char overflow case)
//   · drop the availability read         → 2 fail (taken-base + params cases)
// -----------------------------------------------------------------------------
