import { describe, it, expect, vi, beforeEach } from "vitest";
import Fastify from "fastify";

// =============================================================================
// POST /drafts/:id/publish — publish-now, over the ONE server-side publisher
// (MODERNHAUS-ADR Decision 3, §D1.8.2).
//
// It is a DOOR, not a publisher, so what it must prove is that every door's
// precondition holds here too (posts.md) and that the draft is claimed, kept
// and disposed of the way the scheduler does it:
//
//   - every refusal asserts what DID NOT happen: no claim written, no publish.
//     A status-only assertion passes against a route that publishes and then
//     answers 400;
//   - every paywall refusal has a FREE CONTROL — a blanket guard stops
//     everybody writing, and a suite of paywalled payloads goes green against it;
//   - the claim checks `scheduled_at IS NULL` in the same statement that sets
//     it, and stamps the d-tag, so no two presses (and no press and the
//     scheduler) can publish one draft twice as two pieces;
//   - a failure releases the claim and keeps the draft, and a failed release
//     does not REPLACE the failure it was cleaning up after (root CLAUDE.md).
//
// The mocked pool answers from the SQL and the PARAMS it is handed (testing.md):
// a draft is found only under its own id AND its own writer.
// =============================================================================

const WRITER = "00000000-0000-4000-8000-0000000000a1";
const OTHER = "00000000-0000-4000-8000-0000000000a2";
const DRAFT = "00000000-0000-4000-8000-0000000000d1";
const OLDER_DRAFT = "00000000-0000-4000-8000-0000000000d0";
const MARKER = "<!-- paywall-gate -->";

interface DraftRow {
  id: string;
  writer_id: string;
  title: string | null;
  dek: string | null;
  content_raw: string | null;
  nostr_d_tag: string | null;
  gate_position_pct: number | null;
  price_pence: number | null;
  publication_id: string | null;
  cover_image_url: string | null;
  comments_enabled: boolean | null;
  scheduled_at: string | null;
}

let draft: DraftRow;
let writerVersion: string | null;
let priorArticle: boolean;
let claimWins: boolean;
let failDelete: boolean;
let failRelease: boolean;
let calls: Array<{ sql: string; params: unknown[] }>;
let session: string;

const ran = (fragment: string) => calls.filter((c) => c.sql.includes(fragment));

function scriptedQuery(sql: string, params: unknown[] = []) {
  // The writer gate's read (lib/writer-gate.ts). Every author in this file is
  // an admitted writer; the reader cases live in writer-gate.test.ts.
  if (sql.includes("AS can_write")) return Promise.resolve({ rows: [{ can_write: true }], rowCount: 1 });
  calls.push({ sql, params: [...params] });
  if (sql.includes("pg_advisory_xact_lock")) return Promise.resolve({ rows: [], rowCount: 1 });
  if (sql.includes("nostr_d_tag IS NULL AND scheduled_at IS NULL")) {
    // The first-save guess: the writer's most recent untagged draft.
    return Promise.resolve(params[0] === WRITER ? { rows: [{ id: OLDER_DRAFT }], rowCount: 1 } : { rows: [], rowCount: 0 });
  }
  if (sql.includes("INSERT INTO article_drafts")) {
    return Promise.resolve({ rows: [{ id: "00000000-0000-4000-8000-0000000000d9", auto_saved_at: "now" }], rowCount: 1 });
  }
  if (sql.includes("UPDATE article_drafts") && sql.includes("title = COALESCE")) {
    // The explicit-id arm binds (id, writer) as $9/$10; the guess arm binds the id last.
    const id = sql.includes("WHERE id = $9 AND writer_id = $10") ? params[8] : params[params.length - 1];
    return Promise.resolve({ rows: [{ id, auto_saved_at: "now" }], rowCount: 1 });
  }
  if (sql.includes("SELECT writer_terms_version FROM accounts")) {
    return Promise.resolve(
      params[0] === WRITER ? { rows: [{ writer_terms_version: writerVersion }], rowCount: 1 } : { rows: [], rowCount: 0 },
    );
  }
  if (sql.includes("FROM article_drafts") && sql.includes("SELECT")) {
    const hit = params[0] === draft.id && params[1] === draft.writer_id;
    return Promise.resolve(hit ? { rows: [{ ...draft }], rowCount: 1 } : { rows: [], rowCount: 0 });
  }
  if (sql.includes("UPDATE article_drafts") && sql.includes("interval '5 minutes'")) {
    // The claim: only an unscheduled draft of this writer, and only if it wins.
    const ok = claimWins && params[0] === draft.id && params[1] === draft.writer_id && draft.scheduled_at === null;
    return Promise.resolve(ok ? { rows: [{ id: draft.id }], rowCount: 1 } : { rows: [], rowCount: 0 });
  }
  if (sql.includes("UPDATE article_drafts SET scheduled_at = NULL")) {
    if (failRelease) return Promise.reject(new Error("release failed"));
    return Promise.resolve({ rows: [], rowCount: 1 });
  }
  if (sql.includes("DELETE FROM article_drafts")) {
    if (failDelete) return Promise.reject(new Error("delete failed"));
    return Promise.resolve({ rows: [], rowCount: 1 });
  }
  if (sql.includes("SELECT 1 FROM articles")) {
    return Promise.resolve(priorArticle ? { rows: [{ "?column?": 1 }], rowCount: 1 } : { rows: [], rowCount: 0 });
  }
  throw new Error(`unscripted SQL: ${sql.slice(0, 80)}`);
}

vi.mock("@platform-pub/shared/db/client.js", () => ({
  pool: { query: (sql: string, p: unknown[] = []) => scriptedQuery(sql, p) },
  withTransaction: (cb: (c: { query: typeof scriptedQuery }) => Promise<unknown>) => cb({ query: scriptedQuery }),
}));

const logged = vi.hoisted(() => ({ error: vi.fn() }));
vi.mock("@platform-pub/shared/lib/logger.js", () => ({
  default: { info: vi.fn(), warn: vi.fn(), error: logged.error, debug: vi.fn() },
}));
vi.mock("@platform-pub/shared/lib/env.js", () => ({
  requireEnv: (name: string) => `stub-${name}`,
  requireEnvMinLength: (name: string) => `stub-${name}`,
  internalSecret: () => "stub-secret",
  publicationsEnabled: () => false,
}));
vi.mock("../src/lib/key-custody-client.js", () => ({ signEvent: vi.fn(), generateKeypair: vi.fn() }));
vi.mock("@platform-pub/shared/lib/relay-outbox.js", () => ({ enqueueRelayPublish: vi.fn() }));
vi.mock("@platform-pub/shared/lib/publish-emails.js", () => ({ sendPublishNotifications: vi.fn(async () => undefined) }));
vi.mock("../src/routes/drives.js", () => ({
  matchDriveForPublish: vi.fn(async () => null),
  queueDriveFulfilment: vi.fn(),
  checkAndTriggerDriveFulfilment: vi.fn(),
}));
vi.mock("../src/lib/key-service-client.js", () => ({ keyServiceHeaders: () => ({}) }));

const publish = vi.hoisted(() => vi.fn());
vi.mock("../src/services/article-publisher.js", async (orig) => ({
  ...(await orig<typeof import("../src/services/article-publisher.js")>()),
  publishPersonalArticle: publish,
}));

vi.mock("../src/middleware/auth.js", () => ({
  requireAuth: async (req: { session?: { sub: string } }) => {
    req.session = { sub: session };
  },
  optionalAuth: async () => undefined,
}));

import { draftRoutes } from "../src/routes/drafts.js";
import { publishRefusal as publishNowRefusal } from "../src/services/article-publisher.js";
import { WriterTermsRequiredError } from "../src/lib/terms-gate.js";
import { WRITER_TERMS_VERSION } from "@platform-pub/shared/lib/terms-versions.js";

async function press(id = DRAFT, body: unknown = {}) {
  const app = Fastify();
  await app.register(draftRoutes);
  const res = await app.inject({ method: "POST", url: `/drafts/${id}/publish`, payload: body as object });
  await app.close();
  return res;
}

const FREE: DraftRow = {
  id: DRAFT,
  writer_id: WRITER,
  title: "A piece",
  dek: "Its dek",
  content_raw: "The whole of it.",
  nostr_d_tag: null,
  gate_position_pct: 50,
  price_pence: 0,
  publication_id: null,
  cover_image_url: null,
  comments_enabled: true,
  scheduled_at: null,
};
const PAID: DraftRow = { ...FREE, content_raw: `Free half.\n\n${MARKER}\n\nPaid half.`, price_pence: 40, gate_position_pct: 30 };

beforeEach(() => {
  draft = { ...FREE };
  writerVersion = null;
  priorArticle = false;
  claimWins = true;
  failDelete = false;
  failRelease = false;
  calls = [];
  session = WRITER;
  publish.mockReset();
  publish.mockResolvedValue({ articleId: "art-1", dTag: "a-piece-x", eventId: "e".repeat(64) });
  logged.error.mockReset();
});

describe("publish-now: a free draft", () => {
  it("claims the draft, stamps the d-tag, publishes through the one publisher, deletes the draft", async () => {
    const res = await press();
    expect(res.statusCode).toBe(201);
    expect(res.json()).toEqual({ articleId: "art-1", dTag: "a-piece-x", eventId: "e".repeat(64) });

    const [claim] = ran("interval '5 minutes'");
    expect(claim.sql).toContain("scheduled_at IS NULL");
    const stamped = claim.params[2] as string;
    expect(stamped).toMatch(/^a-piece-[0-9a-z]+$/);

    expect(publish).toHaveBeenCalledTimes(1);
    const [input, opts] = publish.mock.calls[0];
    expect(input).toMatchObject({ writerId: WRITER, title: "A piece", contentRaw: "The whole of it.", nostrDTag: stamped });
    expect(opts).toEqual({ draftId: DRAFT, sendEmail: true });
    expect(ran("DELETE FROM article_drafts")).toHaveLength(1);
    expect(ran("SET scheduled_at = NULL")).toHaveLength(0);
  });

  it("keeps a d-tag the draft already carries (an edit of a published piece) and emails nobody", async () => {
    draft = { ...FREE, nostr_d_tag: "existing-tag" };
    priorArticle = true;
    await press();
    expect(ran("interval '5 minutes'")[0].params[2]).toBe("existing-tag");
    expect(publish.mock.calls[0][1]).toEqual({ draftId: DRAFT, sendEmail: false });
  });

  it("honours the writer's no-email choice on a new piece", async () => {
    await press(DRAFT, { sendEmail: false });
    expect(publish.mock.calls[0][1]).toEqual({ draftId: DRAFT, sendEmail: false });
  });
});

describe("publish-now: every refusal happens before the claim and the publish", () => {
  const cases: Array<[string, Partial<DraftRow>, number, string]> = [
    ["no title", { title: "  " }, 400, "title_required"],
    ["nothing to publish", { content_raw: "   " }, 400, "content_required"],
    ["a gate with nothing behind it", { content_raw: `Free.\n\n${MARKER}\n\n` , price_pence: 40 }, 400, "paywall_empty"],
    // The one that would otherwise give the paid half away in public.
    ["a gate with no price", { ...PAID, price_pence: 0 }, 400, "paywall_price"],
    ["a gate position the vault refuses", { ...PAID, gate_position_pct: 0 }, 400, "paywall_gate"],
    ["a gate with no position", { ...PAID, gate_position_pct: null }, 400, "paywall_gate"],
    ["a publication draft", { publication_id: "00000000-0000-4000-8000-0000000000b1" }, 409, "publication_draft"],
    ["a scheduled draft", { scheduled_at: "2099-01-01T00:00:00Z" }, 409, "draft_scheduled"],
  ];
  for (const [what, over, status, code] of cases) {
    it(what, async () => {
      draft = { ...FREE, ...over };
      const res = await press();
      expect(res.statusCode).toBe(status);
      expect(res.json().error).toBe(code);
      expect(ran("interval '5 minutes'")).toHaveLength(0);
      expect(publish).not.toHaveBeenCalled();
    });
  }

  it("a paywalled draft without the current Writer Agreement: 403, nothing claimed or published", async () => {
    draft = { ...PAID };
    const res = await press();
    expect(res.statusCode).toBe(403);
    expect(res.json().error).toBe("writer_terms_required");
    expect(ran("interval '5 minutes'")).toHaveLength(0);
    expect(publish).not.toHaveBeenCalled();
  });

  it("CONTROL: the same paywalled draft with the agreement accepted publishes", async () => {
    draft = { ...PAID };
    writerVersion = WRITER_TERMS_VERSION;
    const res = await press();
    expect(res.statusCode).toBe(201);
    expect(publish.mock.calls[0][0]).toMatchObject({ pricePence: 40, gatePositionPct: 30 });
  });

  it("CONTROL: a free draft is never asked for the Writer Agreement", async () => {
    const res = await press();
    expect(res.statusCode).toBe(201);
    expect(ran("writer_terms_version")).toHaveLength(0);
  });

  it("another writer's draft is not found, and nothing runs", async () => {
    session = OTHER;
    const res = await press();
    expect(res.statusCode).toBe(404);
    expect(publish).not.toHaveBeenCalled();
  });

  it("a malformed id answers 404 before any SQL", async () => {
    const res = await press("not-a-uuid");
    expect(res.statusCode).toBe(404);
    expect(calls).toHaveLength(0);
  });

  it("a lost claim (scheduled or claimed meanwhile, or a second press) is refused, never raced", async () => {
    claimWins = false;
    const res = await press();
    expect(res.statusCode).toBe(409);
    expect(res.json().error).toBe("draft_scheduled");
    expect(publish).not.toHaveBeenCalled();
    expect(ran("DELETE FROM article_drafts")).toHaveLength(0);
  });
});

describe("publish-now: a failure keeps the draft and releases the claim", () => {
  it("a publisher fault: claim released, draft kept, a fault answered", async () => {
    publish.mockRejectedValue(new Error("vault down"));
    const res = await press();
    expect(res.statusCode).toBe(500);
    expect(ran("SET scheduled_at = NULL")).toHaveLength(1);
    expect(ran("DELETE FROM article_drafts")).toHaveLength(0);
  });

  it("the publisher's typed Writer Agreement backstop answers 403, and releases the claim", async () => {
    publish.mockRejectedValue(new WriterTermsRequiredError(WRITER));
    const res = await press();
    expect(res.statusCode).toBe(403);
    expect(res.json().error).toBe("writer_terms_required");
    expect(ran("SET scheduled_at = NULL")).toHaveLength(1);
  });

  it("a failed release does not replace the failure it was cleaning up after", async () => {
    publish.mockRejectedValue(new WriterTermsRequiredError(WRITER));
    failRelease = true;
    const res = await press();
    // Still the publisher's own refusal, not the release's fault.
    expect(res.statusCode).toBe(403);
    const [entry] = logged.error.mock.calls.find(([, msg]) => msg === "Publish-now: claim not released")!;
    expect((entry as { cause: unknown }).cause).toBeInstanceOf(WriterTermsRequiredError);
  });

  it("a draft that cannot be deleted after a publish: still a success, and the claim is let go", async () => {
    failDelete = true;
    const res = await press();
    expect(res.statusCode).toBe(201);
    expect(ran("SET scheduled_at = NULL")).toHaveLength(1);
  });
});

describe("publishNowRefusal keeps the validators' lockstep", () => {
  it("paywalled ⇒ price ≥ 1p and a gate 1..99; a free piece needs neither", () => {
    expect(publishNowRefusal({ title: "t", content_raw: "x", price_pence: 0, gate_position_pct: null })).toBeNull();
    expect(publishNowRefusal({ title: "t", content_raw: `a${MARKER}b`, price_pence: 1, gate_position_pct: 1 })).toBeNull();
    expect(publishNowRefusal({ title: "t", content_raw: `a${MARKER}b`, price_pence: 1, gate_position_pct: 99 })).toBeNull();
    expect(publishNowRefusal({ title: "t", content_raw: `a${MARKER}b`, price_pence: 1, gate_position_pct: 100 })?.error).toBe("paywall_gate");
  });
});

describe("POST /drafts newDraft: a new piece's first save never lands on another draft", () => {
  async function save(body: object) {
    const app = Fastify();
    await app.register(draftRoutes);
    const res = await app.inject({ method: "POST", url: "/drafts", payload: body });
    await app.close();
    return res;
  }

  it("inserts a row of its own, and never asks for the guess", async () => {
    const res = await save({ title: "New", content: "Words", newDraft: true });
    expect(res.statusCode).toBe(201);
    expect(res.json().draftId).toBe("00000000-0000-4000-8000-0000000000d9");
    expect(ran("nostr_d_tag IS NULL AND scheduled_at IS NULL")).toHaveLength(0);
    expect(ran("title = COALESCE")).toHaveLength(0);
    expect(ran("INSERT INTO article_drafts")[0].params.slice(0, 3)).toEqual([WRITER, "New", "Words"]);
  });

  it("CONTROL: without it, the first save updates the writer's most recent untagged draft (the hazard)", async () => {
    const res = await save({ title: "New", content: "Words" });
    expect(res.statusCode).toBe(200);
    expect(res.json().draftId).toBe(OLDER_DRAFT);
    expect(ran("INSERT INTO article_drafts")).toHaveLength(0);
  });

  it("an echoed draftId still wins over the flag", async () => {
    const res = await save({ title: "T", draftId: DRAFT, newDraft: true });
    expect(res.statusCode).toBe(200);
    expect(res.json().draftId).toBe(DRAFT);
    expect(ran("INSERT INTO article_drafts")).toHaveLength(0);
  });
});
