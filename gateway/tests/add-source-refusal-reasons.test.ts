import { describe, it, expect, vi, beforeEach } from "vitest";
import Fastify from "fastify";

// =============================================================================
// A refused add says WHY, in the field the web reads.
//
// Every add-source surface in the web (the composer, the vessel bar's adder,
// the channel picker in `useFeedFollow`) shows `apiErrorMessage(err)`, which
// reads the body's `message` and nothing else. Four of `POST
// /feeds/:id/sources`'s refusals put their sentence in `error` instead, so the
// member saw the generic "Failed to add source" for all four, including a
// source already in the channel, where the route knew exactly what was wrong.
// So each refusal is asserted to carry a `message`, and a snake_case `error`
// code (the modernhaus door keys its sentence on the code, `ROUTE_ERRORS`).
//
// The fault case is the other half: a 500 carries no sentence, so the surface
// falls back to its own house copy rather than showing an internal label.
//
// The pool answers from the SQL and params it is handed; the one thing it
// cannot do is raise a real unique violation, so the duplicate is a tag whose
// INSERT throws Postgres's own code (23505), which is what `insertSource` maps.
// =============================================================================

const VIEWER = "00000000-0000-4000-8000-0000000000a1";
const WRITER = "00000000-0000-4000-8000-0000000000b2";
const BLOCKED = "00000000-0000-4000-8000-0000000000b3";
const MISSING = "00000000-0000-4000-8000-00000000dead";
const FEED_ID = "00000000-0000-4000-8000-0000000000c3";

function scriptedQuery(sql: string, params: unknown[] = []) {
  if (sql.includes("FROM feeds f") && sql.includes("f.owner_id = $2")) {
    const mine = params[0] === FEED_ID && params[1] === VIEWER;
    return Promise.resolve({
      rows: mine
        ? [{ id: FEED_ID, name: null, hidden: false, source_count: 0 }]
        : [],
      rowCount: mine ? 1 : 0,
    });
  }
  if (sql.includes("FROM accounts WHERE id = $1")) {
    const known = params[0] === WRITER || params[0] === BLOCKED;
    return Promise.resolve({
      rows: known ? [{ id: params[0], status: "active" }] : [],
      rowCount: known ? 1 : 0,
    });
  }
  if (sql.includes("FROM blocks")) {
    const blocked = params.includes(BLOCKED);
    return Promise.resolve({ rows: blocked ? [{}] : [], rowCount: blocked ? 1 : 0 });
  }
  // The tag path mirrors the name into `tags` before its own insert.
  if (sql.includes("INSERT INTO tags")) return Promise.resolve({ rows: [], rowCount: 1 });
  if (sql.includes("INSERT INTO feed_sources")) {
    const tag = params[5];
    if (tag === "dupe") {
      return Promise.reject(Object.assign(new Error("duplicate key"), { code: "23505" }));
    }
    if (tag === "boom") return Promise.reject(new Error("connection terminated"));
  }
  // Nothing else is reached by the refusals under test; say so if one is.
  return Promise.reject(new Error(`unscripted query: ${sql.slice(0, 80)}`));
}

vi.mock("@platform-pub/shared/db/client.js", () => ({
  pool: { query: (sql: string, p: unknown[] = []) => scriptedQuery(sql, p) },
  withTransaction: (cb: (c: { query: typeof scriptedQuery }) => Promise<unknown>) =>
    cb({ query: scriptedQuery }),
}));

vi.mock("@platform-pub/shared/lib/logger.js", () => ({
  default: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

vi.mock("../src/middleware/auth.js", () => ({
  requireAuth: async (req: { session?: { sub: string } }) => {
    req.session = { sub: VIEWER };
  },
  optionalAuth: async (req: { session?: { sub: string } }) => {
    req.session = { sub: VIEWER };
  },
}));

vi.mock("../src/lib/discovery-publish.js", () => ({
  markFollowListDirty: vi.fn(async () => {}),
}));

async function post(body: unknown) {
  const { registerFeedSourcesRoutes } = await import("../src/routes/feeds/sources.js");
  const app = Fastify({ logger: false });
  await app.register(async (a) => registerFeedSourcesRoutes(a));
  await app.ready();
  const res = await app.inject({
    method: "POST",
    url: `/feeds/${FEED_ID}/sources`,
    payload: body as object,
  });
  await app.close();
  return { status: res.statusCode, body: res.json() as { error?: string; message?: string } };
}

beforeEach(() => vi.clearAllMocks());

describe("POST /feeds/:id/sources — every refusal names its cause", () => {
  it("a source already in the channel", async () => {
    const r = await post({ sourceType: "tag", tagName: "dupe" });
    expect(r.status).toBe(409);
    expect(r.body).toEqual({
      error: "source_already_in_channel",
      message: "That source is already in this channel.",
    });
  });

  it("a source that does not exist", async () => {
    const r = await post({ sourceType: "account", accountId: MISSING });
    expect(r.status).toBe(404);
    expect(r.body.error).toBe("source_not_found");
    expect(r.body.message).toMatch(/couldn't find that source/);
  });

  it("the member's own account", async () => {
    const r = await post({ sourceType: "account", accountId: VIEWER });
    expect(r.status).toBe(400);
    expect(r.body.error).toBe("self_source");
    expect(r.body.message).toMatch(/your own account/);
  });

  it("an account behind a block, in the neutral sentence", async () => {
    const r = await post({ sourceType: "account", accountId: BLOCKED });
    expect(r.status).toBe(403);
    expect(r.body).toEqual({
      error: "target_blocked",
      message: "You can't add this account to a channel.",
    });
  });

  it("a fault of ours carries no sentence, so the surface uses its own", async () => {
    const r = await post({ sourceType: "tag", tagName: "boom" });
    expect(r.status).toBe(500);
    expect(r.body).toEqual({ error: "internal_error" });
  });
});
