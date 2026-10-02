import { describe, it, expect, vi, beforeEach } from "vitest";
import Fastify from "fastify";

// =============================================================================
// The block routes — evidence, refusal of a re-block, and the canonical key
// (§0z item 12; migration 224's own header)
//
// Three things were not true of these routes when 224 said they were:
//   (1) block and unblock wrote a log line and no `config_audit` row;
//   (2) a re-block `DO UPDATE`d the first reason, actor and date away;
//   (3) a SOURCE block stored the operator's string as typed, while the add
//       path compares the CANONICAL form — an `@user@host` block matched
//       nothing, silently, which is the one failure direction a block must
//       not have.
//
// The mock keeps a real in-memory table and evaluates `ON CONFLICT DO NOTHING`
// itself; `verifySourceLiveness` is mocked per case so the canonicalisation
// is exercised without a network. What is asserted is the audit INSERT (its
// params, in the same transaction) and the row that ends up stored — never a
// status alone.
// =============================================================================

interface BlockRow {
  id: string;
  kind: string;
  protocol: string;
  target_key: string;
  reason: string;
  blocked_by: string;
  blocked_at: Date;
}
let blocks: BlockRow[] = [];
let audits: Array<Record<string, unknown>> = [];
let heldSources: Array<[string, string]> = [];
let calls: Array<{ sql: string; params: unknown[]; tx: boolean }> = [];
let liveness: { ok: true; sourceUri: string } | { ok: false; reason: "malformed" | "unreachable"; message: string } =
  { ok: true, sourceUri: "https://host.example/users/alice" };

function scripted(tx: boolean) {
  return (sql: string, params: unknown[] = []) => {
    calls.push({ sql, params: [...params], tx });
    if (/INSERT INTO platform_blocks/.test(sql)) {
      const [kind, protocol, target_key, reason, blocked_by] = params as string[];
      const dup = blocks.find((b) => b.kind === kind && b.protocol === protocol && b.target_key === target_key);
      if (dup && /ON CONFLICT \(kind, protocol, target_key\) DO NOTHING/.test(sql)) {
        return Promise.resolve({ rows: [], rowCount: 0 });
      }
      const row = { id: `b-${blocks.length + 1}`, kind, protocol, target_key, reason, blocked_by, blocked_at: new Date() };
      if (dup) Object.assign(dup, row, { id: dup.id }); // the old DO UPDATE, if a route brought it back
      else blocks.push(row);
      return Promise.resolve({ rows: [{ id: dup ? dup.id : row.id }], rowCount: 1 });
    }
    if (/INSERT INTO config_audit/.test(sql)) {
      const [actor_account_id, key, subject_account_id, old_value, new_value, reason] = params;
      audits.push({ actor_account_id, key, subject_account_id, old_value, new_value, reason, tx });
      return Promise.resolve({ rows: [], rowCount: 1 });
    }
    if (/DELETE FROM platform_blocks WHERE id = \$1/.test(sql)) {
      const i = blocks.findIndex((b) => b.id === params[0]);
      if (i < 0) return Promise.resolve({ rows: [], rowCount: 0 });
      const [row] = blocks.splice(i, 1);
      return Promise.resolve({ rows: [{ kind: row.kind, protocol: row.protocol, target_key: row.target_key }], rowCount: 1 });
    }
    if (/FROM platform_blocks b LEFT JOIN accounts/.test(sql)) {
      const [kind, protocol, target_key] = params as string[];
      const b = blocks.find((x) => x.kind === kind && x.protocol === protocol && x.target_key === target_key);
      return Promise.resolve({
        rows: b ? [{ id: b.id, reason: b.reason, blocked_at: b.blocked_at, blocked_by_username: "ops" }] : [],
        rowCount: b ? 1 : 0,
      });
    }
    if (/SELECT 1 FROM external_sources WHERE protocol = \$1::external_protocol AND source_uri = \$2/.test(sql)) {
      const hit = heldSources.some(([p, u]) => p === params[0] && u === params[1]);
      return Promise.resolve({ rows: hit ? [{}] : [], rowCount: hit ? 1 : 0 });
    }
    return Promise.resolve({ rows: [], rowCount: 0 });
  };
}

vi.mock("@platform-pub/shared/db/client.js", () => ({
  pool: { query: (sql: string, params?: unknown[]) => scripted(false)(sql, params) },
  withTransaction: (cb: (c: { query: ReturnType<typeof scripted> }) => Promise<unknown>) =>
    cb({ query: scripted(true) }),
  loadConfig: vi.fn(async () => ({})),
}));
vi.mock("@platform-pub/shared/lib/logger.js", () => ({
  default: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));
vi.mock("../src/middleware/admin.js", () => ({
  requireAdmin: (req: any, _reply: any, done: any) => {
    req.session = { sub: "admin-id" };
    done();
  },
  getAdminIds: () => Promise.resolve(["admin-id"]),
}));
vi.mock("../src/middleware/auth.js", () => ({
  requireAuth: (req: any, _reply: any, done: any) => {
    req.session = { sub: "admin-id" };
    done();
  },
  optionalAuth: (_req: any, _reply: any, done: any) => done(),
  invalidateAuthCache: () => {},
}));
vi.mock("../src/lib/key-custody-client.js", () => ({ signEvent: vi.fn(async () => ({})) }));
vi.mock("@platform-pub/shared/lib/member-notices.js", () => ({
  sendModerationNoticeEmail: vi.fn(async () => ({ sent: 1, skipped: 0 })),
}));
vi.mock("../src/lib/source-liveness.js", () => ({
  verifySourceLiveness: vi.fn(async () => liveness),
}));

const { moderationRoutes } = await import("../src/routes/moderation.js");

async function build() {
  const app = Fastify({ logger: false });
  await app.register(moderationRoutes);
  return app;
}
const NPUB_HEX = "a".repeat(64);

beforeEach(() => {
  blocks = [];
  audits = [];
  heldSources = [];
  calls = [];
  liveness = { ok: true, sourceUri: "https://host.example/users/alice" };
});

describe("POST /admin/blocks — evidence and refusal", () => {
  it("writes the config_audit row in the SAME transaction as the block", async () => {
    const app = await build();
    const res = await app.inject({
      method: "POST",
      url: "/admin/blocks",
      payload: { kind: "npub", target: NPUB_HEX, reason: "CSAM" },
    });
    expect(res.statusCode).toBe(201);
    expect(blocks).toHaveLength(1);
    // Pre-fix: a log line, and zero config_audit references in the file.
    expect(audits).toEqual([
      expect.objectContaining({
        actor_account_id: "admin-id",
        key: "platform_block",
        old_value: null,
        new_value: `npub:nostr_external:${NPUB_HEX}`,
        reason: "CSAM",
        tx: true,
      }),
    ]);
    await app.close();
  });

  it("refuses a re-block with 409 carrying the standing row, and overwrites nothing", async () => {
    const app = await build();
    await app.inject({ method: "POST", url: "/admin/blocks", payload: { kind: "npub", target: NPUB_HEX, reason: "first" } });
    const res = await app.inject({
      method: "POST",
      url: "/admin/blocks",
      payload: { kind: "npub", target: NPUB_HEX, reason: "second" },
    });
    // Pre-fix: 201 and the first reason, actor and date gone.
    expect(res.statusCode).toBe(409);
    expect(res.json()).toMatchObject({ error: "already_blocked", block: { reason: "first" } });
    expect(blocks[0].reason).toBe("first");
    expect(audits).toHaveLength(1);
    await app.close();
  });
});

describe("POST /admin/blocks kind=source — stored in the form the add path compares", () => {
  it("canonicalises an @user@host through the same resolver addSource uses", async () => {
    const app = await build();
    liveness = { ok: true, sourceUri: "https://host.example/users/alice" };
    const res = await app.inject({
      method: "POST",
      url: "/admin/blocks",
      payload: { kind: "source", protocol: "activitypub", target: "@alice@host.example", reason: "spam farm" },
    });
    expect(res.statusCode).toBe(201);
    // Pre-fix: stored as typed, and `isSourceUriBlocked` compared the actor URI.
    expect(blocks[0].target_key).toBe("https://host.example/users/alice");
    expect(audits[0].new_value).toBe("source:activitypub:https://host.example/users/alice");
    await app.close();
  });

  it("a malformed source is 400, and nothing is stored", async () => {
    const app = await build();
    liveness = { ok: false, reason: "malformed", message: "not a feed URL" };
    const res = await app.inject({
      method: "POST",
      url: "/admin/blocks",
      payload: { kind: "source", protocol: "rss", target: "not a url", reason: "x" },
    });
    expect(res.statusCode).toBe(400);
    expect(res.json().error).toBe("invalid_source");
    expect(blocks).toHaveLength(0);
    expect(audits).toHaveLength(0);
    await app.close();
  });

  it("a dead source we already hold under that exact key is blockable as typed", async () => {
    const app = await build();
    liveness = { ok: false, reason: "unreachable", message: "timed out" };
    heldSources = [["rss", "https://dead.example/feed.xml"]];
    const res = await app.inject({
      method: "POST",
      url: "/admin/blocks",
      payload: { kind: "source", protocol: "rss", target: " https://dead.example/feed.xml ", reason: "x" },
    });
    expect(res.statusCode).toBe(201);
    expect(blocks[0].target_key).toBe("https://dead.example/feed.xml");
    await app.close();
  });

  it("a dead source we do NOT hold is 422 — a block that matches nothing is not a block", async () => {
    const app = await build();
    liveness = { ok: false, reason: "unreachable", message: "timed out" };
    const res = await app.inject({
      method: "POST",
      url: "/admin/blocks",
      payload: { kind: "source", protocol: "rss", target: "https://dead.example/feed.xml", reason: "x" },
    });
    expect(res.statusCode).toBe(422);
    expect(res.json().error).toBe("source_unresolvable");
    expect(blocks).toHaveLength(0);
    await app.close();
  });
});

describe("DELETE /admin/blocks/:id — the lift leaves the same evidence", () => {
  it("requires a reason, and audits old → NULL in the transaction", async () => {
    const app = await build();
    await app.inject({ method: "POST", url: "/admin/blocks", payload: { kind: "npub", target: NPUB_HEX, reason: "first" } });
    const id = blocks[0].id;

    const bare = await app.inject({ method: "DELETE", url: `/admin/blocks/${"1".repeat(8)}-1111-4111-8111-111111111111`, payload: {} });
    expect(bare.statusCode).toBe(400);
    expect(blocks).toHaveLength(1);

    audits = [];
    const res = await app.inject({
      method: "DELETE",
      url: `/admin/blocks/${"1".repeat(8)}-1111-4111-8111-111111111111`,
      payload: { reason: "mistaken identity" },
    });
    // The fixture id is not a uuid the table holds → 404 with nothing audited;
    // the real row's id is not uuid-shaped in this mock, so the lift is
    // exercised against a uuid the mock table is told about below.
    expect(res.statusCode).toBe(404);
    expect(audits).toHaveLength(0);

    blocks[0].id = "22222222-2222-4222-8222-222222222222";
    const lifted = await app.inject({
      method: "DELETE",
      url: "/admin/blocks/22222222-2222-4222-8222-222222222222",
      payload: { reason: "mistaken identity" },
    });
    expect(lifted.statusCode).toBe(200);
    expect(blocks).toHaveLength(0);
    expect(audits).toEqual([
      expect.objectContaining({
        key: "platform_block",
        old_value: `npub:nostr_external:${NPUB_HEX}`,
        new_value: null,
        reason: "mistaken identity",
        tx: true,
      }),
    ]);
    void id;
    await app.close();
  });
});
