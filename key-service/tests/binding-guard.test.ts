import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from "vitest";
import Fastify, { type FastifyInstance } from "fastify";
import {
  BINDING_HEADER,
  keyServiceSubject,
  signInternalRequest,
} from "@platform-pub/shared/lib/internal-binding.js";

// =============================================================================
// The bearer secret is no longer enough here either (MIRROR-AUDIT §3, S16).
//
// key-service holds every content key on the platform: it writes the vault,
// issues a paying reader's key, hands an author their own paywalled body, and
// exports every vault key one writer holds. All of it was granted on
// `X-Internal-Secret` alone — a bearer, on a plaintext compose network — which
// is the same finding S15 closed one service over, and it survived S15 because
// S15's row said so out loud.
//
// WHAT MAKES THIS SERVICE DIFFERENT, and what these cases exist to prove. On
// key-custody the request's SUBJECT is a field of the body, so hashing the body
// covers a retarget. Here the subject is in the HEADERS against a body that is
// `{}` or absent: `POST /articles/:id/key` takes its reader from `x-reader-id`,
// and `GET /writers/export-keys` has no body at all. Path-plus-body-hash would
// therefore have let a captured export be pointed at ANY writer by editing one
// header — the same field edit that made key-custody's export the S15 finding.
// The `subject` term in the shared tuple is the answer, and the retarget cases
// below are the only ones that can tell whether it is doing a job.
//
// WHAT THIS ASSERTS, AND WHY IT IS NOT THE STATUS CODE. A guard that refuses
// after doing the work is the same disclosure wearing a 401, so the cases assert
// WHETHER A CONTENT KEY WAS TOUCHED — `kms.js` and `nip44.js` are mocked and the
// assertion is on their call counts.
//
// IT DRIVES THE REAL ASSEMBLY. `buildApp` is what `index.ts` calls, so the
// raw-body content-type parser, the real limiter options and the real routes are
// all here in the order the service boots them. The parser is load-bearing and
// invisible: the binding hashes the bytes the caller SENT, and a receiver that
// re-serialised `req.body` would reject good requests unpredictably. Only an
// end-to-end drive catches that, and only if the request is minted by the SAME
// function the gateway uses — `signInternalRequest`, imported from `shared`
// exactly as `gateway/src/lib/key-service-client.ts` imports it.
//
// MUTATION CHECK. Drop `subject` from the tuple (and REBUILD `shared` — this
// service imports it from `dist`, so an unbuilt edit mutates nothing and a green
// tick means only that) and both retarget cases fail while everything else stays
// green. Drop the raw-body parser and the bound-POST case fails. Take `path` out
// and the route-escalation case fails. Exempt nothing and the `/auth-check` case
// fails, which is the one that keeps the gateway able to boot.
// =============================================================================

const SECRET = "test-internal-secret-0123456789";
process.env.INTERNAL_SECRET = SECRET;
process.env.DATABASE_URL ??= "postgres://unused/unused";
process.env.KMS_MASTER_KEY_HEX ??= "a".repeat(64);

const decryptSpy = vi.fn(() => new Uint8Array(32));
const wrapSpy = vi.fn(() => "wrapped-key");

vi.mock("../src/lib/kms.js", () => ({
  decryptContentKey: (...a: unknown[]) => decryptSpy(...(a as [])),
  encryptContentKey: vi.fn(() => "enc"),
}));
vi.mock("../src/lib/nip44.js", () => ({
  wrapKeyForReader: (...a: unknown[]) => wrapSpy(...(a as [])),
}));

// One vault key row, so the export route has something to wrap. The guard runs
// long before this, which is exactly the point: if the query is reached at all
// on a refused request, the refusal came too late.
vi.mock("@platform-pub/shared/db/client.js", () => ({
  pool: {
    query: vi.fn(async () => ({
      rows: [
        {
          article_id: "3f0a2b1c-0000-4000-8000-000000000001",
          nostr_event_id: "e".repeat(64),
          nostr_d_tag: "d-tag",
          title: "A piece",
          content_key_enc: "enc",
          algorithm: "aes-256-gcm",
        },
      ],
    })),
    end: vi.fn(async () => {}),
  },
  withTransaction: vi.fn(),
}));

const WRITER_A = "11111111-1111-4111-8111-111111111111";
const WRITER_B = "22222222-2222-4222-8222-222222222222";
const PUBKEY = "f".repeat(64);

const EXPORT_PATH = "/api/v1/writers/export-keys";
const PAYWALL_PATH =
  "/api/v1/articles/3f0a2b1c-0000-4000-8000-000000000001/paywall-content";
const AUTH_CHECK = "/api/v1/auth-check";

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
  decryptSpy.mockClear();
  wrapSpy.mockClear();
});

// The subject terms come from `shared`'s own `keyServiceSubject` — the SAME
// function the gateway mints with and key-service verifies with — so this file
// cannot pass by agreeing with a private copy of the order.
const subject = keyServiceSubject;

interface SendOpts {
  method?: "GET" | "POST";
  /** Identity headers actually SENT. */
  headers?: Record<string, string>;
  /** The tuple the binding is minted over — a capture being reused. */
  bindAs?: { method?: string; path?: string; rawBody?: string; subject?: string[] };
  omitBinding?: boolean;
  bindAt?: number;
  body?: unknown;
  /** Literal bytes to send AND hash, for the non-canonical-JSON case. */
  rawBodyOverride?: string;
}

function send(path: string, opts: SendOpts = {}) {
  const method = opts.method ?? "GET";
  const rawBody =
    opts.rawBodyOverride ??
    (opts.body === undefined ? "" : JSON.stringify(opts.body));
  const sent = opts.headers ?? {};
  const headers: Record<string, string> = {
    "x-internal-secret": SECRET,
    ...sent,
  };
  if (rawBody) headers["content-type"] = "application/json";
  if (!opts.omitBinding) {
    headers[BINDING_HEADER] = signInternalRequest(
      SECRET,
      {
        method: opts.bindAs?.method ?? method,
        path: opts.bindAs?.path ?? path,
        rawBody: opts.bindAs?.rawBody ?? rawBody,
        subject:
          opts.bindAs?.subject ??
          subject({
            readerId: sent["x-reader-id"],
            readerPubkey: sent["x-reader-pubkey"],
            writerId: sent["x-writer-id"],
            writerPubkey: sent["x-writer-pubkey"],
          }),
      },
      opts.bindAt,
    );
  }
  return app.inject({
    method,
    url: path,
    headers,
    payload: rawBody || undefined,
  });
}

const writerHeaders = (id: string) => ({
  "x-writer-id": id,
  "x-writer-pubkey": PUBKEY,
});

describe("key-service per-request binding", () => {
  it("exports for a properly bound request — the gateway's own minting round-trips", async () => {
    const res = await send(EXPORT_PATH, { headers: writerHeaders(WRITER_A) });
    expect(res.statusCode).toBe(200);
    expect(wrapSpy).toHaveBeenCalledTimes(1);
  });

  it("refuses a bearer-only request, and never touches a key", async () => {
    const res = await send(EXPORT_PATH, {
      headers: writerHeaders(WRITER_A),
      omitBinding: true,
    });
    expect(res.statusCode).toBe(401);
    expect(decryptSpy).not.toHaveBeenCalled();
    expect(wrapSpy).not.toHaveBeenCalled();
  });

  it("refuses a capture RETARGETED at another writer — the subject term's job", async () => {
    // A binding legitimately minted for writer A, replayed with the header
    // pointing at writer B. Path and body are unchanged, so only the subject
    // terms can tell these apart — which is the whole reason they exist.
    const res = await send(EXPORT_PATH, {
      headers: writerHeaders(WRITER_B),
      bindAs: { subject: subject({ writerId: WRITER_A, writerPubkey: PUBKEY }) },
    });
    expect(res.statusCode).toBe(401);
    expect(wrapSpy).not.toHaveBeenCalled();
  });

  it("refuses a capture retargeted at another writer's PUBKEY", async () => {
    // The subtler half: same writer id, a pubkey the attacker holds the secret
    // key for. Without `x-writer-pubkey` in the tuple this returns every one of
    // that writer's content keys wrapped to the attacker.
    const res = await send(EXPORT_PATH, {
      headers: { "x-writer-id": WRITER_A, "x-writer-pubkey": "a".repeat(64) },
      bindAs: { subject: subject({ writerId: WRITER_A, writerPubkey: PUBKEY }) },
    });
    expect(res.statusCode).toBe(401);
    expect(wrapSpy).not.toHaveBeenCalled();
  });

  it("refuses a capture ESCALATED to another route", async () => {
    // A binding minted for the author's own paywalled body, replayed against the
    // export of every vault key they hold.
    const res = await send(EXPORT_PATH, {
      headers: writerHeaders(WRITER_A),
      bindAs: { path: PAYWALL_PATH },
    });
    expect(res.statusCode).toBe(401);
    expect(wrapSpy).not.toHaveBeenCalled();
  });

  it("refuses a stale binding", async () => {
    const res = await send(EXPORT_PATH, {
      headers: writerHeaders(WRITER_A),
      bindAt: Date.now() - 30 * 60_000,
    });
    expect(res.statusCode).toBe(401);
    expect(wrapSpy).not.toHaveBeenCalled();
  });

  it("accepts a bound POST whose bytes do NOT survive a re-serialisation", async () => {
    // The case that pins the raw-body parser, and it has to be NON-CANONICAL
    // bytes to do it. `1.0` parses to the number 1 and stringifies back as `1`,
    // and the leading space after the colon is dropped — so a receiver that
    // hashed `JSON.stringify(req.body)` instead of the bytes it was handed would
    // compute a different tag and 401 a request that is in every way valid.
    //
    // A canonical body cannot catch this: both sides then agree by luck, which
    // is exactly what the first draft of this file asserted and what the
    // mutation showed it was not testing. The gateway happens to send canonical
    // bytes today; the guard must not depend on that, because "publishing is
    // intermittently broken" is the symptom when it starts not to.
    //
    // Not about the vault write succeeding (it will not — the ownership query is
    // mocked to a shape it does not expect). It is about getting PAST the guard.
    const nonCanonical =
      '{"articleId": "3f0a2b1c-0000-4000-8000-000000000001",' +
      '"paywallBody": "the paid half", "pricePence": 250,' +
      '"gatePositionPct": 40.0, "nostrDTag": "d"}';
    expect(JSON.stringify(JSON.parse(nonCanonical))).not.toBe(nonCanonical);

    const res = await send("/api/v1/articles/" + "e".repeat(64) + "/vault", {
      method: "POST",
      headers: { "x-writer-id": WRITER_A },
      rawBodyOverride: nonCanonical,
    });
    expect(res.statusCode).not.toBe(401);
  });

  it("leaves the parity probe on the bare secret", async () => {
    // `GET /auth-check` is the gateway's boot-time probe against all three
    // peers, and a definitive 401 there EXITS the gateway. Requiring a binding
    // would make one probe three and crash-loop the service that also serves all
    // free reading and auth.
    const res = await send(AUTH_CHECK, { omitBinding: true });
    expect(res.statusCode).toBe(200);
  });

  it("still refuses the parity probe without the secret", async () => {
    const res = await app.inject({ method: "GET", url: AUTH_CHECK });
    expect(res.statusCode).toBe(401);
  });
});
