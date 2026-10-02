import { describe, it, expect, vi, beforeEach } from "vitest";
import Fastify from "fastify";

// =============================================================================
// A withdrawn piece stays readable to whoever already bought it (§0z item 18;
// Writer Agreement 3.4 and 13.3)
//
// Withdrawal — the writer's delete, their closure, a moderation rung — sets
// `articles.deleted_at`. Until 2026-09-18 both the metadata route and the gate
// pass filtered `deleted_at IS NULL`, so a paid reader met 404 / `not_found`
// before the already-unlocked path could run, and the clause was kept by
// nothing.
//
// The ONE grant is an `article_unlocks` row. What this file asserts on every
// refusal is that NO key was fetched and NO charge was attempted; on every
// grant, that the key came back as a re-issue with no read event — the
// difference between "you already own this" and a sale of something withdrawn.
// The mock answers from the ids it is handed.
// =============================================================================

const READER = "00000000-0000-4000-8000-0000000000a1";
const OTHER = "00000000-0000-4000-8000-0000000000a2";
const WRITER = "00000000-0000-4000-8000-0000000000b1";
const ARTICLE = "00000000-0000-4000-8000-0000000000c1";
const EVENT_ID = "e".repeat(64);
const D_TAG = "withdrawn-piece";

let deleted = true;
/** Who holds an unlock for ARTICLE. */
let unlockedBy = new Set<string>();
let subscribed = false;
let calls: Array<{ sql: string; params: unknown[] }> = [];
const ran = (f: string) => calls.some((c) => c.sql.includes(f));

function scripted(sql: string, params: unknown[] = []) {
  calls.push({ sql, params: [...params] });
  const row = {
    id: ARTICLE,
    post_id: "post-1",
    writer_id: WRITER,
    nostr_event_id: EVENT_ID,
    nostr_d_tag: D_TAG,
    title: "T",
    slug: "t",
    summary: null,
    content_free: "free half",
    word_count: 10,
    access_mode: "paywalled",
    price_pence: 300,
    gate_position_pct: 50,
    vault_event_id: null,
    cover_image_url: null,
    published_at: new Date("2026-01-01T00:00:00Z"),
    writer_username: "w",
    writer_display_name: null,
    writer_avatar: null,
    writer_pubkey: "f".repeat(64),
    writer_subscription_price_pence: 500,
    publication_id: null,
    publication_slug: null,
    publication_name: null,
    publication_status: null,
    publication_subscription_price_pence: null,
    paid_access_withdrawn_at: null,
    writer_admitted: true,
    deleted_at: deleted ? new Date("2026-09-01T00:00:00Z") : null,
  };
  // Both lookups: the route's by d-tag, the gate pass's by event id.
  if (sql.includes("FROM articles a") && sql.includes("JOIN accounts w")) {
    const hit = sql.includes("nostr_d_tag = $1") ? params[0] === D_TAG : params[0] === EVENT_ID;
    return Promise.resolve(hit ? { rows: [{ ...row }], rowCount: 1 } : { rows: [], rowCount: 0 });
  }
  if (sql.includes("FROM article_unlocks")) {
    const hit = unlockedBy.has(params[0] as string) && params[1] === ARTICLE;
    return Promise.resolve(hit ? { rows: [{ id: "u1" }], rowCount: 1 } : { rows: [], rowCount: 0 });
  }
  if (sql.includes("FROM vault_keys")) return Promise.resolve({ rows: [{ ok: 1 }], rowCount: 1 });
  if (sql.includes("FROM subscriptions")) {
    return Promise.resolve(subscribed ? { rows: [{ id: "s1" }], rowCount: 1 } : { rows: [], rowCount: 0 });
  }
  if (sql.includes("FROM accounts WHERE id = $1")) {
    return Promise.resolve({ rows: [{ has_card: true, reader_terms_version: "2.0" }], rowCount: 1 });
  }
  if (sql.includes("read_events")) {
    return Promise.resolve({ rows: [{ total: "0" }], rowCount: 1 });
  }
  return Promise.resolve({ rows: [], rowCount: 0 });
}

vi.mock("@platform-pub/shared/db/client.js", () => ({
  pool: { query: (sql: string, p: unknown[] = []) => scripted(sql, p) },
  withTransaction: (cb: (c: { query: typeof scripted }) => Promise<unknown>) => cb({ query: scripted }),
}));
vi.mock("@platform-pub/shared/lib/env.js", () => ({
  requireEnv: (n: string) => `stub-${n}`,
  requireEnvMinLength: (n: string) => `stub-${n}`,
  internalSecret: () => "stub-secret",
  publicationsEnabled: () => false,
}));
vi.mock("@platform-pub/shared/lib/logger.js", () => ({
  default: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));
vi.mock("../src/lib/key-service-client.js", () => ({
  keyServiceHeaders: () => ({ "content-type": "application/json" }),
}));
let viewer: string | null = null;
vi.mock("../src/middleware/auth.js", () => ({
  requireAuth: async (req: any) => {
    req.session = { sub: viewer, pubkey: "a".repeat(64) };
  },
  optionalAuth: async (req: any) => {
    req.session = viewer ? { sub: viewer, pubkey: "a".repeat(64) } : undefined;
  },
  invalidateAuthCache: () => {},
}));

const fetchSpy = vi.fn();
vi.stubGlobal("fetch", fetchSpy);

const { performGatePass } = await import("../src/services/article-access/gate-pass.js");
const { articlePublishRoutes } = await import("../src/routes/articles/publish.js");

beforeEach(() => {
  calls = [];
  deleted = true;
  unlockedBy = new Set();
  subscribed = false;
  viewer = null;
  fetchSpy.mockReset();
  // Every HTTP leg: the key service answers a key; the payment service must
  // never be reached from any case here.
  fetchSpy.mockResolvedValue({
    ok: true,
    status: 200,
    json: async () => ({ encryptedKey: "k", algorithm: "nip44", ciphertext: "c" }),
  });
});

const paymentCalled = () =>
  fetchSpy.mock.calls.some((c) => String(c[0]).includes("gate-pass"));
// The only HTTP leg a grant may take is the key service; the payment
// service is named by its path, and everything else is the key.
const keyCalled = () => fetchSpy.mock.calls.length > 0 && !paymentCalled();

describe("performGatePass on a withdrawn piece", () => {
  it("re-issues the key to a reader who already bought it — no read event, no charge", async () => {
    unlockedBy.add(READER);
    const r = await performGatePass({ nostrEventId: EVENT_ID, readerId: READER, readerPubkey: "a".repeat(64) });
    // Pre-fix: `not_found`, before the unlocked path could run.
    expect(r.kind).toBe("success");
    if (r.kind === "success") {
      expect(r.body.isReissuance).toBe(true);
      expect(r.body.readEventId).toBeNull();
      expect(r.body.readState).toBe("already_unlocked");
    }
    expect(keyCalled()).toBe(true);
    expect(paymentCalled()).toBe(false);
    // Asked of THIS reader and THIS piece.
    const ask = calls.find((c) => c.sql.includes("FROM article_unlocks"));
    expect(ask?.params).toEqual([READER, ARTICLE]);
  });

  it("is not_found to a reader with no unlock — nothing fetched, nothing charged", async () => {
    const r = await performGatePass({ nostrEventId: EVENT_ID, readerId: READER, readerPubkey: "a".repeat(64) });
    expect(r.kind).toBe("not_found");
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("a live subscription is not a purchase of a withdrawn piece", async () => {
    subscribed = true;
    const r = await performGatePass({ nostrEventId: EVENT_ID, readerId: READER, readerPubkey: "a".repeat(64) });
    expect(r.kind).toBe("not_found");
    expect(fetchSpy).not.toHaveBeenCalled();
    // The subscription path was never even consulted: withdrawn is decided first.
    expect(ran("FROM subscriptions")).toBe(false);
  });

  it("control: a live piece still goes through the ordinary paths", async () => {
    deleted = false;
    unlockedBy.add(READER);
    const r = await performGatePass({ nostrEventId: EVENT_ID, readerId: READER, readerPubkey: "a".repeat(64) });
    expect(r.kind).toBe("success");
    if (r.kind === "success") expect(r.body.isReissuance).toBe(true);
  });
});

describe("GET /articles/:dTag on a withdrawn piece", () => {
  async function build() {
    const app = Fastify();
    await app.register(articlePublishRoutes);
    return app;
  }

  it("is 404 to the world — the anonymous, cross-viewer-cached fetch", async () => {
    const app = await build();
    const res = await app.inject({ method: "GET", url: `/articles/${D_TAG}` });
    expect(res.statusCode).toBe(404);
    await app.close();
  });

  it("is 404 to a session that never bought it", async () => {
    viewer = OTHER;
    unlockedBy.add(READER);
    const app = await build();
    const res = await app.inject({ method: "GET", url: `/articles/${D_TAG}` });
    expect(res.statusCode).toBe(404);
    await app.close();
  });

  it("answers the piece, flagged withdrawn, to the reader who bought it", async () => {
    viewer = READER;
    unlockedBy.add(READER);
    const app = await build();
    const res = await app.inject({ method: "GET", url: `/articles/${D_TAG}` });
    // Pre-fix: 404 for everyone.
    expect(res.statusCode).toBe(200);
    expect(res.json().withdrawn).toBe(true);
    expect(res.json().contentFree).toBe("free half");
    await app.close();
  });

  it("control: a live piece carries withdrawn: false", async () => {
    deleted = false;
    const app = await build();
    const res = await app.inject({ method: "GET", url: `/articles/${D_TAG}` });
    expect(res.statusCode).toBe(200);
    expect(res.json().withdrawn).toBe(false);
    await app.close();
  });
});
