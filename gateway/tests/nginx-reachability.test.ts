import { describe, it, expect } from "vitest";
import { existsSync, readFileSync } from "node:fs";

// =============================================================================
// A GATEWAY ROUTE OUTSIDE /api/ IS UNREACHABLE UNTIL NGINX IS TOLD ABOUT IT, AND
// THE FAILURE IS A 404 FROM THE WRONG SERVER.
//
// nginx proxies `/api/` to the gateway and everything else to the web app. A
// route registered without the `/api/v1` prefix therefore needs its own
// `location`, or every request to it falls through to Next.js — which answers a
// perfectly ordinary 404. Nothing logs an error, the gateway never sees the
// request, and from the outside it is indistinguishable from a path that was
// never built.
//
// Both routes that had this gap had it from the day they were written:
// `/inbound-mail` (so Postmark inbound had never once delivered) and `/rss` (so
// every author's feed 404'd). Neither was found by reading the code — the
// registrations are correct, the handlers are correct, and `nginx.conf` is a
// different file that says nothing about them. It was found while writing down
// how to point Postmark at the URL.
//
// SO THE LIST IS DERIVED, NEVER HAND-KEPT. This test reads `register-routes.ts` for
// prefix-less `app.register(...)` calls, follows each to its route file, and
// reads the paths out of the handlers — plus the paths registered directly on
// `app` in that file itself. A hand-listed set of routes is a sample of a class
// and drifts on the next registration; a derived one grows by itself, which is
// the whole point, because the next instance of this bug will be as silent as
// the first two.
//
// An intentionally-internal path is EXEMPTED BY NAME WITH ITS REASON, so the
// list of things nginx must not expose is as explicit as the list it must.
//
// MUTATION CHECK. Delete either new `location` from `nginx.conf` and the
// matching case fails. Delete the derivation and keep a literal list, and the
// test passes while proving nothing about the next route added.
// =============================================================================

const ROOT = new URL("../../", import.meta.url);
const NGINX_CONF = new URL("nginx.conf", ROOT);
// The route table lives in `register-routes.ts` since D1 (READER-WRITER-SPLIT-
// ADR §4.6); `index.ts` only calls it.
const INDEX_TS = new URL("gateway/src/register-routes.ts", ROOT);

// `nginx.conf` is production topology and does not ship in the public mirror
// (`public-manifest.txt`), so on that tree this file must not fail the suite AT
// COLLECTION — the S12 lesson, and the same guard the two embed-host tests use.
// In this repo it is always present, so nothing skips and CI's fail-on-skip
// stays honest.
const nginxConf = existsSync(NGINX_CONF) ? readFileSync(NGINX_CONF, "utf8") : null;
const indexTs = existsSync(INDEX_TS) ? readFileSync(INDEX_TS, "utf8") : null;

/**
 * Paths the gateway serves that nginx must NOT proxy, each with the reason. A
 * path that lands here is a decision; a path that lands here by accident is the
 * bug this file exists for, so the reason is mandatory.
 */
const INTERNAL_ONLY: Record<string, string> = {
  "/health":
    "the compose healthcheck, called on the loopback inside the container. " +
    "Exposing it publishes the DB's reachability and the parity verdict to anyone who asks.",
};

/** Route files reached by a `app.register(xRoutes)` with no `prefix`. */
function prefixlessRouteFiles(src: string): string[] {
  const registered = [...src.matchAll(/app\.register\((\w+)\)/g)].map((m) => m[1]);
  return registered
    .map((ident) => {
      const imp = new RegExp(
        `import\\s*\\{[^}]*\\b${ident}\\b[^}]*\\}\\s*from\\s*["'](\\.[^"']+)["']`,
      ).exec(src);
      return imp?.[1]?.replace(/\.js$/, ".ts") ?? null;
    })
    .filter((p): p is string => p !== null);
}

/**
 * The source with its comments removed. The path regex below runs `[^"']*`
 * from `app.get(` to the next quote, so over raw source it can start inside a
 * COMMENT that mentions `app.get(` and end on a quote in the code beneath it —
 * which is how `/actor` stayed "covered" by a header sentence after its
 * registration moved to a constant (§0ab guard (a)). A guard that reads prose
 * holds until somebody rewords it. Line comments are stripped only where they
 * open a line (after indentation), so the `//` in a URL literal survives.
 */
function stripComments(src: string): string {
  return src.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");
}

/** Every string literal passed as a route path to `app.get/post/...`. */
function routePaths(raw: string): string[] {
  const src = stripComments(raw);
  return [...src.matchAll(/app\.(?:get|post|put|patch|delete)[<(][^"']*["'](\/[^"']*)["']/g)]
    .map((m) => m[1])
    .filter((p) => !p.startsWith("/api/"));
}

/** The first segment — what an nginx `location` has to cover. */
const topSegment = (p: string) => "/" + p.split("/").filter(Boolean)[0];

function derivePublicPaths(): string[] {
  const src = indexTs ?? "";
  const paths = routePaths(src);
  for (const rel of prefixlessRouteFiles(src)) {
    const url = new URL(`gateway/src/${rel.replace(/^\.\//, "")}`, ROOT);
    if (existsSync(url)) paths.push(...routePaths(readFileSync(url, "utf8")));
  }
  return [...new Set(paths.map(topSegment))].sort();
}

describe.skipIf(nginxConf === null || indexTs === null)(
  "every non-/api gateway path is reachable through nginx",
  () => {
    const derived = derivePublicPaths();

    it("derived a plausible set, so a broken regex cannot pass by finding nothing", () => {
      // The guard's own guard. A derivation that silently matched zero paths
      // would make every assertion below vacuous and the file would go green
      // for ever — the same reason `href-guard.test.ts` asserts it scanned >20
      // files before believing its own silence.
      expect(derived.length).toBeGreaterThanOrEqual(4);
      expect(derived).toContain("/rss");
      expect(derived).toContain("/inbound-mail");
      expect(derived).toContain("/.well-known");
      // Registered by `instanceActorRoutes`; derived from the CODE, with the
      // comments stripped — a regex that found it only in prose is §0ab (a).
      expect(derived).toContain("/actor");
    });

    it.each(derivePublicPaths())("nginx has a location covering %s", (path) => {
      if (INTERNAL_ONLY[path]) {
        // Exempt — and assert the exemption is REAL, i.e. that nginx does not
        // in fact proxy it. An exemption nobody checks is a comment.
        expect(nginxConf).not.toMatch(
          new RegExp(`location\\s*=?\\s*${path.replace(/[.]/g, "\\.")}[\\s{]`),
        );
        return;
      }
      // `location = /x`, `location /x`, or `location /x/` — and for
      // /.well-known, the four exact locations that cover its members.
      const escaped = path.replace(/[.]/g, "\\.");
      expect(nginxConf).toMatch(new RegExp(`location\\s*=?\\s*${escaped}[/\\s{]`));
    });
  },
);

describe.skipIf(nginxConf === null)("the inbound-mail size limits are a pair", () => {
  // Postmark inlines attachments as base64 and its inbound ceiling is 35 MB.
  // Fastify's default bodyLimit is 1 MiB, nginx's client_max_body_size is 1m —
  // so BOTH have to be raised or a newsletter with a photo 413s at whichever
  // layer was left behind, and the operator sees a different error depending on
  // which one they fixed. Same shape as the embed allowlist ⟂ frame-src pair.
  const inboundBlocks = (nginxConf ?? "").split(/location\s*=?\s*\/inbound-mail/).slice(1);

  it("covers both the basic-auth and the legacy path form", () => {
    expect(inboundBlocks).toHaveLength(2);
  });

  it.each([0, 1])("block %i raises client_max_body_size", (i) => {
    expect(inboundBlocks[i]).toMatch(/client_max_body_size\s+40m/);
  });

  it("the gateway route carries the matching bodyLimit", () => {
    const route = readFileSync(
      new URL("gateway/src/routes/inbound-mail.ts", ROOT),
      "utf8",
    );
    expect(route).toMatch(/BODY_LIMIT_BYTES\s*=\s*40 \* 1024 \* 1024/);
    // On BOTH routes — they share a handler, so a limit on one of them is a
    // 413 that depends on which URL Postmark happens to be pointed at.
    expect([...route.matchAll(/bodyLimit: BODY_LIMIT_BYTES/g)]).toHaveLength(2);
  });
});
