import { describe, it, expect, beforeAll, afterAll, vi } from "vitest";
import Fastify, { type FastifyInstance } from "fastify";
import {
  BINDING_HEADER,
  keyServiceSubject,
  signInternalRequest,
} from "@platform-pub/shared/lib/internal-binding.js";

// =============================================================================
// ONE UNDECRYPTABLE KEY IS A FACT ABOUT ONE ARTICLE (CA-F14(a)).
//
// `GET /writers/export-keys` mapped every vault row through decrypt + wrap
// inside one try, so a single row that would not open 500'd the whole export —
// and the gateway answers that with a 502 for the member's ENTIRE account
// bundle. The partial-outcome rule: the loop does not abort, and the shortfall
// is counted beside the total. So the assertion is on what happened to the
// OTHER rows, not on the status code — a 200 with an empty list would pass a
// status check against the aborting loop's replacement just as well.
// =============================================================================

const SECRET = "test-internal-secret-0123456789";
process.env.INTERNAL_SECRET = SECRET;
process.env.DATABASE_URL ??= "postgres://unused/unused";
process.env.KMS_MASTER_KEY_HEX ??= "a".repeat(64);

const BAD = "3f0a2b1c-0000-4000-8000-000000000002";

vi.mock("../src/lib/kms.js", () => ({
  decryptContentKey: (enc: string) => {
    if (enc === "enc-bad") throw new Error("Unsupported state or unable to authenticate data");
    return new Uint8Array(32);
  },
  encryptContentKey: vi.fn(() => "enc"),
}));
vi.mock("../src/lib/nip44.js", () => ({
  wrapKeyForReader: () => "wrapped-key",
}));

const row = (n: number, enc: string) => ({
  article_id: `3f0a2b1c-0000-4000-8000-00000000000${n}`,
  nostr_event_id: String(n).repeat(64),
  nostr_d_tag: `d-${n}`,
  title: `Piece ${n}`,
  content_key_enc: enc,
  algorithm: "aes-256-gcm",
});

vi.mock("@platform-pub/shared/db/client.js", () => ({
  pool: {
    query: vi.fn(async () => ({
      rows: [row(1, "enc-1"), row(2, "enc-bad"), row(3, "enc-3")],
    })),
    end: vi.fn(async () => {}),
  },
  withTransaction: vi.fn(),
}));

const WRITER = "11111111-1111-4111-8111-111111111111";
const PUBKEY = "f".repeat(64);
const EXPORT_PATH = "/api/v1/writers/export-keys";

let app: FastifyInstance;

beforeAll(async () => {
  const { buildApp } = await import("../src/app.js");
  app = await buildApp(Fastify({ logger: false }));
  await app.ready();
});

afterAll(async () => {
  await app.close();
});

function exportKeys() {
  const headers: Record<string, string> = {
    "x-internal-secret": SECRET,
    "x-writer-id": WRITER,
    "x-writer-pubkey": PUBKEY,
  };
  headers[BINDING_HEADER] = signInternalRequest(SECRET, {
    method: "GET",
    path: EXPORT_PATH,
    rawBody: "",
    subject: keyServiceSubject({ writerId: WRITER, writerPubkey: PUBKEY }),
  });
  return app.inject({ method: "GET", url: EXPORT_PATH, headers });
}

describe("GET /writers/export-keys — a key that will not open", () => {
  it("still exports every OTHER key, and names the one it skipped", async () => {
    const res = await exportKeys();
    expect(res.statusCode).toBe(200);
    const body = res.json() as {
      keys: Array<{ articleId: string }>;
      skipped: string[];
    };

    expect(body.keys.map((k) => k.articleId)).toEqual([
      "3f0a2b1c-0000-4000-8000-000000000001",
      "3f0a2b1c-0000-4000-8000-000000000003",
    ]);
    // Counted beside the total, never a silent omission.
    expect(body.skipped).toEqual([BAD]);
  });
});
