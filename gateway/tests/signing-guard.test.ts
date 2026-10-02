import { describe, it, expect, vi, beforeEach } from "vitest";
import Fastify, { type FastifyInstance } from "fastify";
import rateLimit from "@fastify/rate-limit";

// =============================================================================
// WHAT THE BROWSER MAY SPEND THE CUSTODIAL KEY ON (MIRROR-AUDIT §3 *Security*,
// S15).
//
// `POST /sign` and `POST /sign-and-publish` are the one place a logged-in member
// hands the platform an event TEMPLATE THEY COMPOSED and gets it signed with a
// key they do not hold. They accepted any kind, any tags, any `created_at`, at
// any rate, and signed as a publication while the publications system is
// suspended. Four separate refusals, all of them on the same two routes, which
// is why they live behind one helper rather than being written twice.
//
// THE ASSERTION IS "WAS THE KEY TOUCHED", never the status code. A refusal that
// still called key-custody is the same signature wearing a 400 — so `signCalls`
// is the subject of every case, exactly as `account-export-step-up.test.ts` and
// `article-arrival-route.test.ts` do it. (`created_at` is the one where this
// bites: an out-of-range value that reached `signEvent` would come back as a
// perfectly well-formed signed event and a 200.)
//
// THE THREE ALLOWED KINDS ARE READ OFF THE CLIENT, not off a wish. `web/src/lib/
// sign.ts` has two callers and between them they ask for kind 1 (notes, comments,
// replies), kind 5 (deletions) and kind 30023 (articles). Everything else the
// platform signs — the kind 0/3/10002 discovery set, kind-24242 Blossom auth,
// publication events — is composed server-side and calls `signEvent` directly,
// which is why an allow-list here costs those nothing. The cases below therefore
// pin BOTH directions: the three that must work, and a representative sample of
// what must not, INCLUDING the kinds the server itself signs — those are the ones
// somebody would reasonably assume are fine.
//
// MUTATION CHECK. Drop the `refine` on `kind` and four cases fail. Drop the
// `created_at` window and two fail. Drop the publications term and one fails.
// Drop the whole `refuseUnsignable` call from ONE of the two routes and one
// fails — which is the point of testing both routes rather than the helper.
// =============================================================================

const ACCOUNT = "00000000-0000-4000-8000-0000000000a1";
const PUBLICATION = "00000000-0000-4000-8000-0000000000b2";

let signCalls: unknown[][] = [];
let publicationMemberCanPublish = true;
/** The writer gate's answer for the signer (lib/writer-gate.ts). */
let signerCanWrite = true;
/** Whose writer access the route asked about, in order. */
let canWriteAsked: unknown[] = [];

vi.mock("@platform-pub/shared/db/client.js", () => ({
  pool: {
    query: (sql: string, params: unknown[] = []) => {
      if (sql.includes("AS can_write")) {
        canWriteAsked.push(params[0]);
        return Promise.resolve({ rows: [{ can_write: signerCanWrite }], rowCount: 1 });
      }
      if (sql.includes("FROM publication_members")) {
        return Promise.resolve({
          rows: [{ can_publish: publicationMemberCanPublish }],
          rowCount: 1,
        });
      }
      return Promise.resolve({ rows: [], rowCount: 0 });
    },
  },
  withTransaction: async (fn: (c: unknown) => Promise<unknown>) =>
    fn({ query: () => Promise.resolve({ rows: [], rowCount: 0 }) }),
}));

vi.mock("@platform-pub/shared/lib/relay-outbox.js", () => ({
  enqueueRelayPublish: vi.fn(async () => undefined),
}));

vi.mock("@platform-pub/shared/lib/logger.js", () => ({
  default: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

// Reads the session from a test header so the budget case can drive two
// different members through one app instance — the limiter keys on the session,
// and a suite with only one session could not tell that from keying on the ip.
vi.mock("../src/middleware/auth.js", () => ({
  requireAuth: async (req: {
    headers: Record<string, string | undefined>;
    session?: { sub: string; pubkey: string };
  }) => {
    req.session = {
      sub: req.headers["x-test-account"] ?? ACCOUNT,
      pubkey: "b".repeat(64),
    };
  },
}));

// The signing itself is key-custody's job and is proven there. What is under
// test here is WHETHER IT IS REACHED.
vi.mock("../src/lib/key-custody-client.js", () => ({
  signEvent: async (...args: unknown[]) => {
    signCalls.push(args);
    return {
      id: "e".repeat(64),
      pubkey: "b".repeat(64),
      sig: "s".repeat(128),
      kind: 1,
      content: "",
      tags: [],
      created_at: Math.floor(Date.now() / 1000),
    };
  },
  unwrapKey: async () => ({ contentKeyBase64: "k" }),
}));

const { signingRoutes } = await import("../src/routes/signing.js");

async function build(): Promise<FastifyInstance> {
  const app = Fastify({ logger: false });
  // Non-global, exactly as gateway/src/index.ts registers it — the routes'
  // own `config.rateLimit` is what decides, and a global registration here
  // would make this file agree with itself about a gateway it had not built.
  await app.register(rateLimit, { global: false });
  await app.register(signingRoutes);
  return app;
}

type Body = {
  kind: number;
  content?: string;
  tags?: string[][];
  created_at?: number;
  publicationId?: string;
};

async function post(route: "/sign" | "/sign-and-publish", body: Body) {
  const app = await build();
  const res = await app.inject({
    method: "POST",
    url: route,
    payload: { content: "", tags: [], ...body },
  });
  await app.close();
  return res;
}

const ROUTES = ["/sign", "/sign-and-publish"] as const;
const now = () => Math.floor(Date.now() / 1000);

beforeEach(() => {
  signCalls = [];
  publicationMemberCanPublish = true;
  signerCanWrite = true;
  canWriteAsked = [];
  process.env.PUBLICATIONS_ENABLED = "0";
});

// READER-WRITER-SPLIT-ADR §4.2. A kind-30023 is an article, and signing one is
// the first writer act on both of the web's publish paths — the free path
// signs AND relays it here before it ever calls the index route. Notes and
// tombstones stay open to everyone, and must not pay for the lookup.
describe.each(ROUTES)("%s — an article is a writer act", (route) => {
  it("refuses a READER a kind-30023 without touching the key", async () => {
    signerCanWrite = false;
    const res = await post(route, { kind: 30023 });
    expect(res.statusCode).toBe(403);
    expect(res.json().error).toBe("writer_access_required");
    expect(signCalls).toHaveLength(0);
    // It asked about the member signing, not somebody else.
    expect(canWriteAsked).toEqual([ACCOUNT]);
  });

  it.each([1, 5])("signs a READER's kind %i, and never asks", async (kind) => {
    signerCanWrite = false;
    const res = await post(route, { kind });
    expect(res.statusCode).toBe(200);
    expect(signCalls).toHaveLength(1);
    expect(canWriteAsked).toEqual([]);
  });

  it("CONTROL: signs a WRITER's kind-30023", async () => {
    const res = await post(route, { kind: 30023 });
    expect(res.statusCode).toBe(200);
    expect(signCalls).toHaveLength(1);
    expect(canWriteAsked).toEqual([ACCOUNT]);
  });
});

describe.each(ROUTES)("%s — the kind allow-list", (route) => {
  it.each([1, 5, 30023])("signs kind %i, which the client actually asks for", async (kind) => {
    const res = await post(route, { kind });
    expect(signCalls).toHaveLength(1);
    expect(res.statusCode).toBe(200);
  });

  // Kinds 0/3/10002 are the discovery set and 24242 is the Blossom upload auth:
  // the platform signs all four, SERVER-side, from state it controls. A browser
  // that could ask for them could rewrite a member's public profile, replace
  // their follow list, or mint a blob-store credential.
  it.each([0, 3, 4, 6, 7, 10002, 24242, 30078])(
    "refuses kind %i without touching the key",
    async (kind) => {
      const res = await post(route, { kind });
      expect(signCalls).toHaveLength(0);
      expect(res.statusCode).toBe(400);
      // The shared envelope, never a raw `flatten()` as `error` — a client that
      // interpolates `body.error` renders "[object Object]" otherwise.
      expect(res.json().error).toBe("validation_failed");
      expect(typeof res.json().message).toBe("string");
    },
  );
});

describe.each(ROUTES)("%s — the created_at window", (route) => {
  it("accepts an omitted created_at and stamps now", async () => {
    const res = await post(route, { kind: 1 });
    expect(signCalls).toHaveLength(1);
    expect(res.statusCode).toBe(200);
  });

  it("accepts the client's own +1s bump, which is what a paywalled publish sends", async () => {
    // `web/src/lib/publish.ts` signs v2 at `signedV1.created_at + 1`, because a
    // replaceable event needs a strictly newer stamp to replace its predecessor.
    // A window that refused this would break every paywalled publish.
    const res = await post(route, { kind: 30023, created_at: now() + 1 });
    expect(signCalls).toHaveLength(1);
    expect(res.statusCode).toBe(200);
  });

  it("refuses a far-future created_at — the un-editable-article trap", async () => {
    // A kind 30023 is replaced only by one with a LATER created_at. Signed a
    // century out, it is an article its own author can never edit again:
    // permanent, silent, and the relay behaving exactly as specified.
    const res = await post(route, { kind: 30023, created_at: now() + 100 * 365 * 86400 });
    expect(signCalls).toHaveLength(0);
    expect(res.statusCode).toBe(400);
    expect(res.json().error).toBe("created_at_out_of_range");
  });

  it("refuses a far-past created_at", async () => {
    // strfry's `rejectEventsOlderThanSeconds` catches the ten-year case at the
    // far end; nothing caught the merely-old one, and a backdated event is a
    // backdated claim about when a member said something.
    const res = await post(route, { kind: 1, created_at: now() - 30 * 86400 });
    expect(signCalls).toHaveLength(0);
    expect(res.statusCode).toBe(400);
  });
});

describe.each(ROUTES)("%s — the publications suspension", (route) => {
  it("refuses to sign as a publication while the system is suspended", async () => {
    // Every other publication surface 404s on this flag. This route signing as
    // one regardless is the hole the three stray routes had: a suspended system
    // still reachable through a sibling that never learned about it.
    const res = await post(route, { kind: 30023, publicationId: PUBLICATION });
    expect(signCalls).toHaveLength(0);
    expect(res.statusCode).toBe(404);
  });

  it("refuses BEFORE the membership lookup, so the flag cannot be probed", async () => {
    // Ordering matters: a 403 for a non-member and a 404 for a member would let
    // an outsider enumerate publication membership through a suspended system.
    publicationMemberCanPublish = false;
    const res = await post(route, { kind: 30023, publicationId: PUBLICATION });
    expect(res.statusCode).toBe(404);
  });

  it("still signs as a publication once the flag is on, for a member who may publish", async () => {
    // The suspension is by flag and restoration is intended — a gate that could
    // not be lifted would be a deletion wearing a flag's clothes.
    process.env.PUBLICATIONS_ENABLED = "1";
    const res = await post(route, { kind: 30023, publicationId: PUBLICATION });
    expect(signCalls).toHaveLength(1);
    expect(res.statusCode).toBe(200);
  });

  it("keeps refusing a non-member with the flag on", async () => {
    process.env.PUBLICATIONS_ENABLED = "1";
    publicationMemberCanPublish = false;
    const res = await post(route, { kind: 30023, publicationId: PUBLICATION });
    expect(signCalls).toHaveLength(0);
    expect(res.statusCode).toBe(403);
  });
});

describe("the per-member signing budget", () => {
  it("429s past the budget, and the next MEMBER still has their own", async () => {
    // Keyed on the session, not on `req.ip`: every request on this service
    // arrives from the same nginx, so an ip-keyed bucket would be one bucket for
    // the whole platform — one member publishing would 429 everybody else's
    // replies. That is the shape S7 had to unpick on key-service, and it is
    // invisible to a suite that drives only one identity, which is why the
    // second member is here rather than the assertion being made in a comment.
    const app = await build();
    const spend = (account: string) =>
      app.inject({
        method: "POST",
        url: "/sign",
        headers: { "x-test-account": account },
        payload: { kind: 1, content: "", tags: [] },
      });

    const codes: number[] = [];
    for (let i = 0; i < 121; i++) codes.push((await spend(ACCOUNT)).statusCode);
    expect(codes.filter((c) => c === 200)).toHaveLength(120);
    expect(codes[120]).toBe(429);

    const other = await spend("00000000-0000-4000-8000-0000000000c3");
    expect(other.statusCode).toBe(200);
    await app.close();
  });
});
