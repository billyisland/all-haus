import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from "vitest";
import Fastify, { type FastifyInstance } from "fastify";
import {
  BINDING_HEADER,
  SIGNER_HEADER,
  signInternalRequest,
} from "@platform-pub/shared/lib/internal-binding.js";

// =============================================================================
// The bearer secret is no longer enough (MIRROR-AUDIT §3 *Security*, S15).
//
// key-custody signs any kind for any account and exports any account's root
// nsec, and it granted all of that on `X-Internal-Secret` alone — a bearer, on a
// plaintext compose network. One captured request yielded the credential, and
// with it every other request an attacker cared to compose: retargeting
// `/keypairs/export` from the captured account to any other was a field edit.
//
// WHAT THIS ASSERTS, AND WHY IT IS NOT THE STATUS CODE. A guard that refuses
// after doing the work is the same disclosure wearing a 401, so every case below
// asserts WHETHER THE KEY WAS TOUCHED — `crypto.js` is mocked and the assertion
// is on its call count. (Same rule as `account-export-step-up.test.ts` and
// `article-arrival-route.test.ts`.) The status code is checked too, but it is
// never the thing that decides the case.
//
// IT DRIVES THE REAL ASSEMBLY. `buildApp` is the function `index.ts` calls — the
// raw-body content-type parser, the real limiter options, the real routes, in
// that order. The parser is load-bearing and invisible: the binding hashes the
// bytes the caller SENT, so a receiver that re-serialised `req.body` would
// reject good requests unpredictably. Only an end-to-end drive catches that, and
// only if the request is minted by the SAME function the gateway uses —
// `signInternalRequest`, imported here from `shared`, exactly as
// `gateway/src/lib/key-custody-client.ts` imports it.
//
// MUTATION CHECK, and one thing it taught. Drop the raw-body parser and two
// cases fail; take `path` out of the binding tuple, REBUILD `shared` (this
// service imports it from `dist`, so an unbuilt edit mutates nothing and the
// green tick means only that), and the route-escalation case fails. An earlier
// draft also named the signer in the tuple: no mutation could distinguish it,
// because the signer is a field of the body and the body is hashed — so it was
// removed rather than left standing as a term whose comment claimed a job it did
// not have. What survives here is the honest pair, the path and the bytes.
// =============================================================================

const SECRET = "test-internal-secret-0123456789";
process.env.INTERNAL_SECRET = SECRET;
process.env.DATABASE_URL ??= "postgres://unused/unused";
process.env.ACCOUNT_KEY_HEX ??= "a".repeat(64);

const signSpy = vi.fn(async () => ({
  id: "e".repeat(64),
  pubkey: "p".repeat(64),
  sig: "s".repeat(128),
  kind: 1,
  content: "",
  tags: [] as string[][],
  created_at: 1,
}));
const exportSpy = vi.fn(async () => ({ privkeyHex: "0".repeat(64), nsec: "nsec1zzz" }));

vi.mock("../src/lib/crypto.js", () => ({
  generateKeypair: vi.fn(() => ({ pubkeyHex: "p".repeat(64), privkeyEncrypted: "enc" })),
  signEvent: (...a: unknown[]) => signSpy(...(a as [])),
  unwrapKey: vi.fn(async () => "key"),
  exportSecretKey: (...a: unknown[]) => exportSpy(...(a as [])),
  nip44Encrypt: vi.fn(async () => "ct"),
  nip44EncryptBatch: vi.fn(async () => ["ct"]),
  nip44Decrypt: vi.fn(async () => "pt"),
}));

const ACCOUNT_A = "11111111-1111-4111-8111-111111111111";
const ACCOUNT_B = "22222222-2222-4222-8222-222222222222";
// Fresh signers for the budget cases. The limiter runs on `onRequest`, ahead of
// the guard, so every REFUSED request above also spent a slot — which is correct
// (an attacker probing the guard must not get an unlimited number of goes) and
// is why the budget cases cannot reuse an account the guard cases have touched.
const ACCOUNT_C = "33333333-3333-4333-8333-333333333333";
const ACCOUNT_D = "44444444-4444-4444-8444-444444444444";

const SIGN_PATH = "/api/v1/keypairs/sign";
const EXPORT_PATH = "/api/v1/keypairs/export";

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
  signSpy.mockClear();
  exportSpy.mockClear();
});

/** A request as the gateway sends it: bearer, binding, and the signer hint. */
function send(
  path: string,
  body: unknown,
  opts: {
    /** Mint the binding for THIS request instead — the capture being reused. */
    bindAs?: { path: string; rawBody: string };
    omitBinding?: boolean;
    secret?: string;
    signerHeader?: string;
  } = {},
) {
  const rawBody = JSON.stringify(body);
  const signerId = (body as { signerId?: string }).signerId;
  const bindInput = opts.bindAs ?? { path, rawBody };
  const headers: Record<string, string> = {
    "content-type": "application/json",
    "x-internal-secret": opts.secret ?? SECRET,
    [SIGNER_HEADER]: opts.signerHeader ?? signerId ?? "",
  };
  if (!opts.omitBinding) {
    headers[BINDING_HEADER] = signInternalRequest(opts.secret ?? SECRET, {
      method: "POST",
      ...bindInput,
    });
  }
  return app.inject({ method: "POST", url: path, headers, payload: rawBody });
}

const signBody = (signerId: string) => ({
  signerId,
  signerType: "account",
  event: { kind: 1, content: "hello", tags: [] },
});

describe("key-custody per-request binding", () => {
  it("signs for a properly bound request — the gateway's own minting round-trips", async () => {
    // This is the case that proves the two sides agree about the bytes. If the
    // raw-body hash were computed over a re-serialisation, this fails.
    const res = await send(SIGN_PATH, signBody(ACCOUNT_A));
    expect(res.statusCode).toBe(200);
    expect(signSpy).toHaveBeenCalledTimes(1);
  });

  it("refuses the pre-S15 request — bearer secret, no binding — without signing", async () => {
    const res = await send(SIGN_PATH, signBody(ACCOUNT_A), { omitBinding: true });
    expect(signSpy).not.toHaveBeenCalled();
    expect(res.statusCode).toBe(401);
  });

  it("refuses an export RETARGETED at another account, without reading a key", async () => {
    // The attack the bearer header allowed: capture account A's export, change
    // the uuid, receive account B's root nsec. The binding covers the signer, so
    // the edited request no longer verifies.
    const captured = JSON.stringify({ signerId: ACCOUNT_A, signerType: "account" });
    const res = await send(
      EXPORT_PATH,
      { signerId: ACCOUNT_B, signerType: "account" },
      { bindAs: { path: EXPORT_PATH, rawBody: captured } },
    );
    expect(exportSpy).not.toHaveBeenCalled();
    expect(res.statusCode).toBe(401);
  });

  it("refuses a captured SIGN replayed at the EXPORT route", async () => {
    const body = { signerId: ACCOUNT_A, signerType: "account" };
    const raw = JSON.stringify(body);
    const res = await send(EXPORT_PATH, body, {
      bindAs: { path: SIGN_PATH, rawBody: raw },
    });
    expect(exportSpy).not.toHaveBeenCalled();
    expect(res.statusCode).toBe(401);
  });

  it("refuses a body edited in flight under a valid binding", async () => {
    const original = JSON.stringify(signBody(ACCOUNT_A));
    const tampered = { ...signBody(ACCOUNT_A), event: { kind: 30023, content: "not this", tags: [] } };
    const res = await send(SIGN_PATH, tampered, { bindAs: { path: SIGN_PATH, rawBody: original } });
    expect(signSpy).not.toHaveBeenCalled();
    expect(res.statusCode).toBe(401);
  });

  it("ignores the x-signer-id header when deciding — it is a bucket key, not a claim", async () => {
    // The header exists so the limiter has something to key on before the body
    // is parsed, and nothing authorises on it. Here it says A while the body
    // says B and the binding was minted over A's body: an implementation that
    // let the header stand in for the subject would have to believe this one.
    const captured = JSON.stringify({ signerId: ACCOUNT_A, signerType: "account" });
    const res = await send(
      EXPORT_PATH,
      { signerId: ACCOUNT_B, signerType: "account" },
      { bindAs: { path: EXPORT_PATH, rawBody: captured }, signerHeader: ACCOUNT_A },
    );
    expect(exportSpy).not.toHaveBeenCalled();
    expect(res.statusCode).toBe(401);
  });

  it("refuses a binding minted under a different secret", async () => {
    const res = await send(SIGN_PATH, signBody(ACCOUNT_A), { secret: "wrong-secret-wrong-secret" });
    expect(signSpy).not.toHaveBeenCalled();
    expect(res.statusCode).toBe(401);
  });

  it("keeps GET /auth-check on the bare secret — the parity probe must still pass", async () => {
    // Deliberately NOT bound. It is the shared boot-time probe that also runs
    // against payment-service and key-service (gateway/src/lib/internal-parity.ts)
    // and sends the header and nothing else; binding it would make one probe
    // three, and it discloses nothing. A 401 here crash-loops the gateway.
    const ok = await app.inject({
      method: "GET",
      url: "/api/v1/auth-check",
      headers: { "x-internal-secret": SECRET },
    });
    expect(ok.statusCode).toBe(200);

    const bad = await app.inject({
      method: "GET",
      url: "/api/v1/auth-check",
      headers: { "x-internal-secret": "nope" },
    });
    expect(bad.statusCode).toBe(401);
  });
});

describe("key-custody per-signer budgets", () => {
  it("spends the export budget per signer, and 429s rather than 500s", async () => {
    // `exportBudget` is 5/min. The sixth request for the SAME signer is refused
    // by the limiter — and refused with the plugin's own 429, which needs
    // `statusCode` in the error builder; without it every rate-limited request
    // answers 500, which is what key-service shipped for the whole life of its
    // limiter (S7).
    const codes: number[] = [];
    for (let i = 0; i < 6; i++) {
      const res = await send(EXPORT_PATH, { signerId: ACCOUNT_C, signerType: "account" });
      codes.push(res.statusCode);
    }
    expect(codes.slice(0, 5)).toEqual([200, 200, 200, 200, 200]);
    expect(codes[5]).toBe(429);

    // A different signer has its own bucket — that is the whole point of keying
    // on the signer rather than on `req.ip`, which is the gateway for every
    // request that ever reaches this service.
    const other = await send(EXPORT_PATH, { signerId: ACCOUNT_D, signerType: "account" });
    expect(other.statusCode).toBe(200);
  });
});
