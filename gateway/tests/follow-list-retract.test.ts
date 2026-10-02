import { describe, it, expect, vi, beforeEach } from "vitest";
import Fastify from "fastify";

// =============================================================================
// AN OPT-OUT MUST NOT PUBLISH (MIRROR-AUDIT §4, correctness papercuts).
//
// WHAT WAS WRONG. `retractFollowList` signs an empty kind 3 with the member's
// custodial key and fans it to the discovery relays. It was gated only by the
// operator master switch and `status = 'active'` — deliberately, because both
// callers have already flipped the member's flag off by the time it runs, so
// the row can no longer say whether they were publishing.
//
// But every path that PUBLISHES a follow list gates on
// `discovery_enabled AND publish_follow_graph`. So for a member with either
// flag off, no kind 3 has ever gone out, and the "retraction" was the FIRST
// thing about them ever put on the public mesh — announcing a pubkey that had
// deliberately stayed off it. And `publish_follow_graph` defaults TRUE, so this
// is the ordinary shape of the settings pane rather than an odd corner: a
// member who never opted into discovery at all, turning the follow-graph switch
// off, got published by the act of asking for less.
//
// WHAT IS UNDER TEST, and why each assertion is the one a wrong fix fails:
//
//   (1) WHETHER AN EVENT WAS SIGNED, never the status code. The route answers
//       200 either way — the retraction is fired and forgotten with a `.catch`
//       — so a status assertion passes against the defect exactly as against
//       the fix. The same reason the export step-up test asserts whether the
//       key was fetched.
//
//   (2) THE PRIOR STATE, NOT THE CURRENT ONE. Both callers write the column
//       before calling, so a fix that reads `discovery_enabled` inside
//       `retractFollowList` refuses the LEGITIMATE retraction too — a member
//       who really was publishing and has just opted out. That case is here as
//       a control, and it is the one that matters: over-refusing leaves a live
//       follow list on the mesh for someone who asked for it to stop.
//
//   (3) BOTH SWITCHES. `discovery_enabled` off and `publish_follow_graph` off
//       are different routes through the same handler, and the second was the
//       one reachable by default.
// =============================================================================

const ACCOUNT = "00000000-0000-4000-8000-0000000000a1";

type Call = { sql: string; params: unknown[] };
let calls: Call[] = [];
/** What the accounts row held BEFORE the route's write. */
let prior = { discovery_enabled: false, publish_follow_graph: true };
let signed: Array<{ kind: number }> = [];
let enqueued: Array<{ entityType: string }> = [];

function query(sql: string, params: unknown[] = []) {
  calls.push({ sql, params: [...params] });

  // The route's locked read of the prior flags. Answered from the SQL it was
  // handed: this is the only statement that locks the accounts row.
  if (sql.includes("FOR UPDATE")) {
    return Promise.resolve({
      rows: [
        {
          discovery_enabled: prior.discovery_enabled,
          publish_follow_graph: prior.publish_follow_graph,
        },
      ],
      rowCount: 1,
    });
  }
  // loadAccount inside discovery-publish.
  if (sql.includes("FROM accounts") && sql.includes("discovery_enabled")) {
    return Promise.resolve({
      rows: [
        {
          id: ACCOUNT,
          status: "active",
          username: "someone",
          display_name: "Someone",
          bio: null,
          avatar_blossom_url: null,
          website: null,
          nostr_pubkey: "f".repeat(64),
          hosting_type: "platform",
          self_hosted_relay_url: null,
          discovery_enabled: prior.discovery_enabled,
          publish_follow_graph: prior.publish_follow_graph,
        },
      ],
      rowCount: 1,
    });
  }
  return Promise.resolve({ rows: [], rowCount: 0 });
}

vi.mock("@platform-pub/shared/db/client.js", () => ({
  pool: { query: (sql: string, params?: unknown[]) => query(sql, params) },
  withTransaction: (fn: (c: unknown) => Promise<unknown>) =>
    fn({ query: (sql: string, params?: unknown[]) => query(sql, params) }),
}));

vi.mock("@platform-pub/shared/lib/logger.js", () => ({
  default: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

vi.mock("@platform-pub/shared/lib/relay-outbox.js", () => ({
  enqueueRelayPublish: (_c: unknown, args: { entityType: string }) => {
    enqueued.push({ entityType: args.entityType });
    return Promise.resolve();
  },
}));

// The signer is the thing that must not run. Recording it here rather than
// asserting on the enqueue alone means a fix that signs and then declines to
// enqueue — which has already spent the custodial key — still fails.
vi.mock("../src/lib/key-custody-client.js", () => ({
  signEvent: (_id: string, template: { kind: number }) => {
    signed.push({ kind: template.kind });
    return Promise.resolve({
      id: "a".repeat(64),
      pubkey: "f".repeat(64),
      created_at: 1,
      kind: template.kind,
      tags: [],
      content: "",
      sig: "b".repeat(128),
    });
  },
}));

vi.mock("../src/middleware/auth.js", () => ({
  requireAuth: (
    req: { session?: { sub: string } },
    _reply: unknown,
    done?: () => void,
  ) => {
    req.session = { sub: ACCOUNT };
    done?.();
  },
}));

process.env.DISCOVERY_PUBLISH_ENABLED = "1";

const { privacyPreferencesRoutes } = await import(
  "../src/routes/privacy-preferences.js"
);
const { retractFollowList } = await import("../src/lib/discovery-publish.js");

async function build() {
  const app = Fastify();
  await app.register(privacyPreferencesRoutes);
  return app;
}

/** The retraction is fired with `.catch`, so it settles a microtask after the
 *  reply. Flush before asserting on what it did — otherwise every case reads as
 *  "nothing was signed" and the suite passes against the defect. */
const flush = () => new Promise((r) => setTimeout(r, 0));

beforeEach(() => {
  calls = [];
  signed = [];
  enqueued = [];
  prior = { discovery_enabled: false, publish_follow_graph: true };
});

describe("retractFollowList — nothing to retract, nothing to publish", () => {
  it("signs nothing for an account that was never publishing", async () => {
    await retractFollowList(ACCOUNT, { wasPublishing: false });
    expect(signed).toEqual([]);
    expect(enqueued).toEqual([]);
  });

  it("CONTROL — signs and enqueues an empty kind 3 for one that WAS", async () => {
    await retractFollowList(ACCOUNT, { wasPublishing: true });
    expect(signed).toEqual([{ kind: 3 }]);
    expect(enqueued).toEqual([{ entityType: "follow_list" }]);
  });
});

describe("PUT /me/privacy-preferences — which retractions actually fire", () => {
  it("turning publish_follow_graph off does NOT publish for a member never opted into discovery", async () => {
    // The default shape: discovery_enabled FALSE, publish_follow_graph TRUE.
    const app = await build();
    const res = await app.inject({
      method: "PUT",
      url: "/me/privacy-preferences",
      payload: { publishFollowGraph: false },
    });
    await flush();

    expect(res.statusCode).toBe(200); // ...which it was before the fix too.
    expect(signed).toEqual([]);
    await app.close();
  });

  it("turning publish_follow_graph off DOES retract for a member who was publishing", async () => {
    prior = { discovery_enabled: true, publish_follow_graph: true };
    const app = await build();
    await app.inject({
      method: "PUT",
      url: "/me/privacy-preferences",
      payload: { publishFollowGraph: false },
    });
    await flush();

    expect(signed).toEqual([{ kind: 3 }]);
    await app.close();
  });

  it("turning discovery off DOES retract for a member who was publishing", async () => {
    prior = { discovery_enabled: true, publish_follow_graph: true };
    const app = await build();
    await app.inject({
      method: "PUT",
      url: "/me/privacy-preferences",
      payload: { discoveryEnabled: false },
    });
    await flush();

    expect(signed).toEqual([{ kind: 3 }]);
    await app.close();
  });

  it("turning discovery off does NOT retract when the follow graph was already opted out", async () => {
    // Opted into discovery but not into the follow graph, so kind 0 and 10002
    // went out and kind 3 never did. There is nothing to retract.
    prior = { discovery_enabled: true, publish_follow_graph: false };
    const app = await build();
    await app.inject({
      method: "PUT",
      url: "/me/privacy-preferences",
      payload: { discoveryEnabled: false },
    });
    await flush();

    expect(signed).toEqual([]);
    await app.close();
  });

  it("reads the prior flags under a row lock, BEFORE the write", async () => {
    const app = await build();
    await app.inject({
      method: "PUT",
      url: "/me/privacy-preferences",
      payload: { publishFollowGraph: false },
    });
    await flush();

    // STRUCTURAL PIN, not a behavioural one — a mocked client cannot evaluate
    // `FOR UPDATE`, so what is asserted is that the lock is asked for and that
    // it is asked for FIRST. An unlocked read, or one after the UPDATE, lets a
    // concurrent PUT hand the retraction the wrong answer, and the row can no
    // longer answer at all once the write has landed. Whether these statements
    // actually return the prior values is `privacy-flag-prior-state.test.ts`,
    // which is DB-backed for the reason recorded there.
    const read = calls.findIndex((c) => c.sql.includes("FOR UPDATE"));
    const write = calls.findIndex(
      (c) => c.sql.includes("UPDATE accounts") && c.sql.includes("publish_follow_graph"),
    );
    expect(read).toBeGreaterThanOrEqual(0);
    expect(write).toBeGreaterThan(read);
    await app.close();
  });
});
