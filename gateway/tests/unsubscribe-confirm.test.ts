import { describe, it, expect, vi, beforeEach } from "vitest";
import Fastify from "fastify";
import rateLimit from "@fastify/rate-limit";

// =============================================================================
// THE LINK ASKS; THE POST ACTS (CA-D4).
//
// `GET /email/unsubscribe` verified the token and UPDATEd, and a mail link
// scanner opens every link in every message it screens — so a member's own mail
// server was unsubscribing them. The GET now renders a confirm page; the POST
// acts, and is also the RFC 8058 one-click target named by the `List-Unsubscribe`
// header, which a mail client POSTs to with `List-Unsubscribe=One-Click` and no
// page in between.
//
// EVERY CASE ASSERTS WHETHER AN UPDATE RAN — both methods answer a 200 page, so
// the status code cannot tell a confirm from an act.
//
// MUTATION CHECK. Call `unsubscribe(v)` from the GET handler and the first case
// fails; drop the scoped form-body parser and the one-click case answers 415
// with no UPDATE; drop `config: routeConfig` and the limiter case fails.
// =============================================================================

const READER = "00000000-0000-4000-8000-0000000000a1";
const WRITER = "00000000-0000-4000-8000-0000000000b2";

let updates: string[] = [];
let tokenValid = true;

vi.mock("@platform-pub/shared/db/client.js", () => ({
  pool: {
    query: (sql: string) => {
      if (sql.includes("UPDATE")) {
        updates.push(sql);
        return Promise.resolve({ rows: [{ id: "x" }], rowCount: 1 });
      }
      if (sql.includes("FROM accounts")) {
        return Promise.resolve({
          rows: [{ display_name: "A Writer", username: "awriter" }],
          rowCount: 1,
        });
      }
      throw new Error(`unscripted SQL: ${sql}`);
    },
  },
}));

vi.mock("@platform-pub/shared/lib/logger.js", () => ({
  default: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

vi.mock("@platform-pub/shared/lib/env.js", () => ({
  requireEnv: (name: string) =>
    name === "APP_URL" ? "https://all.haus" : "test-reader-hash-key",
}));

vi.mock("@platform-pub/shared/lib/publish-email-template.js", () => ({
  verifyUnsubscribeToken: () => tokenValid,
}));

const { unsubscribeRoutes } = await import("../src/routes/unsubscribe.js");

async function build() {
  const app = Fastify();
  // As the root registers it: off by default, per-route config opts in.
  await app.register(rateLimit, { global: false });
  await app.register(unsubscribeRoutes, { prefix: "/api/v1" });
  return app;
}

const URL = `/api/v1/email/unsubscribe?aid=${READER}&tid=${WRITER}&type=subscription&token=t`;

beforeEach(() => {
  updates = [];
  tokenValid = true;
});

describe("GET /email/unsubscribe — confirms and changes nothing", () => {
  it("renders the question and runs no UPDATE", async () => {
    const app = await build();
    const res = await app.inject({ method: "GET", url: URL });
    expect(res.statusCode).toBe(200);
    expect(updates).toHaveLength(0);
    expect(res.body).toContain("Unsubscribe?");
    expect(res.body).toMatch(/<strong[^>]*>A Writer<\/strong>/);
  });

  it("the button POSTs back to the same signed query", async () => {
    const app = await build();
    const res = await app.inject({ method: "GET", url: URL });
    const form = res.body.match(/<form method="post" action="([^"]+)"/);
    expect(form).not.toBeNull();
    const action = new globalThis.URL(form![1].replace(/&amp;/g, "&"));
    expect(action.origin).toBe("https://all.haus");
    expect(action.pathname).toBe("/api/v1/email/unsubscribe");
    expect(Object.fromEntries(action.searchParams)).toEqual({
      aid: READER,
      tid: WRITER,
      type: "subscription",
      token: "t",
    });
  });

  it("a bad token offers no button", async () => {
    tokenValid = false;
    const app = await build();
    const res = await app.inject({ method: "GET", url: URL });
    expect(res.statusCode).toBe(403);
    expect(res.body).not.toContain("<form");
  });
});

describe("POST /email/unsubscribe — acts", () => {
  it("the confirm page's press unsubscribes", async () => {
    const app = await build();
    const res = await app.inject({ method: "POST", url: URL });
    expect(res.statusCode).toBe(200);
    expect(updates).toHaveLength(1);
    expect(updates[0]).toContain("UPDATE subscriptions");
    expect(res.body).toContain("Unsubscribed");
  });

  it("RFC 8058 one-click (url-encoded body) acts with no further page", async () => {
    const app = await build();
    const res = await app.inject({
      method: "POST",
      url: URL,
      headers: { "content-type": "application/x-www-form-urlencoded" },
      payload: "List-Unsubscribe=One-Click",
    });
    expect(res.statusCode).toBe(200);
    expect(updates).toHaveLength(1);
  });

  it("refuses a bad token and runs no UPDATE", async () => {
    tokenValid = false;
    const app = await build();
    const res = await app.inject({ method: "POST", url: URL });
    expect(res.statusCode).toBe(403);
    expect(updates).toHaveLength(0);
  });
});

describe("the route is rate-limited by the gateway's limiter", () => {
  it("the 11th request in a minute gets the page, not JSON, and no UPDATE", async () => {
    const app = await build();
    for (let i = 0; i < 10; i++) {
      await app.inject({ method: "POST", url: URL, remoteAddress: "203.0.113.9" });
    }
    updates = [];
    const res = await app.inject({ method: "POST", url: URL, remoteAddress: "203.0.113.9" });
    expect(res.statusCode).toBe(429);
    expect(res.headers["content-type"]).toContain("text/html");
    expect(res.body).toContain("Too many requests");
    expect(updates).toHaveLength(0);
  });
});

describe("only a subscription can be unsubscribed", () => {
  // `follows` and `publication_follows` have no `notify_on_publish` column; the
  // route used to UPDATE it anyway. Only subscription tokens are minted.
  it.each(["follow", "publication_follow"])("refuses type=%s without an UPDATE", async (type) => {
    const app = await build();
    const res = await app.inject({ method: "POST", url: URL.replace("type=subscription", `type=${type}`) });
    expect(res.statusCode).toBe(400);
    expect(updates).toHaveLength(0);
  });
});
