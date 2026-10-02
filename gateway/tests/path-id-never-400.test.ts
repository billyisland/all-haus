import { describe, it, expect } from "vitest";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";

// =============================================================================
// A PATH ID ANSWERS 404, NEVER 400 (security.md › "a route's own message is the
// client's"; CA-D6, 2026-09-29).
//
// The audit found the rule held at a handful of routes and was broken at
// forty-eight: a guard that caught a malformed id and answered
// `400 "Invalid feed id"` beside the same route's `404 "Feed not found"` for a
// well-formed one naming nothing. Splitting the two makes the route an oracle
// for which ids exist, and nothing pinned any of the 400 strings, so the next
// route written by copying its neighbour would have been the forty-ninth.
//
// WHAT THIS READS. Every route file's id guards — `isUuid`, `UUID_RE`, the
// 64-hex `POST_ID_RE` and the inline pubkey regex — and the FIRST `return` the
// guard's `if` makes. That return must not be a 400. A guard on a BODY or QUERY
// id is a different convention (a Zod-style 400 is right there) and is listed
// below by name, with the reason, rather than skipped by a pattern that would
// also skip the next path id.
//
// And a second net for the guard that is spelled some other way: no route
// answers 400 with an "Invalid … id" message except the listed body ids.
//
// It asserts it FOUND the guards first (≥ 60): a scan that matches nothing
// passes against anything.
// =============================================================================

const ROUTES = join(__dirname, "..", "src", "routes");

function walk(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) return walk(p);
    return p.endsWith(".ts") && !p.endsWith(".test.ts") ? [p] : [];
  });
}

/** Body/query ids, where a 400 is the convention. File + variable + why. */
const NOT_PATH_IDS: Array<{ file: string; variable: string; why: string }> = [
  {
    file: "trust.ts",
    variable: "subjectId",
    why: "POST /vouches takes the subject in the BODY",
  },
];

const GUARD =
  /!\s*(?:isUuid\(\s*([\w.]+)|UUID_RE\.test\(\s*([\w.]+)|POST_ID_RE\.test\(\s*([\w.]+)|\/\^\[0-9a-f\]\{64\}\$\/i\.test\(\s*([\w.]+))|!\s*([\w.]+)\.match\(UUID_RE\)/;

const files = walk(ROUTES);

interface Guard {
  file: string;
  line: number;
  variable: string;
  answer: string;
}

function guards(): Guard[] {
  const out: Guard[] = [];
  for (const path of files) {
    const lines = readFileSync(path, "utf8").split("\n");
    lines.forEach((text, i) => {
      if (/^\s*(\/\/|\*)/.test(text)) return;
      if (!/\bif\s*\(/.test(text)) return;
      const m = GUARD.exec(text);
      if (!m) return;
      const variable = (m[1] ?? m[2] ?? m[3] ?? m[4] ?? m[5]).split(".").pop()!;
      // The first return the `if` makes: on this line, or within the next three.
      const window = lines.slice(i, i + 4).join("\n");
      const ret = /return\s+reply[\s\S]*?\.send\(/.exec(window);
      if (!ret) return; // a guard that returns a value, not a reply (a cursor parser)
      out.push({
        file: relative(ROUTES, path),
        line: i + 1,
        variable,
        answer: ret[0],
      });
    });
  }
  return out;
}

const exempt = (g: { file: string; variable: string }) =>
  NOT_PATH_IDS.some((x) => g.file.endsWith(x.file) && g.variable === x.variable);

describe("a path id answers 404, never 400", () => {
  const found = guards();

  it("finds the guards it is about to judge", () => {
    expect(found.length).toBeGreaterThanOrEqual(60);
  });

  it("no path-id guard answers 400", () => {
    const offenders = found
      .filter((g) => /status\(\s*400\s*\)/.test(g.answer) && !exempt(g))
      .map((g) => `${g.file}:${g.line} (${g.variable})`);
    expect(offenders).toEqual([]);
  });

  it("no route answers 400 with an 'Invalid … id' message outside the listed body ids", () => {
    const offenders: string[] = [];
    for (const path of files) {
      const lines = readFileSync(path, "utf8").split("\n");
      lines.forEach((text, i) => {
        if (!/status\(\s*400\s*\)/.test(text)) return;
        const window = lines.slice(i, i + 2).join(" ");
        const m = /error:\s*["'`]Invalid\s+(\w+)\s*(?:id|ID)\b/.exec(window);
        if (!m) return;
        const file = relative(ROUTES, path);
        if (NOT_PATH_IDS.some((x) => file.endsWith(x.file) && window.includes(x.variable))) return;
        offenders.push(`${file}:${i + 1}`);
      });
    }
    expect(offenders).toEqual([]);
  });

  it("every exemption still names a guard that exists", () => {
    // An exemption whose guard was deleted is a hole waiting for a path id.
    for (const x of NOT_PATH_IDS) {
      expect(found.some((g) => g.file.endsWith(x.file) && g.variable === x.variable), x.file).toBe(true);
    }
  });
});
