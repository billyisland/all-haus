import { describe, it, expect } from "vitest";
import { readdirSync, readFileSync, statSync } from "node:fs";
import path from "node:path";

// =============================================================================
// Every `NEXT_PUBLIC_*` the web READS must be settable — a grep, not a memory.
//
// `NEXT_PUBLIC_*` values are inlined at BUILD time, so a flag with no
// `ARG`/`ENV` in `web/Dockerfile` and no `build.args` entry in
// `docker-compose.yml` is inlined as `undefined` on every build. The code reads
// it, every comparison is false, and nothing an operator can do changes that.
//
// It is not hypothetical: `NEXT_PUBLIC_TRUST_ENABLED` and
// `NEXT_PUBLIC_TRAFFOLOGY_ENABLED` were both read by `featureFlags.ts` and both
// missing from every layer of the build, so the two surfaces were off with no
// switch — the "dead dial" failure in its build-time form, and silent in the
// usual way: the operator's edit succeeds, reports nothing and changes nothing.
//
// The chain is FOUR links and this checks all four, because breaking any one of
// them produces the same silence: read in source → `ARG` → `ENV` → build arg.
// =============================================================================

const WEB_SRC = path.resolve(__dirname, "..", "src");
const DOCKERFILE = path.resolve(__dirname, "..", "Dockerfile");
const COMPOSE = path.resolve(__dirname, "..", "..", "docker-compose.yml");

// Names the app reads but which are supplied some other way, each with its
// reason. A NEW one fails until somebody writes its line.
const EXEMPT = new Map<string, string>([]);

function sourceFiles(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir)) {
    const full = path.join(dir, entry);
    if (statSync(full).isDirectory()) out.push(...sourceFiles(full));
    else if (/\.(ts|tsx)$/.test(entry)) out.push(full);
  }
  return out;
}

describe("NEXT_PUBLIC_* flags are wired through the whole build", () => {
  const files = sourceFiles(WEB_SRC);
  const read = new Set<string>();
  for (const f of files) {
    for (const m of readFileSync(f, "utf8").matchAll(
      /process\.env\.(NEXT_PUBLIC_[A-Z0-9_]+)/g,
    )) {
      read.add(m[1]);
    }
  }

  it("finds the flags it is meant to be checking", () => {
    // A moved directory would otherwise make this suite green by scanning
    // nothing — the reassuring failure this whole family of checks exists to
    // end.
    expect(files.length).toBeGreaterThan(50);
    expect(read.size).toBeGreaterThanOrEqual(4);
  });

  it("declares an ARG and an ENV in web/Dockerfile for each", () => {
    const dockerfile = readFileSync(DOCKERFILE, "utf8");
    const missing: string[] = [];
    for (const name of read) {
      if (!new RegExp(`^ARG ${name}$`, "m").test(dockerfile)) {
        missing.push(`${name} — no ARG`);
      }
      // The ENV is the half that actually reaches `next build`; an ARG alone
      // declares a build argument the build step never sees.
      if (!new RegExp(`^ENV ${name}=\\$${name}$`, "m").test(dockerfile)) {
        missing.push(`${name} — no ENV`);
      }
    }
    expect(missing).toEqual([]);
  });

  it("passes each as a build arg in docker-compose.yml", () => {
    const compose = readFileSync(COMPOSE, "utf8");
    const missing = [...read].filter(
      (name) => !EXEMPT.has(name) && !new RegExp(`^\\s+${name}:`, "m").test(compose),
    );
    expect(missing).toEqual([]);
  });
});
