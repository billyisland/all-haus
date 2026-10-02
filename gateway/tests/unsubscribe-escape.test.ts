import { describe, it, expect, vi, beforeEach } from "vitest";
import Fastify from "fastify";

// =============================================================================
// GET /email/unsubscribe — stored XSS on the app origin
// (MIRROR-AUDIT-2026-09-08 §2.1).
//
// The page interpolated `accounts.display_name` / `publications.name` RAW into
// HTML served on the app origin, under a CSP carrying `script-src
// 'unsafe-inline'`. `display_name` is `z.string().min(1).max(100)` with no
// character class, so 100 characters is a long way past `<svg onload=…>`, and
// the reachable payload runs with the victim's cookie — including
// `GET /account/export`, which returns the nsec.
//
// The route is not the attacker's only step (obtaining a valid token needs a
// self-subscription with a card), but it is the only step we control, and the
// correct treatment for a display name is ESCAPING, not allow-listing.
//
// THE ASSERTION IS THE RENDERED BYTES, not the status code: every branch here
// answers a 200 HTML page whether or not a row updated, so a status assertion
// passes against the bug. Mutation-proved: drop the `escapeHtml` around
// `targetName` and the two payload cases fail.
// =============================================================================

const READER = "00000000-0000-4000-8000-0000000000a1";
const WRITER = "00000000-0000-4000-8000-0000000000b2";
const PAYLOAD = `<svg onload='alert(1)'>`;

let displayName: string | null;
let username: string;
let tokenValid: boolean;

function scriptedQuery(sql: string) {
  if (sql.includes("UPDATE")) return Promise.resolve({ rows: [], rowCount: 1 });
  if (sql.includes("FROM accounts")) {
    return Promise.resolve({
      rows: [{ display_name: displayName, username }],
      rowCount: 1,
    });
  }
  return Promise.resolve({ rows: [], rowCount: 0 });
}

vi.mock("@platform-pub/shared/db/client.js", () => ({
  pool: { query: (sql: string) => scriptedQuery(sql) },
}));

vi.mock("@platform-pub/shared/lib/logger.js", () => ({
  default: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

vi.mock("@platform-pub/shared/lib/env.js", () => ({
  requireEnv: () => "test-reader-hash-key",
}));

vi.mock("@platform-pub/shared/lib/publish-email-template.js", () => ({
  verifyUnsubscribeToken: () => tokenValid,
}));

const { unsubscribeRoutes } = await import("../src/routes/unsubscribe.js");

async function build() {
  const app = Fastify();
  await app.register(unsubscribeRoutes);
  return app;
}

function visit(
  app: Awaited<ReturnType<typeof build>>,
  type = "subscription",
  tid = WRITER,
) {
  return app.inject({
    method: "GET",
    url: `/email/unsubscribe?aid=${READER}&tid=${tid}&type=${type}&token=t`,
  });
}

beforeEach(() => {
  displayName = "A Writer";
  username = "awriter";
  tokenValid = true;
});

describe("the unsubscribe confirmation page escapes what it interpolates", () => {
  it("escapes a hostile display_name", async () => {
    displayName = PAYLOAD;
    const res = await visit(await build());
    expect(res.statusCode).toBe(200);
    expect(res.body).not.toContain("<svg");
    expect(res.body).toContain("&lt;svg");
    // The single quote matters here: it is what closes an attribute value.
    expect(res.body).not.toContain("onload='alert(1)'");
  });

  it("escapes the username fallback when display_name is null", async () => {
    displayName = null;
    username = PAYLOAD;
    const res = await visit(await build());
    expect(res.body).not.toContain("<svg");
    expect(res.body).toContain("&lt;svg");
  });

  it("still renders an ordinary name as ordinary text", async () => {
    const res = await visit(await build());
    // The layout styles the tag inline (every email and this page share it),
    // so the pin is the NAME inside a strong, whatever attributes it carries.
    expect(res.body).toMatch(/<strong[^>]*>A Writer<\/strong>/);
  });

  // The name is rendered whether or not a row updated (that is deliberate —
  // the page must not leak whether the relationship existed), so the escape
  // cannot be conditional on the update either.
  it("escapes on the refused-token page too, which names nobody", async () => {
    tokenValid = false;
    const res = await visit(await build());
    expect(res.statusCode).toBe(403);
    expect(res.body).not.toContain("<svg");
  });
});
