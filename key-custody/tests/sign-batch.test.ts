import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from "vitest";
import Fastify, { type FastifyInstance } from "fastify";
import {
  BINDING_HEADER,
  SIGNER_HEADER,
  signInternalRequest,
} from "@platform-pub/shared/lib/internal-binding.js";

// =============================================================================
// POST /keypairs/sign-batch — N tombstones, one budget slot (CA-A8, 2026-09-29).
//
// A suspension tombstones every piece a member published, one kind-5 per
// piece, every one signed as that member — and `/keypairs/sign` carries a
// 120-a-minute budget PER SIGNER. So a member with 121 pieces was one nobody
// could suspend: the 121st sign answered 429, the gateway threw, the route
// 500'd, and `status` was never written. The batch route takes up to 500
// templates in one request against ITS OWN budget, and opens the key once.
//
// WHAT THE CASES ASSERT, AND WHY IT IS NOT THE STATUS CODE. As in
// `binding-guard.test.ts`, `crypto.js` is mocked and the load-bearing
// assertion is on the batch signer's call count and what it was handed — a
// route that fanned a batch out to N single signs would pass a status check
// perfectly. The budget case drives the REAL limiter through `buildApp`: 20
// batch calls go through for one signer, the 21st is refused, and a `/sign`
// for the same signer STILL answers, because the two budgets are separate —
// sharing the per-event bucket would make the batch spend what it exists to
// bypass.
// =============================================================================

const SECRET = "test-internal-secret-0123456789";
process.env.INTERNAL_SECRET = SECRET;
process.env.DATABASE_URL ??= "postgres://unused/unused";
process.env.ACCOUNT_KEY_HEX ??= "a".repeat(64);

const signed = (kind: number, i: number) => ({
  id: String(i).padStart(64, "0"),
  pubkey: "p".repeat(64),
  sig: "s".repeat(128),
  kind,
  content: "",
  tags: [] as string[][],
  created_at: 1,
});
const signSpy = vi.fn(async () => signed(1, 0));
const batchSpy = vi.fn(async (_signer: string, templates: Array<{ kind: number }>) =>
  templates.map((t, i) => signed(t.kind, i)),
);

vi.mock("../src/lib/crypto.js", () => ({
  generateKeypair: vi.fn(() => ({ pubkeyHex: "p".repeat(64), privkeyEncrypted: "enc" })),
  signEvent: (...a: unknown[]) => signSpy(...(a as [])),
  signEventsBatch: (...a: unknown[]) => batchSpy(...(a as [string, Array<{ kind: number }>])),
  unwrapKey: vi.fn(async () => "key"),
  exportSecretKey: vi.fn(async () => ({ privkeyHex: "0".repeat(64), nsec: "nsec1zzz" })),
  nip44Encrypt: vi.fn(async () => "ct"),
  nip44EncryptBatch: vi.fn(async () => ["ct"]),
  nip44Decrypt: vi.fn(async () => "pt"),
  nip44DecryptBatch: vi.fn(async () => []),
}));

const ACCOUNT_A = "11111111-1111-4111-8111-111111111111";
const ACCOUNT_B = "22222222-2222-4222-8222-222222222222";
const ACCOUNT_C = "33333333-3333-4333-8333-333333333333";

const BATCH_PATH = "/api/v1/keypairs/sign-batch";
const SIGN_PATH = "/api/v1/keypairs/sign";

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
  batchSpy.mockClear();
});

/** A request as the gateway sends it: bearer, binding, and the signer hint. */
function send(path: string, body: unknown, opts: { omitBinding?: boolean } = {}) {
  const rawBody = JSON.stringify(body);
  const signerId = (body as { signerId?: string }).signerId;
  const headers: Record<string, string> = {
    "content-type": "application/json",
    "x-internal-secret": SECRET,
    [SIGNER_HEADER]: signerId ?? "",
  };
  if (!opts.omitBinding) {
    headers[BINDING_HEADER] = signInternalRequest(SECRET, { method: "POST", path, rawBody });
  }
  return app.inject({ method: "POST", url: path, headers, payload: rawBody });
}

const tombstone = (i: number) => ({
  kind: 5,
  content: "",
  tags: [["e", String(i).padStart(64, "e")]],
});
const batchBody = (signerId: string, n: number) => ({
  signerId,
  signerType: "account",
  events: Array.from({ length: n }, (_, i) => tombstone(i)),
});

describe("POST /keypairs/sign-batch", () => {
  it("signs 300 tombstones in ONE key opening, positionally, and never through the single signer", async () => {
    const res = await send(BATCH_PATH, batchBody(ACCOUNT_A, 300));
    expect(res.statusCode).toBe(200);
    expect(batchSpy).toHaveBeenCalledTimes(1);
    expect(signSpy).not.toHaveBeenCalled();
    const [signer, templates] = batchSpy.mock.calls[0];
    expect(signer).toBe(ACCOUNT_A);
    expect(templates).toHaveLength(300);
    // `created_at` is stamped where the caller left it out.
    expect(templates.every((t: { created_at?: number }) => typeof t.created_at === "number")).toBe(true);
    const body = res.json() as { signed: Array<{ id: string; kind: number }> };
    expect(body.signed).toHaveLength(300);
    expect(body.signed[299].id).toBe(String(299).padStart(64, "0"));
    expect(body.signed.every((s) => s.kind === 5)).toBe(true);
  });

  it("refuses more than 500 in one call WITHOUT opening the key", async () => {
    const res = await send(BATCH_PATH, batchBody(ACCOUNT_A, 501));
    expect(batchSpy).not.toHaveBeenCalled();
    expect(res.statusCode).toBe(400);
  });

  it("refuses an unbound request WITHOUT opening the key — same guard as every key route", async () => {
    const res = await send(BATCH_PATH, batchBody(ACCOUNT_B, 3), { omitBinding: true });
    expect(batchSpy).not.toHaveBeenCalled();
    expect(res.statusCode).toBe(401);
  });

  it("has its OWN budget: the 21st batch in a minute is refused, and the single route for the same signer still answers", async () => {
    for (let i = 0; i < 20; i++) {
      const res = await send(BATCH_PATH, batchBody(ACCOUNT_C, 2));
      expect(res.statusCode, `batch ${i + 1}`).toBe(200);
    }
    const refused = await send(BATCH_PATH, batchBody(ACCOUNT_C, 2));
    expect(refused.statusCode).toBe(429);
    expect(batchSpy).toHaveBeenCalledTimes(20);

    // The per-event bucket is untouched by twenty batches — 10,000 tombstones
    // signed and the member can still post a note.
    const single = await send(SIGN_PATH, {
      signerId: ACCOUNT_C,
      signerType: "account",
      event: { kind: 1, content: "still here", tags: [] },
    });
    expect(single.statusCode).toBe(200);
    expect(signSpy).toHaveBeenCalledTimes(1);
  });
});
