import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from "vitest";
import Fastify, { type FastifyInstance } from "fastify";
import {
  BINDING_HEADER,
  SIGNER_HEADER,
  signInternalRequest,
} from "@platform-pub/shared/lib/internal-binding.js";

// =============================================================================
// EVERY DM DECRYPT AND PAYWALL UNWRAP LEAVES A ROW (L6.6; D4 §2.1, D10 §2)
//
// The DPIA says decryption paths are logged. They were — at `logger.debug`,
// which is below `LOG_LEVEL=info`, so in every deployment this platform has
// ever run they were logged nowhere. `key_access_log` (migration 213) is that
// claim made true, and this is what holds it.
//
// IT ASSERTS THE INSERT'S PARAMS, NOT THAT SOMETHING WAS WRITTEN. A row with
// the wrong account in it is worse than no row: it says a member opened
// something they did not. So the pool is mocked, the INSERT is captured, and
// the assertion is on the values — whose key, what for, who asked — matched
// against the arguments the request carried. Transposing `account_id` and
// `actor_account_id` is invisible while both are the same member, which they
// are on both live paths today, so the test hands them DIFFERENT values.
//
// AND IT ASSERTS THE ORDER. The row goes down BEFORE the plaintext goes out
// (the export rule's shape: record before the disclosure). A decrypt whose
// INSERT then fails must answer 500 and hand back nothing, or the audit trail
// has a gap exactly where a disclosure happened.
//
// MUTATION CHECK: drop the `recordKeyAccess` call from either route and that
// route's case fails; swap `accountId` and `actorAccountId` at the call site
// and the param assertions fail; move the call after `reply.send` and the
// ordering case fails.
// =============================================================================

const SECRET = "test-internal-secret-0123456789";
process.env.INTERNAL_SECRET = SECRET;
process.env.DATABASE_URL ??= "postgres://unused/unused";
process.env.ACCOUNT_KEY_HEX ??= "a".repeat(64);

/** Whose key. */
const OWNER = "11111111-1111-4111-8111-111111111111";
/** Who asked — deliberately NOT the owner, so a transposition is visible. */
const ACTOR = "22222222-2222-4222-8222-222222222222";
const PUBLICATION = "33333333-3333-4333-8333-333333333333";

let inserts: { sql: string; params: unknown[] }[] = [];
let insertFails = false;
/** Everything the service did, in order, so "row before plaintext" is testable. */
let trace: string[] = [];

vi.mock("@platform-pub/shared/db/client.js", () => ({
  pool: {
    query: async (sql: string, params: unknown[] = []) => {
      if (sql.includes("INSERT INTO key_access_log")) {
        inserts.push({ sql, params });
        trace.push("insert");
        if (insertFails) throw new Error("db down");
      }
      return { rows: [], rowCount: 0 };
    },
  },
}));

const warn = vi.fn();
vi.mock("@platform-pub/shared/lib/logger.js", () => ({
  default: { info: vi.fn(), warn: (...a: unknown[]) => warn(...a), error: vi.fn(), debug: vi.fn() },
}));

vi.mock("../src/lib/crypto.js", () => ({
  generateKeypair: vi.fn(() => ({ pubkeyHex: "p".repeat(64), privkeyEncrypted: "enc" })),
  signEvent: vi.fn(async () => ({
    id: "e".repeat(64), pubkey: "p".repeat(64), sig: "s".repeat(128),
    kind: 1, content: "", tags: [] as string[][], created_at: 1,
  })),
  unwrapKey: vi.fn(async () => { trace.push("unwrap"); return "content-key"; }),
  exportSecretKey: vi.fn(async () => ({ privkeyHex: "0".repeat(64), nsec: "nsec1zzz" })),
  nip44Encrypt: vi.fn(async () => "ct"),
  nip44EncryptBatch: vi.fn(async () => ["ct"]),
  nip44Decrypt: vi.fn(async () => { trace.push("decrypt"); return "the plaintext"; }),
  // Item i's plaintext is `pt-i`, or null where the ciphertext says "bad" —
  // the batch's partial outcome, which must record only what was disclosed.
  nip44DecryptBatch: vi.fn(async (_s: string, items: { ciphertext: string }[]) => {
    trace.push("decrypt");
    return items.map((it, i) => ({ plaintext: it.ciphertext === "bad" ? null : `pt-${i}` }));
  }),
}));

const DECRYPT_PATH = "/api/v1/keypairs/nip44-decrypt";
const UNWRAP_PATH = "/api/v1/keypairs/unwrap";
const SIGN_PATH = "/api/v1/keypairs/sign";
const BATCH_PATH = "/api/v1/keypairs/nip44-decrypt-batch";

let app: FastifyInstance;

beforeAll(async () => {
  const { buildApp } = await import("../src/app.js");
  app = await buildApp(Fastify({ logger: false }));
  await app.ready();
});

afterAll(async () => {
  await app.close();
});

beforeEach(() => {
  inserts = [];
  trace = [];
  insertFails = false;
  warn.mockClear();
});

/** A request as the gateway sends it — real binding, real raw body. */
function send(path: string, body: unknown) {
  const rawBody = JSON.stringify(body);
  return app.inject({
    method: "POST",
    url: path,
    headers: {
      "content-type": "application/json",
      "x-internal-secret": SECRET,
      [SIGNER_HEADER]: (body as { signerId?: string }).signerId ?? "",
      [BINDING_HEADER]: signInternalRequest(SECRET, { method: "POST", path, rawBody }),
    },
    payload: rawBody,
  });
}

const decryptBody = (extra: Record<string, unknown> = {}) => ({
  signerId: OWNER,
  signerType: "account",
  actorAccountId: ACTOR,
  senderPubkey: "a".repeat(64),
  ciphertext: "ciphertext",
  ...extra,
});

const unwrapBody = (extra: Record<string, unknown> = {}) => ({
  signerId: OWNER,
  signerType: "account",
  actorAccountId: ACTOR,
  encryptedKey: "wrapped",
  ...extra,
});

describe("key_access_log", () => {
  it("records a DM decrypt with whose key, what for, and who asked", async () => {
    const res = await send(DECRYPT_PATH, decryptBody());

    expect(res.statusCode).toBe(200);
    expect(inserts).toHaveLength(1);
    // The order is (account_id, purpose, actor_account_id, count) — see the
    // INSERT in `lib/access-log.ts`. Owner first, actor third; the two are
    // different values here precisely so a transposition cannot pass.
    expect(inserts[0].params).toEqual([OWNER, "dm_decrypt", ACTOR, 1]);
  });

  it("records a paywall unwrap under its own purpose", async () => {
    const res = await send(UNWRAP_PATH, unwrapBody());

    expect(res.statusCode).toBe(200);
    expect(inserts).toHaveLength(1);
    expect(inserts[0].params).toEqual([OWNER, "paywall_unwrap", ACTOR, 1]);
  });

  it("writes the row BEFORE the plaintext leaves the service", async () => {
    await send(DECRYPT_PATH, decryptBody());
    // Decrypt, then record, then reply. The other order would leave a
    // disclosure with no record whenever the write failed.
    expect(trace).toEqual(["decrypt", "insert"]);
  });

  it("FAILS THE REQUEST if the row cannot be written — no silent gap", async () => {
    insertFails = true;
    const res = await send(DECRYPT_PATH, decryptBody());

    expect(res.statusCode).toBe(500);
    // And the caller is given nothing: no plaintext rides a 500.
    expect(res.body).not.toContain("the plaintext");
  });

  it("does NOT record the paths that are the member's own act", async () => {
    // Signing an event the member composed is already evidenced by the event.
    // A route added here later that OPENS something has to add itself.
    const res = await send(SIGN_PATH, {
      signerId: OWNER,
      signerType: "account",
      event: { kind: 1, content: "hello", tags: [] as string[][] },
    });
    expect(res.statusCode).toBe(200);
    expect(inserts).toHaveLength(0);
  });

  it("REFUSES a request with no actor — the field is not optional", async () => {
    const { actorAccountId: _omitted, ...noActor } = decryptBody();
    const res = await send(DECRYPT_PATH, noActor);

    expect(res.statusCode).toBe(400);
    expect(inserts).toHaveLength(0);
  });

  it("records a BATCH as one row per plaintext, in ONE statement", async () => {
    // §0ab tail (iv): the rows went down one INSERT per message, serially —
    // an inbox of 500 was 500 round trips. The count is the number of
    // plaintexts handed back, never the number asked for: an item that failed
    // to decrypt disclosed nothing and must not be claimed as a disclosure.
    const items = ["c0", "bad", "c2", "c3"].map((ciphertext) => ({
      senderPubkey: "a".repeat(64),
      ciphertext,
    }));
    const res = await send(BATCH_PATH, {
      signerId: OWNER,
      signerType: "account",
      actorAccountId: ACTOR,
      items,
    });

    expect(res.statusCode).toBe(200);
    expect(inserts).toHaveLength(1);
    expect(inserts[0].params).toEqual([OWNER, "dm_decrypt", ACTOR, 3]);
    expect(trace).toEqual(["decrypt", "insert"]);
  });

  it("writes nothing for a batch that disclosed nothing", async () => {
    const res = await send(BATCH_PATH, {
      signerId: OWNER,
      signerType: "account",
      actorAccountId: ACTOR,
      items: [{ senderPubkey: "a".repeat(64), ciphertext: "bad" }],
    });

    expect(res.statusCode).toBe(200);
    expect(inserts).toHaveLength(0);
  });

  it("says out loud when a publication access cannot be recorded", async () => {
    // `key_access_log.account_id` FKs `accounts`, so a publication signer
    // cannot be a row. It is warned about rather than swallowed: a hole in an
    // audit trail that says nothing looks exactly like an empty audit trail.
    const res = await send(UNWRAP_PATH, unwrapBody({ signerId: PUBLICATION, signerType: "publication" }));

    expect(res.statusCode).toBe(200);
    expect(inserts).toHaveLength(0);
    expect(warn).toHaveBeenCalled();
    expect(JSON.stringify(warn.mock.calls)).toContain("NOT recorded");
  });
});

describe("the bearer mismatch is no longer silent", () => {
  it("logs a warning naming the path when the internal secret is wrong", async () => {
    const rawBody = JSON.stringify(decryptBody());
    const res = await app.inject({
      method: "POST",
      url: DECRYPT_PATH,
      headers: {
        "content-type": "application/json",
        "x-internal-secret": "not-the-secret-not-the-secret!",
        [BINDING_HEADER]: signInternalRequest(SECRET, {
          method: "POST", path: DECRYPT_PATH, rawBody,
        }),
      },
      payload: rawBody,
    });

    expect(res.statusCode).toBe(401);
    // The caller still learns only 401 — the reason is the operator's.
    expect(res.json()).toEqual({ error: "Unauthorized" });
    expect(JSON.stringify(warn.mock.calls)).toContain("internal secret mismatch");
  });
});
