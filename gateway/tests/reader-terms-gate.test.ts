import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

// =============================================================================
// The Reader Terms refusal in `performGatePass` — and, above all, WHERE it sits.
//
// A reader who registered a card before the Reader Terms existed has never been
// shown them, so the gate pass asks once, at the first read that would cost
// them money (operator decision A3, 2026-09-16).
//
// WHAT THIS FILE ASSERTS IS WHETHER THE PAYMENT SERVICE WAS CALLED AND WHETHER
// A TAB WAS OPENED, never the returned `kind` alone. The failure this refusal
// exists to prevent is a charge made under a text nobody agreed to, and a
// refusal placed after the charge returns exactly the same `kind` while the
// money has already moved. So `fetch` is a spy and the `reading_tabs` statement
// is watched.
//
// THE PLACEMENT IS THE POINT, AND IT IS WHAT THE QUEUE ITEM GOT WRONG. The item
// specified the refusal "before Step 2", beside the undeliverable-article check.
// Step 2 is the FREE-ACCESS fast path: the writer reading their own piece, a
// reader re-opening something they have already paid for, and a subscriber
// reading on a subscription bought under the text they did accept. Refusing
// there withholds content that is already theirs in order to settle a question
// about a future purchase — so the refusal sits after every free path and
// before the first that charges, and the three cases below are what say so.
// Move the check above `checkArticleAccess` and all three go red.
// =============================================================================

const READER = "00000000-0000-4000-8000-0000000000a1";
const WRITER = "00000000-0000-4000-8000-0000000000b1";
const ARTICLE = "00000000-0000-4000-8000-0000000000c1";
const EVENT_ID = "e".repeat(64);

/** The reader row the accounts read answers with — set per case. */
let readerRow: { has_card: boolean; reader_terms_version: string | null } = {
  has_card: true,
  reader_terms_version: null,
};
/** Which free-access path (if any) the reader has. */
let unlocked = false;
let subscribed = false;
/** L5.6: has the writer's paid access been withdrawn (Writer 9.3)? */
let withdrawn = false;
/** READER-WRITER-SPLIT-ADR §5: was the piece's author admitted as a writer? */
let writerAdmitted = true;

let calls: Array<{ sql: string; params: unknown[] }> = [];
const ran = (fragment: string) => calls.some((c) => c.sql.includes(fragment));

function scriptedQuery(sql: string, params: unknown[] = []) {
  // A COPY of the params, never the live array — a later call must not appear
  // to have mutated an earlier one.
  calls.push({ sql, params: [...params] });

  // The lookup joins `accounts` since L5.6 (the writer's withdrawal stamp
  // rides it), so the match is on the table pair rather than on the old
  // single-table phrasing — keyed on the FROM clause alone this branch stopped
  // answering and every case here got a `not_found`.
  if (sql.includes("FROM articles a") && sql.includes("JOIN accounts w")) {
    return Promise.resolve({
      rows: [
        {
          id: ARTICLE,
          writer_id: WRITER,
          price_pence: 300,
          access_mode: "paywalled",
          publication_id: null,
          // Not withdrawn: this file is about the terms refusal, and a piece
          // that is not on sale would be refused a step earlier.
          paid_access_withdrawn_at: withdrawn ? new Date() : null,
          // Carried by the SQL (`writerAdmittedSql`), so answered only when the
          // lookup actually selects it: a query that dropped the column must
          // read as `undefined`, which the route refuses.
          ...(sql.includes("writer_admitted_at IS NOT NULL AS writer_admitted")
            ? { writer_admitted: writerAdmitted }
            : {}),
          // Live: a withdrawn piece opens only to a reader who already bought
          // it (§0z item 18), which is a different file's question.
          deleted_at: null,
        },
      ],
      rowCount: 1,
    });
  }
  if (sql.includes("FROM vault_keys")) {
    return Promise.resolve({ rows: [{ ok: 1 }], rowCount: 1 });
  }
  if (sql.includes("FROM article_unlocks")) {
    return Promise.resolve(
      unlocked ? { rows: [{ id: "u1" }], rowCount: 1 } : { rows: [], rowCount: 0 },
    );
  }
  if (sql.includes("FROM subscriptions")) {
    return Promise.resolve(
      subscribed ? { rows: [{ id: "s1" }], rowCount: 1 } : { rows: [], rowCount: 0 },
    );
  }
  // The terms read. Answered from the id it is HANDED: a mock that returns its
  // row whatever the param is would pin the fixture, not the query.
  if (sql.includes("FROM accounts WHERE id = $1")) {
    return Promise.resolve(
      params[0] === READER
        ? { rows: [readerRow], rowCount: 1 }
        : { rows: [], rowCount: 0 },
    );
  }
  if (sql.includes("reading_tabs")) {
    return Promise.resolve({ rows: [{ id: "tab-1" }], rowCount: 1 });
  }
  return Promise.resolve({ rows: [], rowCount: 0 });
}

vi.mock("@platform-pub/shared/db/client.js", () => ({
  pool: { query: (sql: string, p: unknown[] = []) => scriptedQuery(sql, p) },
  withTransaction: (cb: (c: { query: typeof scriptedQuery }) => Promise<unknown>) =>
    cb({ query: scriptedQuery }),
}));

vi.mock("@platform-pub/shared/lib/env.js", () => ({
  requireEnv: (name: string) => `stub-${name}`,
  requireEnvMinLength: (name: string) => `stub-${name}`,
  internalSecret: () => "stub-secret",
}));

vi.mock("@platform-pub/shared/lib/logger.js", () => ({
  default: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

vi.mock("../src/lib/key-service-client.js", () => ({
  keyServiceHeaders: () => ({ "content-type": "application/json" }),
}));

import { performGatePass } from "../src/services/article-access/gate-pass.js";
import { READER_TERMS_VERSION } from "@platform-pub/shared/lib/terms-versions.js";

const fetchSpy = vi.fn();

beforeEach(() => {
  calls = [];
  unlocked = false;
  subscribed = false;
  withdrawn = false;
  writerAdmitted = true;
  readerRow = { has_card: true, reader_terms_version: null };
  fetchSpy.mockReset();
  // Every remaining leg of the gate pass is an HTTP call; a case that reaches
  // one has already failed the assertion it is making.
  fetchSpy.mockResolvedValue({
    ok: true,
    status: 200,
    json: async () => ({
      readEventId: "re-1",
      state: "accrued",
      encryptedKey: {},
      algorithm: "aes-256-gcm",
    }),
  });
  vi.stubGlobal("fetch", fetchSpy);
});

afterEach(() => {
  vi.unstubAllGlobals();
});

function pass() {
  return performGatePass({
    readerId: READER,
    readerPubkey: "f".repeat(64),
    nostrEventId: EVENT_ID,
  });
}

describe("performGatePass — the Reader Terms refusal", () => {
  it("refuses a card-holding reader who has accepted nothing, before any money", async () => {
    const result = await pass();

    expect(result.kind).toBe("reader_terms_required");
    // The whole finding: no tab was opened and the payment service was never
    // called. A refusal that returns the right kind after the charge passes a
    // status-only assertion.
    expect(ran("reading_tabs")).toBe(false);
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("refuses a reader stranded on a superseded MAJOR version", async () => {
    readerRow = { has_card: true, reader_terms_version: "0.4" };
    const result = await pass();
    expect(result.kind).toBe("reader_terms_required");
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("lets a reader on the current text through to the charge", async () => {
    readerRow = { has_card: true, reader_terms_version: READER_TERMS_VERSION };
    const result = await pass();
    expect(result.kind).not.toBe("reader_terms_required");
    expect(ran("reading_tabs")).toBe(true);
    expect(fetchSpy).toHaveBeenCalled();
  });

  it("lets a reader on a newer TEXT sub-version through — only major is compared", async () => {
    // `major.text`: a typo fix bumps `text` and must not re-prompt anybody.
    // Stored 1.7 against a current 1.0 is the same agreement.
    const major = READER_TERMS_VERSION.split(".")[0];
    readerRow = { has_card: true, reader_terms_version: `${major}.7` };
    const result = await pass();
    expect(result.kind).not.toBe("reader_terms_required");
    expect(fetchSpy).toHaveBeenCalled();
  });

  it("does not ask a card-less reader, who has nothing to accept yet", async () => {
    // The free allowance is a gift, not a sale, and the acceptance is collected
    // at card registration. Asking here would put a legal wall in front of a
    // read that costs the reader nothing.
    readerRow = { has_card: false, reader_terms_version: null };
    const result = await pass();
    expect(result.kind).not.toBe("reader_terms_required");
  });

  // --- the placement cases -------------------------------------------------

  it("does not refuse a reader re-opening something they have already paid for", async () => {
    unlocked = true;
    const result = await pass();
    expect(result.kind).not.toBe("reader_terms_required");
    // And it never even asked — the free path returns before the question.
    expect(ran("FROM accounts WHERE id = $1")).toBe(false);
  });

  it("does not refuse a subscriber reading on a subscription they bought", async () => {
    subscribed = true;
    const result = await pass();
    expect(result.kind).not.toBe("reader_terms_required");
    expect(ran("FROM accounts WHERE id = $1")).toBe(false);
  });

  it("does not refuse the writer reading their own piece", async () => {
    const result = await performGatePass({
      readerId: WRITER,
      readerPubkey: "f".repeat(64),
      nostrEventId: EVENT_ID,
    });
    expect(result.kind).not.toBe("reader_terms_required");
    expect(ran("FROM accounts WHERE id = $1")).toBe(false);
  });
});

// =============================================================================
// L5.6 — a piece whose Writer we cannot pay is NOT FOR SALE (Writer 9.3).
//
// The same file because it is the same question one step along: where does a
// refusal that is not about the reader's money belong? Beside the invitation
// refusal — this object cannot be bought, whoever is asking — and therefore
// AFTER the free-access path, because withdrawing a sale must not take away
// anything anybody already has.
//
// Every case asserts whether the payment service was called, never the kind
// alone: a refusal returned after the charge looks identical from the outside.
// =============================================================================
// READER-WRITER-SPLIT-ADR §5: a reader is not sold. The same step as a
// withdrawal, for the same reason — a fact about the object — so the same three
// questions: no charge, nothing taken from somebody who already has it.
describe("performGatePass — a piece by a READER", () => {
  it("is not for sale, and the payment service is called NOT AT ALL", async () => {
    writerAdmitted = false;

    const result = await pass();

    expect(result.kind).toBe("not_for_sale");
    expect(fetchSpy).not.toHaveBeenCalled();
    expect(ran("reading_tabs")).toBe(false);
  });

  it("does NOT take away a piece the reader has already unlocked", async () => {
    writerAdmitted = false;
    unlocked = true;

    const result = await pass();

    expect(result.kind).not.toBe("not_for_sale");
  });
});

describe("performGatePass — paid access withdrawn", () => {
  it("refuses a purchase, and calls the payment service NOT AT ALL", async () => {
    withdrawn = true;

    const result = await pass();

    expect(result.kind).toBe("not_for_sale");
    expect(fetchSpy).not.toHaveBeenCalled();
    // No tab either: nothing about this reader has changed.
    expect(ran("reading_tabs")).toBe(false);
  });

  it("does NOT take away a piece the reader has already unlocked", async () => {
    // The whole reason it sits after the free path. A reader who paid for this
    // last month keeps it — withdrawing a SALE is not confiscating a purchase.
    withdrawn = true;
    unlocked = true;

    const result = await pass();

    expect(result.kind).not.toBe("not_for_sale");
  });

  it("does NOT take it away from a subscriber", async () => {
    withdrawn = true;
    subscribed = true;

    const result = await pass();

    expect(result.kind).not.toBe("not_for_sale");
  });

  it("does NOT stop the writer reading their own piece", async () => {
    withdrawn = true;

    const result = await performGatePass({
      readerId: WRITER,
      readerPubkey: "f".repeat(64),
      nostrEventId: EVENT_ID,
    });

    expect(result.kind).not.toBe("not_for_sale");
  });

  it("outranks the terms refusal — a piece that cannot be bought asks nothing", async () => {
    // Both refusals are live for this reader. Asking them to accept the Reader
    // Terms in order to buy something that is not on sale sends them to do
    // something that cannot help.
    withdrawn = true;
    readerRow = { has_card: true, reader_terms_version: null };

    const result = await pass();

    expect(result.kind).toBe("not_for_sale");
  });

  it("an ordinary writer's piece is unaffected — the control", async () => {
    withdrawn = false;
    readerRow = { has_card: true, reader_terms_version: READER_TERMS_VERSION };

    const result = await pass();

    expect(result.kind).not.toBe("not_for_sale");
    expect(fetchSpy).toHaveBeenCalled();
  });
});
