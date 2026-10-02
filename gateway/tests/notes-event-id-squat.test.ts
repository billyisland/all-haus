import { describe, it, expect, vi, beforeEach } from "vitest";
import Fastify from "fastify";

// =============================================================================
// POST /notes refuses an event id that already belongs to something else.
//
// MIRROR-AUDIT §2.7, layer 1. This route indexes a note under a CLIENT-SUPPLIED
// `nostrEventId` with no signer check, so a caller can plant a second row for an
// id that already names an article or a reply. That is what made the guard
// bypass possible — a reply or vote declaring `targetKind: 1` landed in `notes`
// and never read the article — and it also pollutes `feed_items.nostr_event_id`,
// which has no unique index, so the thread projector's `LIMIT 1` root lookup
// becomes a coin toss over whether `rootLocked` gets stamped.
//
// Layer 2 (resolving by row) makes a squat lose. This stops it being planted,
// and both are needed: the resolver cannot un-plant a row another reader picks.
//
// What is asserted is whether the INSERT RAN — a 409 that still wrote the row
// would be the same squat wearing a status code.
// =============================================================================

const AUTHOR = "00000000-0000-4000-8000-0000000000a1";
const TAKEN_EVENT = "a".repeat(64);
const FREE_EVENT = "b".repeat(64);

let calls: Array<{ sql: string; params: unknown[] }> = [];
let takenIds = new Set<string>([TAKEN_EVENT]);

function ran(fragment: string) {
  return calls.some((c) => c.sql.includes(fragment));
}

function scriptedQuery(sql: string, params: unknown[] = []) {
  calls.push({ sql, params });

  // The collision check, answered FROM THE SQL and the param it is handed.
  if (sql.includes("FROM articles") && sql.includes("UNION ALL")) {
    return Promise.resolve({
      rows: takenIds.has(params[0] as string) ? [{ "?column?": 1 }] : [],
      rowCount: takenIds.has(params[0] as string) ? 1 : 0,
    });
  }
  if (sql.includes("INSERT INTO notes")) {
    return Promise.resolve({ rows: [{ id: "note-1" }], rowCount: 1 });
  }
  if (sql.includes("FROM accounts")) {
    return Promise.resolve({
      rows: [{ display_name: "A", avatar_blossom_url: null, username: "a" }],
      rowCount: 1,
    });
  }
  return Promise.resolve({ rows: [], rowCount: 0 });
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
    req.session = { sub: AUTHOR };
  },
}));

const { noteRoutes } = await import("../src/routes/notes.js");

async function build() {
  const app = Fastify();
  await app.register(noteRoutes);
  return app;
}

function index(app: Awaited<ReturnType<typeof build>>, nostrEventId: string) {
  return app.inject({
    method: "POST",
    url: "/notes",
    payload: { nostrEventId, content: "hello" },
  });
}

beforeEach(() => {
  calls = [];
  takenIds = new Set([TAKEN_EVENT]);
});

describe("POST /notes — the event id has to be free", () => {
  it("409s an id that already names an article or a reply, and inserts nothing", async () => {
    const app = await build();
    const res = await index(app, TAKEN_EVENT);

    expect(res.statusCode).toBe(409);
    expect(res.json().error).toBe("event_id_taken");
    // The whole point: a 409 that still wrote the row would plant the squat.
    expect(ran("INSERT INTO notes")).toBe(false);
    expect(ran("INSERT INTO feed_items")).toBe(false);
    await app.close();
  });

  it("indexes an ordinary note untouched", async () => {
    const app = await build();
    const res = await index(app, FREE_EVENT);

    expect(res.statusCode).toBe(201);
    expect(ran("INSERT INTO notes")).toBe(true);
    await app.close();
  });

  it("runs the check inside the transaction, before the INSERT", async () => {
    // Checked outside, the check and the insert are two statements a concurrent
    // squat interleaves between. Order is the only evidence available here that
    // they are one — the transaction itself is the mock's `withTransaction`.
    const app = await build();
    await index(app, FREE_EVENT);

    const checkAt = calls.findIndex((c) => c.sql.includes("UNION ALL"));
    const insertAt = calls.findIndex((c) => c.sql.includes("INSERT INTO notes"));
    expect(checkAt).toBeGreaterThanOrEqual(0);
    expect(insertAt).toBeGreaterThan(checkAt);
    await app.close();
  });
});
