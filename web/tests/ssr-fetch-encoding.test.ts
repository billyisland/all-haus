import { describe, it, expect } from "vitest";
import { readdirSync, readFileSync, statSync } from "node:fs";
import path from "node:path";

// =============================================================================
// Every route param an SSR page puts into a gateway URL is encoded — a grep,
// not a memory.
//
// Eleven server components interpolated `params.slug` / `params.dTag` /
// `params.username` straight into a `fetch(`${GATEWAY}/api/v1/…/${x}`)`. Next
// decodes a route param before handing it over, so `%2F..%2F..%2Fadmin`
// arrives as `../../admin` and undici NORMALISES it: the request that leaves is
// for a different gateway path than the one the template reads as. The page is
// server-side and unauthenticated, so what that buys is limited — but it is a
// path the URL's author did not choose, and the fix is one function call.
//
// This is a shape test rather than a list, because the shape is exact: what
// follows `/api/v1/` is ours, and every `${…}` inside it must be an
// `encodeURIComponent(…)` call. Anything else — a bare identifier, a nested
// template, a `String(x)` — fails, and the exemptions are BY NAME with a
// reason, on the same principle as the href guard next door.
//
// The count assertion is the important half: a path typo, a moved directory or
// a renamed constant would make this scan nothing and go green for ever.
//
// A comment cannot fail. This can.
// =============================================================================

const APP_DIR = path.resolve(__dirname, "..", "src", "app");

/** Interpolations that are not route params. Each is ours, and says why. */
const EXEMPT = new Map<string, string>([
  ["GATEWAY", "the base URL constant, read from the environment at boot"],
  ["PUBLISHED_FIGURES_PATH", "a fixed path constant in lib/published-figures.ts, never a param"],
]);

function pageFiles(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir)) {
    const full = path.join(dir, entry);
    if (statSync(full).isDirectory()) out.push(...pageFiles(full));
    else if (entry.endsWith(".tsx") || entry.endsWith(".ts")) out.push(full);
  }
  return out;
}

/** `${GATEWAY}/api/v1/...` template literals, captured whole. */
const GATEWAY_URL_RE = /`\$\{GATEWAY\}(\/api\/[^`]*)`/g;
const INTERPOLATION_RE = /\$\{([^}]*)\}/g;

describe("SSR gateway fetches", () => {
  const offenders: string[] = [];
  let scanned = 0;

  for (const file of pageFiles(APP_DIR)) {
    const src = readFileSync(file, "utf8");
    for (const m of src.matchAll(GATEWAY_URL_RE)) {
      scanned++;
      for (const i of m[1].matchAll(INTERPOLATION_RE)) {
        const expr = i[1].trim();
        if (EXEMPT.has(expr)) continue;
        if (/^encodeURIComponent\(/.test(expr)) continue;
        offenders.push(
          `${path.relative(APP_DIR, file)}: \${${expr}} in ${m[1]}`,
        );
      }
    }
  }

  it("scanned the pages it thinks it did", () => {
    // Eleven were unencoded when this landed; there are more URLs than that.
    expect(scanned).toBeGreaterThan(10);
  });

  it("encodes every interpolated segment", () => {
    expect(offenders).toEqual([]);
  });
});
