import { describe, it, expect, beforeAll } from "vitest";
import { readFileSync } from "node:fs";
import type { RouteOptions } from "fastify";
import {
  ROUTE_CLASSES,
  ROUTE_CLASS_NAMES,
  IN_HANDLER_WRITER_CHECK,
  RECIPIENT_PREDICATE_HOME,
  RECIPIENT_CHECK_DEFERRED,
} from "./route-classes.js";

// =============================================================================
// Every route is classified, and its class and its guard agree
// (READER-WRITER-SPLIT-ADR §4.6)
//
// A test that checked "every route in the writer set carries requireWriter"
// would still depend on a hand-kept set: a new writer route nobody added to it
// passes. So, like the event-id registry (`article-event-rekey.test.ts`), this
// enumerates the REAL route table — `registerRoutes`, the function `index.ts`
// calls, with an `onRoute` hook and no database — and requires every route to
// appear in `route-classes.ts`. A new route forces its author to decide.
//
// What each class must carry:
//   writer               `requireWriter` in its preHandler chain — or, for the
//                        two signing routes, the kind-30023 check in the
//                        handler, pinned behaviourally in signing-guard.test.ts
//   money-out            NOT `requireWriter`: a gate that stops a writer being
//                        paid is a trap
//   money-in-to-account  the recipient predicate (`writerAdmittedSql`) in the
//                        file that asks it — read, and the match asserted found
//   neither              NOT `requireWriter`
//
// "Carries requireWriter IF AND ONLY IF writer" is the strong form: a route
// classed `neither` that has the gate is misclassified as surely as a writer
// route that lacks it.
// =============================================================================

interface Seen {
  key: string;
  preHandlers: unknown[];
}

let seen: Seen[] = [];
let requireWriter: unknown;

beforeAll(async () => {
  // The env the route modules read at import (boot.test.ts carries the why).
  process.env.STRIPE_SECRET_KEY ??= "sk_test_dummy";
  process.env.READER_HASH_KEY ??= "a".repeat(64);
  process.env.APP_URL ??= "http://localhost:3010";
  process.env.KEY_SERVICE_URL ??= "http://localhost:3002";
  process.env.PAYMENT_SERVICE_URL ??= "http://localhost:3001";
  process.env.INTERNAL_SERVICE_TOKEN ??= "dummy";
  process.env.PLATFORM_SERVICE_PRIVKEY ??=
    "0000000000000000000000000000000000000000000000000000000000000001";
  process.env.SESSION_SECRET ??= "a".repeat(64);
  process.env.KEY_CUSTODY_URL ??= "http://localhost:3004";
  process.env.INTERNAL_SECRET ??= "dummy";

  const Fastify = (await import("fastify")).default;
  const { registerRoutes } = await import("../src/register-routes.js");
  ({ requireWriter } = await import("../src/lib/writer-gate.js"));

  const app = Fastify({ logger: false });
  app.addHook("onRoute", (r: RouteOptions) => {
    const methods = Array.isArray(r.method) ? r.method : [r.method];
    const pre = r.preHandler === undefined ? [] : Array.isArray(r.preHandler) ? r.preHandler : [r.preHandler];
    // HEAD routes are derived by Fastify from GETs and are not listed.
    for (const m of methods) if (m !== "HEAD") seen.push({ key: `${m} ${r.url}`, preHandlers: pre });
  });
  await registerRoutes(app);
  await app.ready();
  await app.close();
}, 60_000);

const gated = (s: Seen) => s.preHandlers.includes(requireWriter);

describe("the route registry", () => {
  it("enumerated a plausible table, so an empty hook cannot pass by finding nothing", () => {
    expect(seen.length).toBeGreaterThan(250);
    expect(seen.map((s) => s.key)).toContain("POST /api/v1/articles");
  });

  it("classifies every registered route — a new one must be decided", () => {
    const missing = seen.map((s) => s.key).filter((k) => !(k in ROUTE_CLASSES));
    expect(missing, "add these to gateway/tests/route-classes.ts").toEqual([]);
  });

  it("lists no route that is no longer registered", () => {
    const registered = new Set(seen.map((s) => s.key));
    const stale = Object.keys(ROUTE_CLASSES).filter((k) => !registered.has(k));
    expect(stale, "remove these from gateway/tests/route-classes.ts").toEqual([]);
  });

  it("uses only the four classes", () => {
    for (const c of Object.values(ROUTE_CLASSES)) expect(ROUTE_CLASS_NAMES).toContain(c);
  });
});

describe("each class carries its guard", () => {
  it("every writer route carries requireWriter (the signing pair excepted, pinned by behaviour)", () => {
    const ungated = seen
      .filter((s) => ROUTE_CLASSES[s.key] === "writer" && !IN_HANDLER_WRITER_CHECK.has(s.key))
      .filter((s) => !gated(s))
      .map((s) => s.key);
    expect(ungated).toEqual([]);
    // The exception is only for writer routes, and they really are writer routes.
    for (const k of IN_HANDLER_WRITER_CHECK) expect(ROUTE_CLASSES[k]).toBe("writer");
  });

  it("requireWriter runs AFTER requireAuth — it reads the session requireAuth sets", () => {
    for (const s of seen.filter(gated)) {
      const i = s.preHandlers.indexOf(requireWriter);
      const auth = s.preHandlers.findIndex((f) => typeof f === "function" && f.name === "requireAuth");
      expect(auth, `${s.key}: requireAuth before requireWriter`).toBeGreaterThanOrEqual(0);
      expect(auth, s.key).toBeLessThan(i);
    }
  });

  it("no money-out route carries requireWriter — a writer must always be able to be paid", () => {
    const wrong = seen.filter((s) => ROUTE_CLASSES[s.key] === "money-out" && gated(s)).map((s) => s.key);
    expect(wrong).toEqual([]);
  });

  it("no route outside the writer class carries requireWriter", () => {
    const wrong = seen.filter((s) => ROUTE_CLASSES[s.key] !== "writer" && gated(s)).map((s) => s.key);
    expect(wrong).toEqual([]);
  });

  it("every money-in route asks the recipient predicate where it says it does, or is deferred and dark", () => {
    const moneyIn = Object.entries(ROUTE_CLASSES)
      .filter(([, c]) => c === "money-in-to-account")
      .map(([k]) => k);
    expect(moneyIn.length).toBeGreaterThanOrEqual(5);
    for (const key of moneyIn) {
      const home = RECIPIENT_PREDICATE_HOME[key];
      const deferred = RECIPIENT_CHECK_DEFERRED[key];
      expect(Boolean(home) !== Boolean(deferred), `${key}: exactly one of home / deferred`).toBe(true);
      if (home) {
        const src = readFileSync(new URL(`../${home}`, import.meta.url), "utf8");
        expect(src.includes("writerAdmittedSql("), `${key}: writerAdmittedSql( in ${home}`).toBe(true);
      } else {
        const src = readFileSync(new URL(`../${deferred.file}`, import.meta.url), "utf8");
        expect(src.includes(deferred.darkBy), `${key}: still dark behind ${deferred.darkBy}`).toBe(true);
      }
    }
    // No stray entries in either side-table.
    for (const k of [...Object.keys(RECIPIENT_PREDICATE_HOME), ...Object.keys(RECIPIENT_CHECK_DEFERRED)]) {
      expect(ROUTE_CLASSES[k], k).toBe("money-in-to-account");
    }
  });
});
