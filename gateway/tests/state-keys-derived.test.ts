import { describe, it, expect } from "vitest";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join, resolve } from "node:path";

// =============================================================================
// Runtime state is refused by the config editor — and the list is DERIVED
// (CA-F3, 2026-09-29).
//
// `STATE_KEYS` in admin-dashboard.ts is what stops the dials editor accepting
// a hand edit to a key a worker owns. It was hand-kept, and three workers'
// keys were missing: once written, the waitlist digest's watermark and
// last-sent stamp and the engagement sweep's cursor passed the editor's
// "existing key" check like any dial, and a bad edit re-sent or skipped
// digests. So this finds every runtime `INSERT INTO platform_config` in the
// services' source, resolves the key it writes (a literal in VALUES, or a
// `const X = "..."` in the same file), and requires each to be in the set.
// It asserts it FOUND the writers first.
// =============================================================================

const ROOT = resolve(__dirname, "../..");
const SERVICES = ["gateway/src", "feed-ingest/src", "payment-service/src", "key-service/src", "key-custody/src", "shared/src"];

function files(dir: string): string[] {
  const out: string[] = [];
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) out.push(...files(p));
    else if (p.endsWith(".ts") && !p.endsWith(".test.ts")) out.push(p);
  }
  return out;
}

function writtenKeys(): { file: string; key: string | null }[] {
  const found: { file: string; key: string | null }[] = [];
  for (const svc of SERVICES) {
    for (const f of files(join(ROOT, svc))) {
      const src = readFileSync(f, "utf8");
      const consts = new Map<string, string>();
      for (const m of src.matchAll(/const (\w+) = ["']([a-z0-9_]+)["']/g)) consts.set(m[1], m[2]);
      for (const m of src.matchAll(/INSERT INTO platform_config[\s\S]*?VALUES\s*\(\s*([^,]+),/g)) {
        const first = m[1].trim();
        // Take every row of a multi-row VALUES, not only the first.
        const tail = src.slice(m.index!, src.indexOf("ON CONFLICT", m.index!));
        const rows = [...tail.matchAll(/\(\s*('([a-z0-9_]+)'|\$(\d+))\s*,/g)];
        // The params array follows the statement's closing backtick.
        const afterSql = src.slice(src.indexOf("`", m.index!) + 1);
        const args = /^\s*,\s*\[\s*([\s\S]*?)\]/.exec(afterSql)?.[1].split(",").map((a) => a.trim()) ?? [];
        for (const r of rows.length ? rows : [[first, first]]) {
          if (r[2]) found.push({ file: f, key: r[2] });
          else if (r[3]) {
            const arg = args[Number(r[3]) - 1];
            found.push({ file: f, key: consts.get(arg ?? "") ?? null });
          }
        }
      }
    }
  }
  return found;
}

describe("STATE_KEYS covers every runtime platform_config writer", () => {
  const admin = readFileSync(join(ROOT, "gateway/src/routes/admin-dashboard.ts"), "utf8");
  const block = /const STATE_KEYS = new Set\(\[([\s\S]*?)\]\)/.exec(admin)?.[1] ?? "";
  const stateKeys = new Set([...block.matchAll(/'([a-z0-9_]+)'/g)].map((m) => m[1]));
  const writers = writtenKeys();

  it("found the set and the writers", () => {
    expect(stateKeys.size).toBeGreaterThanOrEqual(7);
    expect(writers.length).toBeGreaterThanOrEqual(7);
    // A key the scan could not resolve is a scan failure, not a pass.
    expect(writers.filter((w) => w.key === null)).toEqual([]);
  });

  it("every key a service writes at run time is refused by the editor", () => {
    const missing = writers.filter((w) => !stateKeys.has(w.key!)).map((w) => `${w.key} (${w.file.slice(ROOT.length + 1)})`);
    expect(missing).toEqual([]);
  });
});
