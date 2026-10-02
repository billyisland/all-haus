import { describe, it, expect, vi, beforeEach } from "vitest";

// =============================================================================
// createConversation IS ONE TRANSACTION, UNDER A LOCK, AND ASKS BLOCKS BOTH WAYS
//
// Three defects in one function, and the first two are the same mechanism seen
// from either side of a race.
//
// UN-TRANSACTED, the `conversations` INSERT and the `conversation_members`
// INSERT were two independent statements: a failure between them leaves a
// conversation row with NO members. Every list of a member's conversations
// joins through membership, so such a row is invisible, unreachable and
// permanent — it cannot even be found to clean up by the surface that made it.
//
// UNLOCKED, the reuse lookup ("is there already a conversation with exactly
// these members?") and the INSERT that follows it are a read-then-write that
// two concurrent presses interleave. Both miss, both insert, and the pair now
// owns two conversations for one member set — which is the precise duplicate
// this function's identity-is-the-participant-set design exists to prevent, and
// it is reachable by a double-click on "Message".
//
// BLOCKS were asked one way in the messaging service generally, and the missing
// direction is the harmful one; `blocks-symmetry.test.ts` proves the predicate
// against Postgres, and what this file adds is that this caller reaches it.
//
// WHY THE ASSERTION IS CLIENT IDENTITY. A payload assertion is identical
// whether the two INSERTs ride one transaction or run on the pool afterwards —
// the repo's own relay-outbox rule, and the reason `article-publisher.test.ts`
// captures what the mocked `withTransaction` handed its callback and asserts
// identity. So the mock hands the callback a client it can recognise, and the
// test asks which statements were issued through THAT object.
// =============================================================================

const ALICE = "00000000-0000-4000-8000-0000000000a1";
const BOB = "00000000-0000-4000-8000-0000000000b2";

// Statements issued on the POOL, and statements issued on the transaction's own
// client. Kept apart, because which list a statement lands in IS the finding.
let poolCalls: Array<{ sql: string; params: unknown[] }> = [];
let txCalls: Array<{ sql: string; params: unknown[] }> = [];
let blocked = false;

function answer(sql: string) {
  if (sql.includes("FROM blocks")) {
    return { rows: blocked ? [{ "?column?": 1 }] : [], rowCount: blocked ? 1 : 0 };
  }
  // No existing conversation with this member set — force the INSERT path.
  if (sql.includes("FROM conversation_members") && sql.includes("array_agg")) {
    return { rows: [], rowCount: 0 };
  }
  if (sql.includes("INSERT INTO conversations")) {
    return { rows: [{ id: "00000000-0000-4000-8000-0000000000c3" }], rowCount: 1 };
  }
  return { rows: [], rowCount: 0 };
}

const txClient = {
  query: (sql: string, params: unknown[] = []) => {
    txCalls.push({ sql, params });
    return Promise.resolve(answer(sql));
  },
};

vi.mock("@platform-pub/shared/db/client.js", () => ({
  pool: {
    query: (sql: string, params: unknown[] = []) => {
      poolCalls.push({ sql, params });
      return Promise.resolve(answer(sql));
    },
  },
  withTransaction: (cb: (client: typeof txClient) => Promise<unknown>) =>
    cb(txClient),
}));

vi.mock("@platform-pub/shared/lib/logger.js", () => ({
  default: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));
vi.mock("../src/lib/key-custody-client.js", () => ({
  signEvent: vi.fn(),
  nip44EncryptBatch: vi.fn(),
}));
vi.mock("@platform-pub/shared/lib/relay-outbox.js", () => ({
  enqueueRelayPublish: vi.fn(),
}));

const { createConversation } = await import("../src/services/messages.js");

beforeEach(() => {
  poolCalls = [];
  txCalls = [];
  blocked = false;
});

describe("createConversation", () => {
  it("writes the conversation and its members through ONE client", async () => {
    const res = await createConversation(ALICE, [BOB]);
    expect(res.ok).toBe(true);

    const inTx = (fragment: string) =>
      txCalls.some((c) => c.sql.includes(fragment));
    const onPool = (fragment: string) =>
      poolCalls.some((c) => c.sql.includes(fragment));

    expect(inTx("INSERT INTO conversations")).toBe(true);
    expect(inTx("INSERT INTO conversation_members")).toBe(true);
    // The half a payload assertion cannot see: neither write escaped to the
    // pool, so there is no window between them in which one can land alone.
    expect(onPool("INSERT INTO conversations")).toBe(false);
    expect(onPool("INSERT INTO conversation_members")).toBe(false);
  });

  it("takes the advisory lock BEFORE the reuse lookup it protects", async () => {
    await createConversation(ALICE, [BOB]);
    const lock = txCalls.findIndex((c) => c.sql.includes("pg_advisory_xact_lock"));
    const lookup = txCalls.findIndex((c) => c.sql.includes("array_agg"));
    const insert = txCalls.findIndex((c) => c.sql.includes("INSERT INTO conversations"));
    expect(lock).toBeGreaterThanOrEqual(0);
    // Order is the whole point: a lock taken after the read serialises nothing,
    // and both racers have already decided to insert by the time they meet.
    expect(lock).toBeLessThan(lookup);
    expect(lookup).toBeLessThan(insert);
  });

  it("keys the lock on the member set, not on the caller", async () => {
    // Two members in either order are one conversation, so they must contend
    // for one lock — keyed on the creator alone, two people messaging each
    // other simultaneously take different locks and race anyway.
    await createConversation(ALICE, [BOB]);
    const a = txCalls.find((c) => c.sql.includes("pg_advisory_xact_lock"))!.params[0];
    txCalls = [];
    await createConversation(BOB, [ALICE]);
    const b = txCalls.find((c) => c.sql.includes("pg_advisory_xact_lock"))!.params[0];
    expect(a).toBe(b);
  });

  it("refuses on a block and writes NOTHING", async () => {
    blocked = true;
    const res = await createConversation(ALICE, [BOB]);
    expect(res.ok).toBe(false);
    expect(res.ok === false && res.status).toBe(403);
    // A refusal that still created the conversation is the same defect wearing
    // a 403, and a status-code assertion passes against it.
    const wrote = [...poolCalls, ...txCalls].some((c) =>
      c.sql.includes("INSERT INTO conversation"),
    );
    expect(wrote).toBe(false);
  });

  it("names neither party in the refusal", async () => {
    // One neutral message for both directions: anything naming who blocked whom
    // discloses the block, and its direction, to the party that did not set it.
    blocked = true;
    const res = await createConversation(ALICE, [BOB]);
    const error = res.ok === false ? res.error : "";
    expect(error).not.toMatch(/blocked by/i);
    expect(error).not.toMatch(/you (have )?blocked/i);
  });
});
