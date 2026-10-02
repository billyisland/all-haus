import { describe, it, expect, vi, beforeEach } from "vitest";
import Fastify from "fastify";

// =============================================================================
// THE INBOUND WEBHOOK ANSWERS 200 TO EVERYTHING, SO THE STATUS CODE IS NOT A
// RESULT (MIRROR-AUDIT §3 *Security*, S15).
//
// It has to: Postmark retries on anything else, and a retry loop over an email
// we have deliberately discarded is worse than the discard. Which means an
// accepted credential and a refused one are INDISTINGUISHABLE from the outside —
// so every case here asserts whether the job was ENQUEUED, and a suite written
// against the status code would pass against a route that accepted anything.
//
// WHAT CHANGED. The secret was a path segment, and Fastify logs `req.url` on
// every request, so `INBOUND_MAIL_SECRET` was written in plaintext to the
// gateway's log — and nginx's, and Postmark's dashboard — several times a day for
// the life of the route. The durable form reads it out of HTTP basic auth, where
// nothing logs it. Both routes are live and share one handler, deliberately: the
// route's silence is exactly what makes a one-directional swap unsafe, since a
// gateway that dropped the legacy path before Postmark was repointed would
// discard every newsletter and look like a quiet week.
//
// MUTATION CHECK. Return `decoded` rather than the password half from
// `basicAuthSecret` and the accept case fails. Drop `logLevel: "warn"` and
// nothing here moves — that half is a log assertion and lives in the runbook,
// not in a unit test.
// =============================================================================

const SECRET = "inbound-secret-value";
process.env.INBOUND_MAIL_SECRET = SECRET;

const SOURCE_ID = "00000000-0000-4000-8000-0000000000e1";

let enqueued: unknown[][] = [];

vi.mock("@platform-pub/shared/db/client.js", () => ({
  pool: {
    query: (sql: string, params: unknown[] = []) => {
      if (sql.includes("FROM external_sources")) {
        return Promise.resolve({ rows: [{ id: SOURCE_ID }], rowCount: 1 });
      }
      if (sql.includes("graphile_worker.add_job")) {
        enqueued.push(params);
        return Promise.resolve({ rows: [], rowCount: 1 });
      }
      return Promise.resolve({ rows: [], rowCount: 0 });
    },
  },
}));

vi.mock("@platform-pub/shared/lib/logger.js", () => ({
  default: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

const { inboundMailRoutes, _resetRefusalLog } = await import(
  "../src/routes/inbound-mail.js"
);
const logger = (await import("@platform-pub/shared/lib/logger.js")).default;

const PAYLOAD = {
  MessageID: "msg-1",
  ToFull: [{ Email: "wren@in.all.haus", Name: "Wren" }],
  Subject: "hello",
  TextBody: "body",
};

async function post(url: string, headers: Record<string, string> = {}) {
  const app = Fastify({ logger: false });
  await app.register(inboundMailRoutes);
  const res = await app.inject({ method: "POST", url, headers, payload: PAYLOAD });
  await app.close();
  return res;
}

const basic = (user: string, pass: string) => ({
  authorization: `Basic ${Buffer.from(`${user}:${pass}`).toString("base64")}`,
});

beforeEach(() => {
  enqueued = [];
  process.env.INBOUND_MAIL_SECRET = SECRET;
  _resetRefusalLog();
  vi.mocked(logger.warn).mockClear();
});

describe("POST /inbound-mail — the credential in basic auth", () => {
  it("accepts the secret as the PASSWORD half and enqueues", async () => {
    const res = await post("/inbound-mail", basic("postmark", SECRET));
    expect(enqueued).toHaveLength(1);
    expect(res.statusCode).toBe(200);
  });

  it("ignores the username — Postmark wants both fields, only one is the secret", async () => {
    await post("/inbound-mail", basic("anything-at-all", SECRET));
    expect(enqueued).toHaveLength(1);
  });

  it("refuses a wrong password, silently and with a 200", async () => {
    const res = await post("/inbound-mail", basic("postmark", "wrong"));
    expect(enqueued).toHaveLength(0);
    expect(res.statusCode).toBe(200); // the silence is the design; the enqueue is the result
  });

  it("refuses the secret sent as the USERNAME", async () => {
    // Worth pinning: an operator who fills the fields the other way round gets a
    // route that silently discards every newsletter. It must be a refusal, not a
    // lucky match on either half.
    await post("/inbound-mail", basic(SECRET, "x"));
    expect(enqueued).toHaveLength(0);
  });

  it("refuses a missing, malformed or non-Basic Authorization header", async () => {
    await post("/inbound-mail");
    await post("/inbound-mail", { authorization: "Basic" });
    await post("/inbound-mail", { authorization: `Bearer ${SECRET}` });
    await post("/inbound-mail", { authorization: "Basic !!!not-base64!!!" });
    expect(enqueued).toHaveLength(0);
  });
});

describe("POST /inbound-mail/:secret — the legacy path, still live", () => {
  it("still accepts, so the swap can be made in either order", async () => {
    // If this ever fails, a deploy has just started discarding every inbound
    // newsletter and saying 200 about it.
    await post(`/inbound-mail/${SECRET}`);
    expect(enqueued).toHaveLength(1);
  });

  it("still refuses a wrong path secret", async () => {
    await post("/inbound-mail/wrong");
    expect(enqueued).toHaveLength(0);
  });
});

// CA-D3. The 200 stays — but a refusal is no longer silent in OUR log, and the
// secret is read when a delivery arrives rather than captured at import with a
// `?? ""`. Mutation: drop the `noteRefusal` call and the first two cases fail;
// capture the secret at module load again and the third does.
describe("a refusal leaves a line, and the secret is read per delivery", () => {
  it("warns on a mismatch, once per window, carrying the count", async () => {
    await post("/inbound-mail", basic("postmark", "wrong"));
    await post("/inbound-mail", basic("postmark", "wrong"));
    await post("/inbound-mail", basic("postmark", "wrong"));
    expect(enqueued).toHaveLength(0);
    const warns = vi.mocked(logger.warn).mock.calls;
    expect(warns).toHaveLength(1);
    expect(warns[0][0]).toMatchObject({ reason: "credential_mismatch", refused: 1 });
  });

  it("an UNSET secret refuses every delivery and names the variable", async () => {
    delete process.env.INBOUND_MAIL_SECRET;
    // Even an empty presented credential: the empty string must never match.
    await post("/inbound-mail", basic("postmark", ""));
    await post("/inbound-mail/anything");
    expect(enqueued).toHaveLength(0);
    const warns = vi.mocked(logger.warn).mock.calls;
    expect(warns).toHaveLength(1);
    expect(warns[0][0]).toMatchObject({ reason: "secret_unset" });
    expect(String(warns[0][1])).toContain("INBOUND_MAIL_SECRET");
  });

  it("a secret set after import is the one that is checked", async () => {
    process.env.INBOUND_MAIL_SECRET = "rotated-secret";
    await post("/inbound-mail", basic("postmark", SECRET));
    expect(enqueued).toHaveLength(0);
    await post("/inbound-mail", basic("postmark", "rotated-secret"));
    expect(enqueued).toHaveLength(1);
  });

  it("an accepted delivery logs no refusal", async () => {
    await post("/inbound-mail", basic("postmark", SECRET));
    expect(vi.mocked(logger.warn)).not.toHaveBeenCalled();
  });
});
