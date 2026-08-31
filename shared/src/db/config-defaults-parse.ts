// =============================================================================
// Reader for config-defaults.sql — the canonical default of every
// platform_config tuning dial.
//
// Exists so a service can assert, in its own test suite, that the fallback it
// carries in code matches the seeded default. Those in-code fallbacks
// (`num("resonance_weight_like", 1)` and friends) duplicate the SQL file with
// nothing holding the two in step, which is the same masking mechanism 1d6b756
// diagnosed: a fallback silently substitutes for a dial that is absent or
// misspelled, so the system runs on a number no operator can see or tune, and
// nothing reports it.
//
// The runner applies the file on every migrate with ON CONFLICT (key) DO
// NOTHING, and drift-guard Check 4b proves a fresh DB carries every dial — so
// the fallbacks are belt-and-braces, not load-bearing. Keeping them is fine;
// keeping them *unchecked* is what lets them drift into a second, invisible
// source of truth.
// =============================================================================

import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";

// Resolved against this module, like the runner's own copy: the file is owned
// by shared/db and must be found however the importer is invoked.
const DEFAULTS_PATH = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "config-defaults.sql",
);

/**
 * Every `(key, value, description)` tuple in config-defaults.sql, as key→value.
 *
 * Deliberately a plain regex over the file rather than a SQL parse: the file is
 * a flat list of literal tuples by construction (the drift guard's Check 4c
 * enforces that shape), and a parser sophisticated enough to be worth its own
 * bugs would be the wrong trade for a test helper.
 */
export function readConfigDefaults(): Map<string, string> {
  const sql = fs.readFileSync(DEFAULTS_PATH, "utf8");
  const out = new Map<string, string>();
  // ('key', 'value', 'description') — values are always single-quoted literals.
  const re = /\(\s*'([a-z0-9_]+)'\s*,\s*'([^']*)'\s*,/gi;
  let m: RegExpExecArray | null;
  while ((m = re.exec(sql)) !== null) out.set(m[1], m[2]);
  return out;
}

/**
 * Assert that an in-code fallback table matches the seeded defaults.
 *
 * Returns the mismatches rather than throwing, so the caller's test framework
 * produces the diff. A key absent from the file is reported too — a fallback
 * for a dial that was never seeded is the more dangerous half, since Check 4b
 * cannot see it and the value exists only in code.
 */
export function diffAgainstDefaults(
  fallbacks: Record<string, number>,
): Array<{ key: string; inCode: number; inFile: string | undefined }> {
  const defaults = readConfigDefaults();
  const bad: Array<{ key: string; inCode: number; inFile: string | undefined }> = [];
  for (const [key, inCode] of Object.entries(fallbacks)) {
    const inFile = defaults.get(key);
    if (inFile === undefined || Number(inFile) !== inCode) {
      bad.push({ key, inCode, inFile });
    }
  }
  return bad;
}
