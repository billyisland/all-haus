import { describe, it, expect, vi, beforeEach } from "vitest";
import Fastify from "fastify";
import cookie from "@fastify/cookie";

// =============================================================================
// WIDENING THE SCOPES MUST REACH INSTANCES WE ALREADY REGISTERED WITH
// (CROSS-NETWORK-ROUNDTRIP-ADR A3).
//
// Mastodon refuses an authorize request for scopes beyond the app's REGISTERED
// ones, and our per-instance registration was `ON CONFLICT DO NOTHING` — so
// changing MASTODON_SCOPES alone would have left every instance a member had
// already linked from on the old app, and every reconnect there refused.
//
// The pool is an in-memory `oauth_app_registrations`: SELECT, INSERT … ON
// CONFLICT DO NOTHING and the conditional UPDATE are each answered from the
// SQL and params they are handed, so a statement that lost its `client_id`
// guard or its conflict clause answers differently here, as it would in
// Postgres. What is asserted is the client_id the AUTHORIZE URL carries —
// that is what the callback must later find on the row.
// =============================================================================

process.env.APP_URL = "https://test.all.haus";

const ACCOUNT = "00000000-0000-4000-8000-0000000000a1";
const HOME = "https://home.example";
const NARROW = "read:accounts write:statuses";

type Reg = { client_id: string; client_secret_enc: string; scopes: string | null };
let registrations = new Map<string, Reg>();
let presences: Record<string, unknown>[] = [];
let appsRegistered: string[] = [];
/** Runs between our SELECT and our write — a second member connecting. */
let interleave: (() => void) | null = null;

const poolQuery = vi.fn(async (sql: string, params: unknown[] = []) => {
  if (sql.includes("FROM oauth_app_registrations")) {
    const r = registrations.get(params[0] as string);
    return { rows: r ? [{ ...r }] : [], rowCount: r ? 1 : 0 };
  }
  if (sql.includes("UPDATE oauth_app_registrations")) {
    if (!/AND client_id = \$6/.test(sql))
      throw new Error("unguarded registration UPDATE — test cannot model it");
    const r = registrations.get(params[0] as string);
    if (!r || r.client_id !== params[5]) return { rows: [], rowCount: 0 };
    registrations.set(params[0] as string, {
      client_id: params[1] as string,
      client_secret_enc: params[2] as string,
      scopes: params[3] as string,
    });
    return { rows: [], rowCount: 1 };
  }
  if (sql.includes("INSERT INTO oauth_app_registrations")) {
    if (!sql.includes("ON CONFLICT (protocol, instance_url) DO NOTHING"))
      throw new Error("registration INSERT without its conflict clause");
    if (registrations.has(params[0] as string)) return { rows: [], rowCount: 0 };
    registrations.set(params[0] as string, {
      client_id: params[1] as string,
      client_secret_enc: params[2] as string,
      scopes: params[3] as string,
    });
    return { rows: [], rowCount: 1 };
  }
  if (sql.includes("FROM network_presences")) {
    return { rows: presences.map((p) => ({ ...p })), rowCount: presences.length };
  }
  throw new Error(`unmodelled SQL: ${sql.slice(0, 80)}`);
});

vi.mock("@platform-pub/shared/db/client.js", () => ({
  pool: { query: (sql: string, params?: unknown[]) => poolQuery(sql, params) },
  withTransaction: vi.fn(),
}));
vi.mock("@platform-pub/shared/lib/logger.js", () => ({
  default: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));
vi.mock("../src/middleware/auth.js", () => ({
  requireAuth: async (req: { session?: { sub: string } }) => {
    req.session = { sub: ACCOUNT };
  },
}));
vi.mock("@platform-pub/shared/lib/env.js", () => ({
  requireEnv: (name: string) =>
    name === "APP_URL" ? "https://test.all.haus" : `stub-${name}`,
}));
vi.mock("@platform-pub/shared/lib/http-client.js", () => ({
  safeFetch: vi.fn(async (url: string, init: { body?: string } = {}) => {
    if (!url.endsWith("/api/v1/apps")) throw new Error(`unexpected fetch ${url}`);
    const n = appsRegistered.push(JSON.parse(init.body!).scopes);
    // A lost race: another member's registration lands while ours is in flight.
    interleave?.();
    return {
      ok: true,
      status: 200,
      text: JSON.stringify({ id: String(n), client_id: `new-${n}`, client_secret: `sec-${n}` }),
    };
  }),
}));
vi.mock("@platform-pub/shared/lib/crypto.js", () => ({
  encryptJson: (v: unknown) => JSON.stringify(v),
  decryptJson: (s: string) => JSON.parse(s),
}));
vi.mock("@platform-pub/shared/lib/atproto-oauth.js", () => ({
  getAtprotoClient: vi.fn(),
}));
vi.mock("../src/lib/atproto-resolve.js", () => ({
  getProfile: vi.fn(),
  isDid: vi.fn(),
  normaliseHandle: vi.fn(),
}));

const { linkedAccountsRoutes } = await import("../src/routes/linked-accounts.js");
const { MASTODON_SCOPES } = await import("@platform-pub/shared/lib/mastodon-scopes.js");

async function app() {
  const a = Fastify();
  await a.register(cookie, { secret: "x".repeat(32) });
  await a.register(linkedAccountsRoutes, { prefix: "/api/v1" });
  return a;
}

async function connect(): Promise<URL> {
  const a = await app();
  const res = await a.inject({
    method: "POST",
    url: "/api/v1/linked-accounts/mastodon",
    payload: { instanceUrl: HOME },
  });
  await a.close();
  expect(res.statusCode).toBe(200);
  return new URL(res.json().authorizeUrl);
}

const stored = (client_id: string, scopes: string | null): Reg => ({
  client_id,
  client_secret_enc: JSON.stringify(`secret-of-${client_id}`),
  scopes,
});

beforeEach(() => {
  registrations = new Map();
  presences = [];
  appsRegistered = [];
  interleave = null;
});

describe("POST /linked-accounts/mastodon — the app registration follows the scopes", () => {
  it("re-registers an app whose stored scopes are narrower, and authorizes against the new one", async () => {
    registrations.set(HOME, stored("old", NARROW));

    const url = await connect();

    expect(appsRegistered).toEqual([MASTODON_SCOPES]);
    expect(registrations.get(HOME)!.client_id).toBe("new-1");
    expect(registrations.get(HOME)!.scopes).toBe(MASTODON_SCOPES);
    expect(url.searchParams.get("client_id")).toBe("new-1");
    expect(url.searchParams.get("scope")).toBe(MASTODON_SCOPES);
  });

  it("keeps an app whose stored scopes already cover what we ask for", async () => {
    registrations.set(HOME, stored("current", MASTODON_SCOPES));

    const url = await connect();

    expect(appsRegistered).toEqual([]);
    expect(url.searchParams.get("client_id")).toBe("current");
  });

  it("a NULL stored scope is treated as narrow", async () => {
    registrations.set(HOME, stored("legacy", null));

    const url = await connect();

    expect(url.searchParams.get("client_id")).toBe("new-1");
  });

  it("a lost re-registration race authorizes against the WINNER's app, which is what the callback will read", async () => {
    registrations.set(HOME, stored("old", NARROW));
    interleave = () => registrations.set(HOME, stored("winner", MASTODON_SCOPES));

    const url = await connect();

    expect(registrations.get(HOME)!.client_id).toBe("winner");
    expect(url.searchParams.get("client_id")).toBe("winner");
  });

  it("a lost first-registration race does the same", async () => {
    interleave = () => registrations.set(HOME, stored("winner", MASTODON_SCOPES));

    const url = await connect();

    expect(url.searchParams.get("client_id")).toBe("winner");
  });
});

describe("GET /linked-accounts — needsReconnect", () => {
  const presence = (protocol: string, scope: string | undefined, is_valid = true) => ({
    id: `p-${protocol}-${scope}`,
    protocol,
    provenance: "linked",
    lifecycle_state: "active",
    external_id: "1",
    handle: "me@home.example",
    service_url: HOME,
    is_valid,
    cross_post_default: false,
    show_on_profile: false,
    token_expires_at: null,
    created_at: new Date(0),
    credentials_enc: JSON.stringify({ accessToken: "t", scope }),
  });

  async function list() {
    const a = await app();
    const res = await a.inject({ method: "GET", url: "/api/v1/linked-accounts" });
    await a.close();
    return res.json().accounts as { protocol: string; needsReconnect: boolean; isValid: boolean }[];
  }

  it("flags a Mastodon token granted fewer scopes than we ask for, and nothing else", async () => {
    presences = [
      presence("activitypub", NARROW),
      presence("activitypub", MASTODON_SCOPES),
      presence("activitypub", undefined),
      presence("activitypub", NARROW, false),
      presence("atproto", undefined),
    ];

    const accounts = await list();

    expect(accounts.map((a) => a.needsReconnect)).toEqual([true, false, true, false, false]);
    // Nothing of the credential leaves the route.
    expect(JSON.stringify(accounts)).not.toContain("accessToken");
  });
});
