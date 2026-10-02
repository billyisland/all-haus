import { describe, it, expect } from "vitest";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join, resolve } from "node:path";

// =============================================================================
// Every flag feed-ingest reads is REACHABLE (CA-F1, 2026-09-29).
//
// feed-ingest has no `env_file` and its image copies only `dist/`, so the ONLY
// way a variable reaches the process is an entry in its compose `environment:`
// block. `IDENTITY_LINK_DETECT_ENABLED` and `NOSTR_ENGAGEMENT_COUNTS_ENABLED`
// were read in code and listed nowhere there, so both features could not be
// switched on by anything an operator did — and DEPLOYMENT.md told them to set
// one of them in a place that reached nothing. The dead-dial failure in its
// environment form.
//
// This reads the flag wrappers out of `shared/src/lib/env.ts`, the ones
// feed-ingest's source imports, and the compose block, and requires each flag
// to be listed. It asserts it FOUND the flags first, so a regex that stopped
// matching cannot pass by finding nothing.
// =============================================================================

const ROOT = resolve(__dirname, "../..");

function sourceFiles(dir: string): string[] {
  const out: string[] = [];
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) out.push(...sourceFiles(p));
    else if (p.endsWith(".ts") && !p.endsWith(".test.ts")) out.push(p);
  }
  return out;
}

describe("feed-ingest env wiring", () => {
  const envTs = readFileSync(join(ROOT, "shared/src/lib/env.ts"), "utf8");
  const wrappers = new Map<string, string>();
  for (const m of envTs.matchAll(
    /export function (\w+)\(\): boolean \{\s*return envFlag\("(\w+)"\)/g,
  )) {
    wrappers.set(m[1], m[2]);
  }

  const used = new Set<string>();
  for (const f of sourceFiles(join(ROOT, "feed-ingest/src"))) {
    const src = readFileSync(f, "utf8");
    for (const m of src.matchAll(
      /import\s*\{([^}]*)\}\s*from\s*"@platform-pub\/shared\/lib\/env\.js"/g,
    )) {
      for (const name of m[1].split(",").map((s) => s.trim()).filter(Boolean)) {
        const flag = wrappers.get(name);
        if (flag) used.add(flag);
      }
    }
  }

  const compose = readFileSync(join(ROOT, "docker-compose.yml"), "utf8");
  const start = compose.indexOf("\n  feed-ingest:\n");
  const rest = compose.slice(start + 1);
  const next = rest.slice(1).search(/\n  [a-z][\w-]*:\n/);
  const block = next === -1 ? rest : rest.slice(0, next + 1);

  it("found the flag wrappers and the feed-ingest compose block", () => {
    expect(wrappers.size).toBeGreaterThanOrEqual(8);
    expect(start).toBeGreaterThan(-1);
    expect(block).toMatch(/environment:/);
    // The three feed-ingest reads today; more is fine, fewer means the scan broke.
    expect(used.size).toBeGreaterThanOrEqual(3);
  });

  it("every flag feed-ingest reads has a compose environment entry", () => {
    const missing = [...used].filter(
      (flag) => !new RegExp(`^\\s+${flag}:`, "m").test(block),
    );
    expect(missing).toEqual([]);
  });
});
