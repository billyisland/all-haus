import { describe, it, expect } from "vitest";
import {
  HANDLE_RE,
  mentionCandidates,
  resolveMentionedAccountIds,
} from "../src/lib/mentions.js";
import { USERNAME_RE } from "@platform-pub/shared/auth/username-rule.js";

// =============================================================================
// @mention scanning agrees with the username rule, and resolves to the WHOLE
// handle or to nobody.
//
// The bug this pins is not a miss, it is a MISDELIVERY: the old scan stopped at
// a hyphen, so `@blue-a1b2c3` — the exact shape `deriveUsername` mints when a
// name collides — captured `blue` and notified the account the handle was
// disambiguated from. The tests that matter are therefore the ones asserting
// WHO, not how many: a scan that notified nobody would have been a nuisance,
// and one that notified the neighbour is a stranger reading a conversation they
// were not named in.
//
// Mutation-proved, six ways: restoring `[a-zA-Z0-9_]` as the capture class
// fails 6 (including both misdelivery tests); letting the walk step past a
// non-active row fails "never falls back past a handle that is taken";
// dropping the `toLowerCase` fails the two capitalised cases; dropping the
// address lookbehind fails 3; narrowing `HANDLE_RE` back to the MINT rule fails
// 2; and dropping the underscore from the capture class fails the legacy case.
// =============================================================================

const BLUE = "00000000-0000-4000-8000-00000000b10e";
const BLUE_A1B2C3 = "00000000-0000-4000-8000-00000000b1a1";
const HERON = "00000000-0000-4000-8000-0000000048e2";
const LEGACY = "00000000-0000-4000-8000-000000001e6a";
const AUTHOR = "00000000-0000-4000-8000-000000000a17";

type Row = { id: string; username: string; status: string };

const DIRECTORY: Row[] = [
  { id: BLUE, username: "blue", status: "active" },
  { id: BLUE_A1B2C3, username: "blue-a1b2c3", status: "active" },
  { id: HERON, username: "heron", status: "active" },
  // A handle no CURRENT path can mint: interior underscore, from before the
  // username rule was hoisted into one home. Real rows look like this.
  { id: LEGACY, username: "wren_pascoe", status: "active" },
  { id: AUTHOR, username: "author", status: "active" },
];

// Answers FROM THE SQL's parameter, not from a fixture: the route asks for a
// set of candidate handles and gets back exactly the ones this directory has.
function clientOver(directory: Row[]) {
  const seen: unknown[][] = [];
  return {
    seen,
    query: async <R extends Record<string, unknown>>(
      sql: string,
      params: unknown[] = [],
    ): Promise<{ rows: R[] }> => {
      seen.push(params);
      expect(sql).toContain("FROM accounts");
      const asked = new Set(params[0] as string[]);
      return {
        rows: directory.filter((r) => asked.has(r.username)) as unknown as R[],
      };
    },
  };
}

async function notified(content: string, directory: Row[] = DIRECTORY) {
  return resolveMentionedAccountIds(clientOver(directory), content, AUTHOR);
}

describe("mentionCandidates", () => {
  it("keeps a disambiguating suffix, longest first", () => {
    expect(mentionCandidates("hello @blue-a1b2c3")).toEqual([
      ["blue-a1b2c3", "blue"],
    ]);
  });

  it("offers shorter prefixes when the token runs into prose", () => {
    expect(mentionCandidates("ask @blue-please-look")).toEqual([
      ["blue-please-look", "blue-please", "blue"],
    ]);
  });

  it("drops a trailing hyphen rather than carrying it into the lookup", () => {
    expect(mentionCandidates("@heron- said so")).toEqual([["heron"]]);
  });

  it("folds case, because handles are stored lowercase", () => {
    expect(mentionCandidates("@BlueJay")).toEqual([["bluejay"]]);
  });

  it("offers nothing shorter than a handle can be", () => {
    // `ed` is two characters: USERNAME_RE floors at three, so the walk must not
    // offer it as the fallback for `@ed-a1b2c3`.
    expect(mentionCandidates("@ed-a1b2c3")).toEqual([["ed-a1b2c3"]]);
  });

  it("ignores an @ inside an address", () => {
    expect(mentionCandidates("write to reader@blue.example")).toEqual([]);
    expect(mentionCandidates("reader_tag@heron.example")).toEqual([]);
    expect(mentionCandidates("reader+tag@heron.example")).toEqual([]);
    expect(mentionCandidates("blue.heron@post.example")).toEqual([]);
  });

  it("hears both halves of a run-together pair", () => {
    // `@heron-@blue` is the case that kept the lookbehind narrow — see the
    // module header. The first token sheds its trailing hyphen; the second is
    // still a mention.
    expect(mentionCandidates("@heron-@blue")).toEqual([["heron"], ["blue"]]);
  });

  it("reads the handle out of a NIP-05 spelling and not the domain", () => {
    expect(mentionCandidates("@heron@all.haus")).toEqual([["heron"]]);
  });

  it("counts a repeated mention once", () => {
    expect(mentionCandidates("@heron and @heron again")).toEqual([["heron"]]);
  });
});

describe("the lookup rule is the MINT rule widened, and stays that way", () => {
  // The relationship is the thing, not either regex: the scan searches a COLUMN,
  // and the column holds everything the mint rule permits plus what older rules
  // once did. A mint rule relaxed without widening this fails here rather than
  // going quiet, which is what a comment could not do.
  it.each([
    "abc",
    "a1b",
    "blue-a1b2c3",
    "a".repeat(30),
    "a" + "-".repeat(28) + "b",
  ])("%s — legal to mint, therefore legal to find", (handle) => {
    expect(USERNAME_RE.test(handle)).toBe(true);
    expect(HANDLE_RE.test(handle)).toBe(true);
  });

  it("accepts the legacy underscore the mint rule refuses", () => {
    expect(USERNAME_RE.test("wren_pascoe")).toBe(false);
    expect(HANDLE_RE.test("wren_pascoe")).toBe(true);
  });

  it("refuses what neither would ever hold", () => {
    for (const bad of ["ab", "-abc", "abc-", "_abc", "abc_", "a".repeat(31)]) {
      expect(HANDLE_RE.test(bad)).toBe(false);
    }
  });

  it("is the mint rule widened BY EXACTLY ONE CHARACTER — pinned structurally", () => {
    // FIVE SAMPLES CANNOT PIN A SUPERSET. Relax `USERNAME_RE` to admit a dot,
    // or lift its cap from 30 to 40, and every sample above still satisfies
    // both — so the relationship the section is named for would go on reading
    // as proved while a newly-mintable handle became unfindable, which is the
    // `36c48876` class exactly. The relationship is structural, so the pin is:
    // HANDLE_RE is USERNAME_RE's source with the legacy underscore added to
    // its one character class and nothing else touched.
    expect(HANDLE_RE.source).toBe(
      USERNAME_RE.source.replace("[a-z0-9-]", "[a-z0-9_-]"),
    );
    // And the replacement really fired — a `USERNAME_RE` whose class had been
    // rewritten would make the line above compare a string with itself.
    expect(USERNAME_RE.source).toContain("[a-z0-9-]");
    expect(HANDLE_RE.source).not.toBe(USERNAME_RE.source);
    // Same flags, or one is case-sensitive and the other is not.
    expect(HANDLE_RE.flags).toBe(USERNAME_RE.flags);
  });

  it("finds every handle the mint rule can produce — generated, not sampled", () => {
    // The samples say "these five are fine". This says "everything the mint
    // rule accepts, this scan accepts", over a spread that walks both bounds
    // and every position an interior character can take.
    const alphabet = "abcdefghijklmnopqrstuvwxyz0123456789-";
    const cases: string[] = [];
    for (let len = 3; len <= 30; len++) {
      for (const mid of alphabet) {
        cases.push("a" + mid.repeat(Math.max(0, len - 2)) + "z");
      }
    }
    const mintable = cases.filter((c) => USERNAME_RE.test(c));
    // A generator that produced nothing mintable would pass the loop below by
    // testing nothing at all.
    expect(mintable.length).toBeGreaterThan(300);
    for (const handle of mintable) {
      expect(HANDLE_RE.test(handle), handle).toBe(true);
    }
  });
});

describe("resolveMentionedAccountIds", () => {
  it("notifies a legacy handle an older rule minted", async () => {
    await expect(notified("morning @wren_pascoe")).resolves.toEqual([LEGACY]);
  });

  it("notifies the disambiguated account, not the account it is like", async () => {
    await expect(notified("nice piece @blue-a1b2c3")).resolves.toEqual([
      BLUE_A1B2C3,
    ]);
  });

  it("walks down to a real handle when the token ran into prose", async () => {
    await expect(notified("ask @blue-please-look")).resolves.toEqual([BLUE]);
  });

  it("never falls back past a handle that is taken", async () => {
    // `blue-a1b2c3` exists and is silent. The walk STOPS there: notifying
    // `blue` instead is the original bug wearing a fallback.
    const directory = DIRECTORY.map((r) =>
      r.username === "blue-a1b2c3" ? { ...r, status: "suspended" } : r,
    );
    await expect(notified("@blue-a1b2c3 where are you", directory)).resolves.toEqual(
      [],
    );
  });

  it("notifies a capitalised mention", async () => {
    await expect(notified("morning @Heron")).resolves.toEqual([HERON]);
  });

  it("does not notify the author of their own mention", async () => {
    await expect(notified("as @author I say")).resolves.toEqual([]);
  });

  it("does not notify an address", async () => {
    await expect(notified("mail reader@heron.example")).resolves.toEqual([]);
  });

  it("asks for every candidate in one query", async () => {
    const client = clientOver(DIRECTORY);
    await resolveMentionedAccountIds(
      client,
      "@blue-please-look and @heron",
      AUTHOR,
    );
    expect(client.seen).toHaveLength(1);
    expect(client.seen[0][0]).toEqual([
      "blue-please-look",
      "blue-please",
      "blue",
      "heron",
    ]);
  });

  it("asks nothing at all when there is no mention", async () => {
    const client = clientOver(DIRECTORY);
    await resolveMentionedAccountIds(client, "no handles here", AUTHOR);
    expect(client.seen).toHaveLength(0);
  });
});
