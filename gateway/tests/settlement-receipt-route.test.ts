import { describe, it, expect, vi, beforeEach } from "vitest";
import Fastify from "fastify";

// =============================================================================
// GET /my/receipts/:settlementId — the receipt Reader Terms 5.2 promises.
//
// The BUILDING of the receipt is `shared/tests/settlement-receipt.test.ts`'s;
// what this file owns is the route's own three answers, and all three are about
// what a stranger can learn from them.
//
//   (1) A settlement that is not yours is INDISTINGUISHABLE from one that does
//       not exist. 404, never 403 — a 403 confirms the id was real.
//   (2) A path parameter that is not a uuid names no resource. 404, not 400:
//       answering 400 tells a guesser that their SHAPE was right.
//   (3) An outage is a 500 and never an empty receipt, which would say the
//       charge covered nothing.
//
// The loader is doubled so those answers can be driven without a database; the
// route must pass its own two arguments to it in the right order, which is what
// case (1) actually pins — transpose them and the reader gets somebody else's
// receipt, or more likely nobody's.
// =============================================================================

const READER = "00000000-0000-4000-8000-0000000000a1";
const SETTLEMENT = "00000000-0000-4000-8000-0000000000b2";

const loadSettlementReceipt = vi.hoisted(() => vi.fn());

vi.mock("@platform-pub/shared/lib/settlement-receipt.js", () => ({
  loadSettlementReceipt,
}));
vi.mock("@platform-pub/shared/db/client.js", () => ({
  pool: { query: () => Promise.resolve({ rows: [], rowCount: 0 }) },
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

process.env.PLATFORM_SERVICE_PRIVKEY = "11".repeat(32);

const { receiptRoutes } = await import("../src/routes/receipts.js");

async function get(id: string) {
  const app = Fastify();
  await app.register(receiptRoutes);
  const res = await app.inject({ method: "GET", url: `/my/receipts/${id}` });
  await app.close();
  return res;
}

const RECEIPT = {
  settlementId: SETTLEMENT,
  settledAt: "2026-09-17T10:00:00.000Z",
  amountPence: 800,
  triggerType: "threshold",
  reversedAt: null,
  items: [
    {
      kind: "read",
      description: "The Piece",
      writerName: "Vita Sackville-West",
      writerUsername: "vita",
      pricePence: 300,
      link: "/article/the-piece",
      at: "2026-09-16T09:00:00.000Z",
    },
  ],
  itemisedPence: 300,
  unitemisedPence: 500,
};

beforeEach(() => {
  loadSettlementReceipt.mockReset();
});

describe("GET /my/receipts/:settlementId", () => {
  it("hands back the receipt, asking for it as THIS reader's", async () => {
    loadSettlementReceipt.mockResolvedValue(RECEIPT);

    const res = await get(SETTLEMENT);

    expect(res.statusCode).toBe(200);
    expect(res.json().items[0].writerName).toBe("Vita Sackville-West");
    // The order of these two arguments is the whole of the ownership check.
    expect(loadSettlementReceipt).toHaveBeenCalledWith(SETTLEMENT, READER);
  });

  it("answers 404 — not 403 — for a settlement that is not this reader's", async () => {
    // The loader applies the ownership term in its WHERE clause, so "not yours"
    // arrives here as `null`, exactly as "does not exist" does. That is the
    // point: a 403 would confirm the id names a real charge.
    loadSettlementReceipt.mockResolvedValue(null);

    const res = await get(SETTLEMENT);

    expect(res.statusCode).toBe(404);
    expect(res.json().error).toBe("not_found");
  });

  it("answers 404 for a path that is not a uuid, and never asks the database", async () => {
    const res = await get("not-a-uuid");

    expect(res.statusCode).toBe(404);
    // A 400 would tell a guesser their shape was right; a query would let them
    // time it.
    expect(loadSettlementReceipt).not.toHaveBeenCalled();
  });

  it("answers 500 on a fault of ours, never an empty receipt", async () => {
    // An empty `items` with a 200 would say this charge covered nothing, which
    // is a claim, and the wrong one.
    loadSettlementReceipt.mockRejectedValue(new Error("db down"));

    const res = await get(SETTLEMENT);

    expect(res.statusCode).toBe(500);
  });
});
