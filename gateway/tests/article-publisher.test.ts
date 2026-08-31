import { describe, it, expect, vi, beforeEach } from "vitest";

// =============================================================================
// services/article-publisher.ts — the date split, and the two suppressions.
//
// This module is the ONE server-side publish pipeline (ARCHIVE-IMPORT-ADR §II).
// The scheduler is its first caller with every option defaulted; the archive
// importer is the second, and it is the importer's three options that this
// suite exists to pin.
//
// The date contract (ADR §III) is the whole reason the options exist:
//
//   published_at  →  BACKDATED   (articles column, feed_items column, and the
//                                 NIP-23 `published_at` tag) — first publication
//   created_at    →  NOW         (the signed event) — when this event was signed
//
// Backdating created_at as well would be legal only inside strfry's ten-year
// rejectEventsOlderThanSeconds window, past which the article row indexes
// cleanly and the relay publish silently fails. So the two must not be wired
// to the same source, and a test that only checked `published_at` would pass
// against exactly that bug.
//
// The param assertions are DERIVED from the SQL the mock is handed — the
// column list and the VALUES list are read and matched — not from a hardcoded
// position. articles' VALUES carries a literal ('tier1') among its
// placeholders, so column index and param index genuinely differ, and a test
// asserting a remembered `$14` would pin the memory rather than the query.
// =============================================================================

interface Call {
  sql: string;
  params: unknown[];
}

let txCalls: Call[] = [];
let signedTemplates: Array<Record<string, any>> = [];
/** The client `withTransaction` handed its callback — the identity the outbox
 *  enqueue must be called with. See the enqueue test for why. */
let txClient: unknown = null;
const emailMock = vi.fn();
const driveMock = vi.fn();
const enqueueMock = vi.fn();

const ARTICLE_ID = "aaaaaaaa-0000-4000-8000-00000000aaaa";

function scriptedQuery(sql: string, params: unknown[] = []) {
  txCalls.push({ sql, params });
  if (sql.includes("INSERT INTO articles"))
    return Promise.resolve({ rows: [{ id: ARTICLE_ID }], rowCount: 1 });
  if (sql.includes("SELECT display_name"))
    return Promise.resolve({
      rows: [
        {
          display_name: "Ilse Marchetti",
          avatar_blossom_url: null,
          username: "ilse",
        },
      ],
      rowCount: 1,
    });
  return Promise.resolve({ rows: [], rowCount: 1 });
}

vi.mock("@platform-pub/shared/db/client.js", () => ({
  pool: { query: vi.fn() },
  withTransaction: (cb: (c: { query: typeof scriptedQuery }) => Promise<unknown>) => {
    txClient = { query: scriptedQuery };
    return cb(txClient as { query: typeof scriptedQuery });
  },
}));

vi.mock("../src/lib/key-custody-client.js", () => ({
  signEvent: (_writerId: string, template: Record<string, any>) => {
    signedTemplates.push(template);
    return Promise.resolve({
      ...template,
      id: `event-${signedTemplates.length}`,
      sig: "sig",
    });
  },
}));

vi.mock("@platform-pub/shared/lib/relay-outbox.js", () => ({
  enqueueRelayPublish: (...args: unknown[]) => {
    enqueueMock(...args);
    return Promise.resolve();
  },
}));

vi.mock("@platform-pub/shared/lib/publish-emails.js", () => ({
  sendPublishNotifications: (...args: unknown[]) => {
    emailMock(...args);
    return Promise.resolve();
  },
}));

vi.mock("../src/routes/drives.js", () => ({
  checkAndTriggerDriveFulfilment: (...args: unknown[]) => {
    driveMock(...args);
    return Promise.resolve();
  },
}));

vi.mock("@platform-pub/shared/lib/logger.js", () => ({
  default: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

import { publishPersonalArticle } from "../src/services/article-publisher.js";

// =============================================================================
// SQL derivation helpers — read the binding out of the query, never guess it
// =============================================================================

/**
 * Given an INSERT, return the 0-based index into the params array for `column`.
 * Reads the column list and the VALUES list and pairs them positionally, so a
 * literal among the placeholders (articles' 'tier1') is handled correctly and
 * a reordered column list keeps the test honest.
 */
function paramIndexFor(sql: string, table: string, column: string): number {
  const m = sql.match(
    new RegExp(`INSERT INTO ${table}\\s*\\(([^)]*)\\)\\s*VALUES\\s*\\(([^)]*)\\)`, "i"),
  );
  if (!m) throw new Error(`no INSERT INTO ${table} found in SQL`);
  const columns = m[1].split(",").map((c) => c.trim());
  const values = m[2].split(",").map((v) => v.trim());
  const col = columns.indexOf(column);
  if (col === -1) throw new Error(`${table} INSERT does not name ${column}`);
  const placeholder = values[col]?.match(/^\$(\d+)$/);
  if (!placeholder)
    throw new Error(`${table}.${column} is bound to a literal (${values[col]}), not a param`);
  return Number(placeholder[1]) - 1;
}

/**
 * Given an upsert, return the columns its `ON CONFLICT … DO UPDATE SET` arm
 * refreshes FROM THEIR OWN `EXCLUDED` counterpart — so a cross-wired
 * `published_at = EXCLUDED.created_at` reads as not-refreshed rather than as
 * fine. Derived from the SQL for the same reason `paramIndexFor` is: a
 * remembered list pins the memory rather than the query.
 */
function conflictRefreshes(sql: string, table: string): string[] {
  const stripped = sql.replace(/--[^\n]*/g, "");
  const m = stripped.match(
    new RegExp(`INSERT INTO ${table}\\b[\\s\\S]*?DO UPDATE SET([\\s\\S]*)`, "i"),
  );
  if (!m) throw new Error(`no INSERT INTO ${table} … DO UPDATE SET found in SQL`);
  const setList = m[1].split(/\bRETURNING\b/i)[0];
  return [...setList.matchAll(/(\w+)\s*=\s*EXCLUDED\.(\w+)/gi)]
    .filter(([, col, excluded]) => col.toLowerCase() === excluded.toLowerCase())
    .map(([, col]) => col.toLowerCase());
}

function insertFor(table: string): Call {
  const call = txCalls.find((c) => c.sql.includes(`INSERT INTO ${table}`));
  if (!call) throw new Error(`no INSERT INTO ${table} was issued`);
  return call;
}

function publishedAtParam(table: string): unknown {
  const call = insertFor(table);
  return call.params[paramIndexFor(call.sql, table, "published_at")];
}

function tagValue(template: Record<string, any>, name: string): string | undefined {
  return (template.tags as string[][]).find((t) => t[0] === name)?.[1];
}

const INPUT = {
  writerId: "11111111-0000-4000-8000-000000000001",
  title: "The Longshore Report",
  dek: "A standfirst",
  contentRaw: "Body of the piece.",
  nostrDTag: "the-longshore-report-abc",
  gatePositionPct: null,
  pricePence: null,
  coverImageUrl: null,
  commentsEnabled: null,
};

beforeEach(() => {
  txCalls = [];
  signedTemplates = [];
  txClient = null;
  emailMock.mockClear();
  driveMock.mockClear();
  enqueueMock.mockClear();
});

// =============================================================================

describe("publishPersonalArticle — the date split", () => {
  const BACKDATE = new Date("2019-03-04T09:00:00.000Z");
  const BACKDATE_EPOCH = Math.floor(BACKDATE.getTime() / 1000);

  it("backdates published_at in all three places and leaves created_at at now", async () => {
    const before = Math.floor(Date.now() / 1000);
    await publishPersonalArticle(INPUT, { publishedAt: BACKDATE });
    const after = Math.floor(Date.now() / 1000);

    // 1. the NIP-23 tag
    expect(tagValue(signedTemplates[0], "published_at")).toBe(
      String(BACKDATE_EPOCH),
    );

    // 2. the articles column
    expect(publishedAtParam("articles")).toEqual(BACKDATE);

    // 3. the feed_items column — the one most easily forgotten, and the one
    //    that decides where the post lands in every follower's feed
    expect(publishedAtParam("feed_items")).toEqual(BACKDATE);

    // ...and the event's own created_at is NOW, not the backdate. Asserted as
    // a window rather than an equality so it cannot pass by coincidence, plus
    // an explicit inequality so wiring both to publishedAt fails loudly.
    const createdAt = signedTemplates[0].created_at as number;
    expect(createdAt).toBeGreaterThanOrEqual(before);
    expect(createdAt).toBeLessThanOrEqual(after);
    expect(createdAt).not.toBe(BACKDATE_EPOCH);
  });

  it("defaults every date to now when no publishedAt is given (scheduler parity)", async () => {
    const before = Date.now();
    await publishPersonalArticle(INPUT);
    const after = Date.now();

    const articlesAt = publishedAtParam("articles") as Date;
    const feedAt = publishedAtParam("feed_items") as Date;

    expect(articlesAt.getTime()).toBeGreaterThanOrEqual(before);
    expect(articlesAt.getTime()).toBeLessThanOrEqual(after);
    expect(feedAt).toEqual(articlesAt);

    const tagEpoch = Number(tagValue(signedTemplates[0], "published_at"));
    expect(tagEpoch).toBe(Math.floor(articlesAt.getTime() / 1000));
  });

  it("writes the same instant to both columns and the tag", async () => {
    await publishPersonalArticle(INPUT, { publishedAt: BACKDATE });
    // A drift between the two columns would sort the feed and the profile
    // differently for the same article.
    expect(publishedAtParam("articles")).toEqual(publishedAtParam("feed_items"));
    expect(tagValue(signedTemplates[0], "published_at")).toBe(
      String(Math.floor((publishedAtParam("articles") as Date).getTime() / 1000)),
    );
  });

  it("converges published_at on BOTH upserts' conflict arms, not just the inserts", async () => {
    // The test above pins the INSERT arms only, and both upserts are re-entered
    // by design: ARCHIVE-IMPORT-ADR §VII converges an import re-run through the
    // deterministic d-tag, which is the path a CORRECTED date arrives on. An
    // arm that refreshes one column and not the other splits the article and
    // profile surfaces from every follower's feed, with neither row wrong on
    // its own. Asserted as a pair so a future column added to one arm alone
    // fails here rather than in a follower's timeline.
    await publishPersonalArticle(INPUT, { publishedAt: BACKDATE });
    expect(conflictRefreshes(insertFor("articles").sql, "articles")).toContain("published_at");
    expect(conflictRefreshes(insertFor("feed_items").sql, "feed_items")).toContain("published_at");
  });
});

describe("publishPersonalArticle — the suppressions", () => {
  it("sends no subscriber email when sendEmail is false", async () => {
    await publishPersonalArticle(INPUT, { sendEmail: false });
    expect(emailMock).not.toHaveBeenCalled();
  });

  it("emails by default (the scheduler's behaviour is unchanged)", async () => {
    await publishPersonalArticle(INPUT);
    expect(emailMock).toHaveBeenCalledTimes(1);
    expect(emailMock.mock.calls[0][1]).toBe(ARTICLE_ID);
  });

  it("does not touch pledge drives when matchDrives is false", async () => {
    await publishPersonalArticle(INPUT, {
      matchDrives: false,
      draftId: "dddddddd-0000-4000-8000-00000000dddd",
    });
    expect(driveMock).not.toHaveBeenCalled();
  });

  it("matches drives by default, passing the draft id through", async () => {
    const draftId = "dddddddd-0000-4000-8000-00000000dddd";
    await publishPersonalArticle(INPUT, { draftId });
    expect(driveMock).toHaveBeenCalledTimes(1);
    expect(driveMock.mock.calls[0]).toEqual([INPUT.writerId, ARTICLE_ID, draftId]);
  });

  it("still enqueues a free article to the relay outbox inside the txn", async () => {
    // The suppressions must not have cost the outbox enqueue — that is the
    // relay-outbox invariant, and it is what makes a publish durable.
    await publishPersonalArticle(INPUT, { sendEmail: false, matchDrives: false });
    expect(enqueueMock).toHaveBeenCalledTimes(1);
    expect(enqueueMock.mock.calls[0][1]).toMatchObject({
      entityType: "article",
      entityId: ARTICLE_ID,
    });
    // "inside the txn" is the CLIENT ARGUMENT and nothing else. The payload
    // assertion above is identical whether the enqueue rides the transaction or
    // runs after it has committed — so without this line the test's own title
    // was unpinned, and moving the enqueue below `withTransaction` (the exact
    // shape the invariant forbids, since the article would then commit with no
    // outbox row) left the suite green.
    expect(txClient).not.toBeNull();
    expect(enqueueMock.mock.calls[0][0]).toBe(txClient);
  });
});
