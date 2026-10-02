import { describe, it, expect, vi, beforeEach } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";

// =============================================================================
// A DM REPLY NAMES A MESSAGE IN ITS OWN CONVERSATION, AND A REPEATED MEMBER IS
// ONE MEMBER (CA-D7).
//
// `sendMessage` checked the sender's membership and inserted `replyToId`
// unchecked; the read LEFT JOINed the reply target with no conversation term
// and returned its ciphertext, its sender's username and a counterparty pubkey
// — so a known message id from somebody else's conversation leaked that
// metadata to every member here, and an unknown one hit the FK and 500'd.
// `createConversation` stripped only the creator from `memberIds`, so a repeat
// reached the membership PK and 500'd.
//
// The mock answers the reply-target lookup FROM ITS PARAMS (the message exists
// in exactly one conversation), and the cases assert whether the key-custody
// encrypt and the INSERT RAN — a refusal that encrypted has already spent the
// round-trip, and the status code cannot tell a guard from a lucky 400.
//
// MUTATION: drop the `replyToId` guard → the foreign-conversation case goes red
// (encrypt called, INSERT ran); drop the `new Set` → the duplicate case does.
// =============================================================================

const SENDER = "00000000-0000-4000-8000-00000000000a";
const FRIEND = "00000000-0000-4000-8000-00000000000b";
const HERE = "00000000-0000-4000-8000-0000000000c1";
const ELSEWHERE = "00000000-0000-4000-8000-0000000000c2";
const MSG_ELSEWHERE = "00000000-0000-4000-8000-0000000000d2";
const MSG_HERE = "00000000-0000-4000-8000-0000000000d1";

/** Which conversation each known message lives in. */
const MESSAGES: Record<string, string> = { [MSG_HERE]: HERE, [MSG_ELSEWHERE]: ELSEWHERE };

let inserts: Array<{ sql: string; params: unknown[] }> = [];
const encrypt = vi.fn(async (_s: string, pubkeys: string[]) => ({
  ciphertexts: pubkeys.map(() => "ct"),
}));

function answer(sql: string, params: unknown[] = []) {
  if (sql.includes("FROM direct_messages WHERE id = $1 AND conversation_id = $2")) {
    const hit = MESSAGES[params[0] as string] === params[1];
    return { rows: hit ? [{ "?column?": 1 }] : [], rowCount: hit ? 1 : 0 };
  }
  if (sql.includes("FROM conversation_members WHERE conversation_id = $1 AND user_id = $2")) {
    return { rows: [{}], rowCount: 1 };
  }
  if (sql.includes("SELECT user_id FROM conversation_members")) {
    return { rows: [{ user_id: FRIEND }], rowCount: 1 };
  }
  if (sql.includes("SELECT id, nostr_pubkey FROM accounts")) {
    return { rows: [{ id: FRIEND, nostr_pubkey: "f".repeat(64) }], rowCount: 1 };
  }
  if (sql.includes("INSERT INTO direct_messages")) {
    inserts.push({ sql, params });
    return { rows: [{ id: "new" }], rowCount: 1 };
  }
  if (sql.includes("INSERT INTO conversations")) {
    return { rows: [{ id: HERE }], rowCount: 1 };
  }
  if (sql.includes("INSERT INTO conversation_members")) {
    inserts.push({ sql, params });
    return { rows: [], rowCount: params.length - 1 };
  }
  if (sql.includes("HAVING array_agg")) return { rows: [], rowCount: 0 };
  if (sql.includes("pg_advisory_xact_lock")) return { rows: [], rowCount: 1 };
  if (sql.includes("UPDATE conversations")) return { rows: [], rowCount: 1 };
  throw new Error(`unscripted SQL: ${sql}`);
}

vi.mock("@platform-pub/shared/db/client.js", () => ({
  pool: { query: async (sql: string, params?: unknown[]) => answer(sql, params) },
  withTransaction: async (fn: (c: unknown) => unknown) =>
    fn({ query: async (sql: string, params?: unknown[]) => answer(sql, params) }),
}));

vi.mock("../src/lib/key-custody-client.js", () => ({
  nip44EncryptBatch: (...a: [string, string[]]) => encrypt(...a),
  nip44DecryptBatch: vi.fn(),
}));

vi.mock("../src/lib/blocks.js", () => ({
  blockExistsWithAny: async () => false,
  blockPairSql: () => "FALSE",
}));

vi.mock("@platform-pub/shared/lib/logger.js", () => ({
  default: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

const { sendMessage, createConversation } = await import("../src/services/messages.js");

beforeEach(() => {
  inserts = [];
  encrypt.mockClear();
});

describe("sendMessage — the reply target", () => {
  it("refuses a message from ANOTHER conversation before encrypting or writing", async () => {
    const res = await sendMessage(HERE, SENDER, "hi", MSG_ELSEWHERE);
    expect(res.ok).toBe(false);
    expect(encrypt).not.toHaveBeenCalled();
    expect(inserts).toHaveLength(0);
  });

  it("refuses an unknown id the same way (no FK 500, no oracle)", async () => {
    const res = await sendMessage(HERE, SENDER, "hi", "00000000-0000-4000-8000-0000000000ff");
    expect(res).toMatchObject({ ok: false, status: 400 });
    const foreign = await sendMessage(HERE, SENDER, "hi", MSG_ELSEWHERE);
    expect(foreign).toEqual(res);
    expect(inserts).toHaveLength(0);
  });

  it("CONTROL — a reply inside the conversation is sent and carries its target", async () => {
    const res = await sendMessage(HERE, SENDER, "hi", MSG_HERE);
    expect(res.ok).toBe(true);
    expect(encrypt).toHaveBeenCalledTimes(1);
    expect(inserts[0].params).toContain(MSG_HERE);
  });

  it("CONTROL — no reply target asks nothing about one", async () => {
    const res = await sendMessage(HERE, SENDER, "hi", null);
    expect(res.ok).toBe(true);
  });
});

describe("createConversation — a repeated member is one member", () => {
  it("inserts each member once", async () => {
    const res = await createConversation(SENDER, [FRIEND, FRIEND, SENDER]);
    expect(res.ok).toBe(true);
    const members = inserts.find((i) => i.sql.includes("conversation_members"))!;
    expect(members.params.slice(1).sort()).toEqual([FRIEND, SENDER].sort());
  });
});

describe("the read joins the reply target inside its own conversation", () => {
  it("scopes the LEFT JOIN, so a row written before the guard cannot leak", () => {
    const src = readFileSync(join(__dirname, "../src/services/messages.ts"), "utf8");
    const join_ = src.match(/LEFT JOIN direct_messages rdm ON rdm\.id = dm\.reply_to_id\s+AND rdm\.conversation_id = dm\.conversation_id/);
    expect(join_).not.toBeNull();
  });
});
