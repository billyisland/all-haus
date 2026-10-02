import { describe, it, expect, vi, beforeEach } from "vitest";
import Fastify from "fastify";

// =============================================================================
// ONE BAD TOKEN MUST NOT COST A READER EVERY OTHER ONE
// (MIRROR-AUDIT §4, correctness papercuts).
//
// WHAT WAS WRONG. `rows.map(r => JSON.parse(r.receipt_token))` throws on the
// first unparseable row, which the route's catch turns into a 500. A receipt is
// the reader's own portable proof of what they paid for — the whole point of
// the export is that they can take it elsewhere — so a single corrupt token
// anywhere in their history made the entire export permanently unavailable,
// with an error naming neither the row nor the fact that the rest were fine.
// It fails closed on the reader's data, which is the wrong direction.
//
// WHAT IS UNDER TEST:
//
//   (1) The good receipts come back. The bad row is skipped, not fatal.
//   (2) THE SKIP IS COUNTED. A short export that reads as a complete one is the
//       reassuring absence this repo keeps meeting elsewhere (an empty
//       denominator, a truncated sample, a NULL that means two things) — so
//       `skipped` ships beside `count` and a reader with four receipts is
//       distinguishable from a reader with five, one of which we cannot read.
//   (3) THE CLEAN CONTROL still reports `skipped: 0`, or "counts the bad ones"
//       passes against a route that counts something else.
// =============================================================================

const READER = "00000000-0000-4000-8000-0000000000a1";

let receiptRows: Array<{ receipt_token: string; read_at: Date }> = [];

vi.mock("@platform-pub/shared/db/client.js", () => ({
  pool: {
    query: (sql: string) => {
      if (sql.includes("FROM read_events")) {
        return Promise.resolve({
          rows: receiptRows,
          rowCount: receiptRows.length,
        });
      }
      return Promise.resolve({ rows: [], rowCount: 0 });
    },
  },
}));

vi.mock("@platform-pub/shared/lib/logger.js", () => ({
  default: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

vi.mock("../src/middleware/auth.js", () => ({
  requireAuth: (
    req: { session?: { sub: string } },
    _reply: unknown,
    done?: () => void,
  ) => {
    req.session = { sub: READER };
    done?.();
  },
}));

// Any valid 32-byte hex key: the route only needs to derive a pubkey from it.
process.env.PLATFORM_SERVICE_PRIVKEY = "11".repeat(32);

const { receiptRoutes } = await import("../src/routes/receipts.js");

function receipt(eventId: string) {
  return JSON.stringify({
    id: eventId,
    kind: 9901,
    pubkey: "f".repeat(64),
    tags: [["e", eventId]],
    content: "",
    sig: "b".repeat(128),
    created_at: 1,
  });
}

async function exportReceipts() {
  const app = Fastify();
  await app.register(receiptRoutes);
  const res = await app.inject({ method: "GET", url: "/receipts/export" });
  await app.close();
  return res;
}

beforeEach(() => {
  receiptRows = [];
});

describe("GET /receipts/export", () => {
  it("returns every readable receipt and skips the one that is not", async () => {
    receiptRows = [
      { receipt_token: receipt("a".repeat(64)), read_at: new Date() },
      { receipt_token: "{not json", read_at: new Date() },
      { receipt_token: receipt("c".repeat(64)), read_at: new Date() },
    ];

    const res = await exportReceipts();

    // Not a 500 — which is what the reader used to get, for all three.
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.count).toBe(2);
    expect(body.receipts.map((r: { id: string }) => r.id)).toEqual([
      "a".repeat(64),
      "c".repeat(64),
    ]);
    // And the export SAYS it is short. Silently returning two is how a reader
    // comes to believe they only ever paid for two things.
    expect(body.skipped).toBe(1);
  });

  it("CONTROL — a clean history reports nothing skipped", async () => {
    receiptRows = [
      { receipt_token: receipt("a".repeat(64)), read_at: new Date() },
      { receipt_token: receipt("b".repeat(64)), read_at: new Date() },
    ];

    const body = (await exportReceipts()).json();
    expect(body.count).toBe(2);
    expect(body.skipped).toBe(0);
  });

  it("a reader whose every token is unreadable gets an empty export, not a 500", async () => {
    receiptRows = [
      { receipt_token: "", read_at: new Date() },
      { receipt_token: "undefined", read_at: new Date() },
    ];

    const res = await exportReceipts();
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.receipts).toEqual([]);
    // Zero receipts and zero rows are different facts, and this is the case
    // where saying so matters most.
    expect(body.count).toBe(0);
    expect(body.skipped).toBe(2);
  });
});
