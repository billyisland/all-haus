import { describe, it, expect } from "vitest";
import { readdirSync, readFileSync, statSync } from "node:fs";
import path from "node:path";

// =============================================================================
// Every `href` built from ingested data goes through `safeHttpUrl` — a grep,
// not a memory.
//
// Four sinks shipped a `javascript:` URL straight from a remote post or profile
// into an `<a href>` (MIRROR-AUDIT-2026-09-08 §2.3/§2.4). React 18 does not
// block those: it logs that a FUTURE version will, and renders them. Fixing the
// four leaves the next `href={…}` somebody adds, so this is the standing check.
//
// The exemption is by NAME, deliberately, not by a shape test: an expression
// that "looks internal" is exactly what a `javascript:` value can be made to
// look like once it is behind a variable. So every unwrapped sink is listed
// below with the reason it is safe, and a NEW one fails until somebody writes
// its line — which is the moment to ask where its value came from.
//
// A comment cannot fail. This can.
// =============================================================================

const ROOTS = ["post", "workspace", "article"].map((d) =>
  path.resolve(__dirname, "..", "src", "components", d),
);

// Exempt expressions, keyed by the text between `href={` and its closing brace.
// Each is an INTERNAL destination built by us, never a value off the wire.
// `only` pins an exemption to ONE file: a name as generic as `url` or `href`
// is exactly the identifier the next wire-fed sink will be called, so a
// tree-wide exemption on it is the name-keyed weakness the comment below
// says this suite avoids (S25 item 4). A second `href={url}` anywhere else
// fails until somebody writes its own line.
const INTERNAL_HREFS = new Map<string, { reason: string; only?: string }>([
  ["sourceHref", { reason: "/source/:id or /pub/:slug, built from a row id" }],
  ["profileHref", { reason: "/:username, built from a stored username" }],
  ["nameHref", { reason: "an all.haus profile path (ProfileLink's own contract)" }],
  ["originHref", { reason: "originWebUrl(), which itself returns http(s) or null" }],
  [
    "url",
    { reason: "PostBody's linkifier — URL_RE is /https?:\\/\\/[^\\s<]+/", only: "PostBody.tsx" },
  ],
  [
    "titleHref",
    { reason: "ReaderOverlay: safeHttpUrl on the external arm, an internal path on the native one" },
  ],
  ["href", { reason: "FeedComposer: a route string assembled in the component", only: "FeedComposer.tsx" }],
]);

function tsxFiles(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir)) {
    const full = path.join(dir, entry);
    if (statSync(full).isDirectory()) out.push(...tsxFiles(full));
    else if (entry.endsWith(".tsx")) out.push(full);
  }
  return out;
}

// The expression between `href={` and the brace that closes it — brace-matched
// rather than regex'd, so a template literal holding `${…}` is read whole.
function hrefExpressions(source: string): Array<{ line: number; expr: string }> {
  const out: Array<{ line: number; expr: string }> = [];
  const marker = "href={";
  for (let i = source.indexOf(marker); i !== -1; i = source.indexOf(marker, i + 1)) {
    let depth = 1;
    let j = i + marker.length;
    while (j < source.length && depth > 0) {
      if (source[j] === "{") depth++;
      else if (source[j] === "}") depth--;
      if (depth > 0) j++;
    }
    out.push({
      line: source.slice(0, i).split("\n").length,
      expr: source.slice(i + marker.length, j).trim(),
    });
    i = j;
  }
  return out;
}

describe("every href in the card, workspace and article trees is gated", () => {
  const files = ROOTS.flatMap(tsxFiles);

  it("finds the trees it is meant to be scanning", () => {
    // A path typo would make this suite pass by scanning nothing, which is the
    // reassuring failure this whole family of checks exists to end.
    expect(files.length).toBeGreaterThan(20);
  });

  it("wraps every un-exempt href in safeHttpUrl()", () => {
    const unguarded: string[] = [];
    for (const file of files) {
      const source = readFileSync(file, "utf8");
      for (const { line, expr } of hrefExpressions(source)) {
        if (expr.startsWith("safeHttpUrl(")) continue;
        // …or a plain identifier the same file binds to a safeHttpUrl() call.
        // Derived from the source rather than listed by name: an exemption
        // keyed on a NAME would also exempt the next `safeUrl` that isn't one.
        if (
          /^[A-Za-z_$][\w$]*$/.test(expr) &&
          new RegExp(`\\bconst\\s+${expr}\\s*=\\s*safeHttpUrl\\(`).test(source)
        )
          continue;
        // A literal internal path or same-page anchor written at the sink —
        // `/auth`, `/${slug}`, `#citation-${id}`. `//host` is not internal.
        if (/^[`'"](?:\/(?![/])|#)/.test(expr)) continue;
        const exempt = INTERNAL_HREFS.get(expr);
        if (exempt && (!exempt.only || path.basename(file) === exempt.only)) continue;
        unguarded.push(
          `${path.relative(path.resolve(__dirname, ".."), file)}:${line} — href={${expr}}`,
        );
      }
    }
    // Every entry here is either a sink that needs safeHttpUrl() or one that
    // needs a line in INTERNAL_HREFS above, with its reason.
    expect(unguarded).toEqual([]);
  });
});
