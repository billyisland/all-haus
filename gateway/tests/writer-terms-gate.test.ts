import { describe, it, expect, vi, beforeEach } from "vitest";
import Fastify from "fastify";

// =============================================================================
// The Writer Agreement refusal — all three paths a paywalled article can take.
//
// Paid access is sold under the Writer Agreement, and the code sells it long
// before Connect onboarding exists, so the FIRST PAYWALLED PUBLISH is the
// acceptance point (operator decision A3, 2026-09-16).
//
// THERE ARE THREE DOORS, NOT ONE, and the queue item named only the first:
//
//   POST /articles              the web's publish pipeline (v1 index, then v2)
//   POST /drafts/:id/schedule   the gesture that schedules a paywalled draft
//   publishPersonalArticle      what the scheduler and the archive importer
//                               call, which touches neither route
//
// A refusal on the route alone leaves the scheduled path open: schedule a
// paywalled draft, and minutes later the worker publishes paid access under a
// text the writer never accepted, with nobody watching. So the publisher throws
// and the scheduler treats it as a PERMANENT rejection — un-schedule, keep the
// draft — which is the disposition it already gives the two publication
// refusals, and the opposite of the retry-forever loop a generic throw gets.
//
// EVERY CASE ASSERTS WHAT DID NOT HAPPEN: no article row written, no event
// signed. A status-code assertion passes against a route that indexes the
// article and then returns 403.
//
// AND EVERY CASE HAS A FREE CONTROL. A free article is not a sale and the
// Writer Agreement is not what it rests on — a guard written as a blanket
// refusal stops everybody writing, and a suite that only sends paywalled
// payloads goes green against it.
// =============================================================================

const WRITER = "00000000-0000-4000-8000-0000000000a1";
const DRAFT = "00000000-0000-4000-8000-0000000000d1";

/** What the accounts read answers with — set per case. */
let writerVersion: string | null = null;
/** READER-WRITER-SPLIT-ADR: has WRITER been admitted as a writer? */
let writerAdmitted = true;
/** The draft the schedule route reads. */
interface ScheduleRow {
  title: string;
  content_raw: string;
  price_pence: number | null;
  gate_position_pct: number | null;
}
const FREE_ROW: ScheduleRow = { title: "A piece", content_raw: "Free body", price_pence: 0, gate_position_pct: null };
let draftRow: ScheduleRow = { ...FREE_ROW };

let calls: Array<{ sql: string; params: unknown[] }> = [];
const ran = (fragment: string) => calls.some((c) => c.sql.includes(fragment));

function scriptedQuery(sql: string, params: unknown[] = []) {
  calls.push({ sql, params: [...params] });

  // The writer gate's read (lib/writer-gate.ts), answered from the id it is
  // HANDED: only WRITER exists, and whether they are admitted is per case.
  if (sql.includes("AS can_write")) {
    return Promise.resolve(
      params[0] === WRITER
        ? { rows: [{ can_write: writerAdmitted }], rowCount: 1 }
        : { rows: [], rowCount: 0 },
    );
  }

  if (sql.includes("SELECT writer_terms_version FROM accounts")) {
    // Answered from the id it is HANDED, never from a fixture.
    return Promise.resolve(
      params[0] === WRITER
        ? { rows: [{ writer_terms_version: writerVersion }], rowCount: 1 }
        : { rows: [], rowCount: 0 },
    );
  }
  if (sql.includes("FROM article_drafts")) {
    return Promise.resolve(
      params[0] === DRAFT ? { rows: [draftRow], rowCount: 1 } : { rows: [], rowCount: 0 },
    );
  }
  if (sql.includes("UPDATE article_drafts")) {
    return Promise.resolve({
      rows: [{ id: DRAFT, scheduled_at: "2099-01-01T00:00:00.000Z" }],
      rowCount: 1,
    });
  }
  if (sql.includes("SELECT nostr_event_id FROM articles")) {
    return Promise.resolve({ rows: [], rowCount: 0 });
  }
  if (sql.includes("INSERT INTO articles")) {
    return Promise.resolve({
      rows: [{ id: "00000000-0000-4000-8000-0000000000c1", is_new: true }],
      rowCount: 1,
    });
  }
  return Promise.resolve({ rows: [], rowCount: 0 });
}

vi.mock("@platform-pub/shared/db/client.js", () => ({
  pool: { query: (sql: string, p: unknown[] = []) => scriptedQuery(sql, p) },
  withTransaction: (cb: (c: { query: typeof scriptedQuery }) => Promise<unknown>) =>
    cb({ query: scriptedQuery }),
}));

const signEvent = vi.fn(async () => ({ id: "f".repeat(64), sig: "s" }));
vi.mock("../src/lib/key-custody-client.js", () => ({
  signEvent: (...a: unknown[]) => signEvent(...(a as [])),
  generateKeypair: vi.fn(),
}));

vi.mock("@platform-pub/shared/lib/logger.js", () => ({
  default: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

vi.mock("@platform-pub/shared/lib/env.js", () => ({
  requireEnv: (name: string) => `stub-${name}`,
  requireEnvMinLength: (name: string) => `stub-${name}`,
  internalSecret: () => "stub-secret",
  publicationsEnabled: () => false,
}));

vi.mock("@platform-pub/shared/lib/relay-outbox.js", () => ({
  enqueueRelayPublish: vi.fn(),
}));
// Returns a PROMISE: the route calls `.catch()` on it, so a bare `vi.fn()`
// makes every happy path 500 on `undefined.catch` and the suite would then be
// testing the refusal against a route that never worked.
vi.mock("@platform-pub/shared/lib/publish-emails.js", () => ({
  sendPublishNotifications: vi.fn(async () => undefined),
}));
vi.mock("../src/routes/drives.js", () => ({
  matchDriveForPublish: vi.fn(async () => null),
  queueDriveFulfilment: vi.fn(),
  checkAndTriggerDriveFulfilment: vi.fn(),
}));
vi.mock("../src/lib/article-event-rekey.js", () => ({
  rekeyArticleEvent: vi.fn(async () => 0),
}));
vi.mock("../src/lib/key-service-client.js", () => ({
  keyServiceHeaders: () => ({}),
}));

vi.mock("../src/middleware/auth.js", () => ({
  requireAuth: async (req: { session?: { sub: string } }) => {
    req.session = { sub: WRITER };
  },
  optionalAuth: async (req: { session?: { sub: string } }) => {
    req.session = { sub: WRITER };
  },
}));

import { articlePublishRoutes } from "../src/routes/articles/publish.js";
import { draftRoutes } from "../src/routes/drafts.js";
import { publishPersonalArticle } from "../src/services/article-publisher.js";
import { WriterTermsRequiredError } from "../src/lib/terms-gate.js";
import { WriterAccessRequiredError } from "../src/lib/writer-gate.js";
import { WRITER_TERMS_VERSION } from "@platform-pub/shared/lib/terms-versions.js";

const PAYWALL_MARKER = "<!-- paywall-gate -->";

beforeEach(() => {
  calls = [];
  writerVersion = null;
  writerAdmitted = true;
  draftRow = { ...FREE_ROW };
  signEvent.mockClear();
});

async function index(body: Record<string, unknown>) {
  const app = Fastify({ logger: false });
  await app.register(articlePublishRoutes);
  const res = await app.inject({ method: "POST", url: "/articles", payload: body });
  await app.close();
  return res;
}

const PAID_ARTICLE = {
  nostrEventId: "a".repeat(64),
  dTag: "a-piece",
  title: "A piece",
  content: "The free run",
  accessMode: "paywalled",
  pricePence: 300,
  gatePositionPct: 50,
};

describe("POST /articles — the Writer Agreement refusal", () => {
  it("refuses a paywalled publish with nothing accepted, and indexes nothing", async () => {
    const res = await index(PAID_ARTICLE);

    expect(res.statusCode).toBe(403);
    expect(res.json().error).toBe("writer_terms_required");
    // The whole finding: refused BEFORE the row is written. A 403 returned
    // after the upsert leaves a live paywalled article behind it.
    expect(ran("INSERT INTO articles")).toBe(false);
  });

  it("refuses a writer stranded on a superseded MAJOR version", async () => {
    writerVersion = "0.4";
    const res = await index(PAID_ARTICLE);
    expect(res.statusCode).toBe(403);
    expect(ran("INSERT INTO articles")).toBe(false);
  });

  it("lets the accepted writer publish paid access", async () => {
    writerVersion = WRITER_TERMS_VERSION;
    const res = await index(PAID_ARTICLE);
    expect(res.statusCode).toBe(201);
    expect(ran("INSERT INTO articles")).toBe(true);
  });

  it("lets a newer TEXT sub-version through — only major is compared", async () => {
    writerVersion = `${WRITER_TERMS_VERSION.split(".")[0]}.7`;
    const res = await index(PAID_ARTICLE);
    expect(res.statusCode).toBe(201);
  });

  it("leaves a FREE publish completely untouched — it is not a sale", async () => {
    // The control. A blanket guard stops everybody writing, and this is the
    // case that says the refusal is about paid access and nothing else.
    const res = await index({
      ...PAID_ARTICLE,
      accessMode: "public",
      pricePence: 0,
      gatePositionPct: 0,
    });
    expect(res.statusCode).toBe(201);
    expect(ran("INSERT INTO articles")).toBe(true);
    // It did not even ask the question.
    expect(ran("SELECT writer_terms_version FROM accounts")).toBe(false);
  });
});

describe("POST /drafts/:id/schedule — refused at the gesture", () => {
  async function schedule() {
    const app = Fastify({ logger: false });
    await app.register(draftRoutes);
    const res = await app.inject({
      method: "POST",
      url: `/drafts/${DRAFT}/schedule`,
      payload: { scheduledAt: "2099-01-01T00:00:00.000Z" },
    });
    await app.close();
    return res;
  }

  it("refuses a paywalled draft, and does not schedule it", async () => {
    draftRow = { ...FREE_ROW, content_raw: `Free run${PAYWALL_MARKER}Paid run`, price_pence: 300, gate_position_pct: 50 };
    const res = await schedule();

    expect(res.statusCode).toBe(403);
    expect(res.json().error).toBe("writer_terms_required");
    // Refused BEFORE the write, or the draft is scheduled and the answer is a
    // 403 about a thing that already happened.
    expect(ran("UPDATE article_drafts")).toBe(false);
  });

  it("schedules the same draft once the writer has accepted", async () => {
    writerVersion = WRITER_TERMS_VERSION;
    draftRow = { ...FREE_ROW, content_raw: `Free run${PAYWALL_MARKER}Paid run`, price_pence: 300, gate_position_pct: 50 };
    const res = await schedule();
    expect(res.statusCode).toBe(200);
    expect(ran("UPDATE article_drafts")).toBe(true);
  });

  it("schedules a FREE draft without asking", async () => {
    draftRow = { ...FREE_ROW };
    const res = await schedule();
    expect(res.statusCode).toBe(200);
    expect(ran("SELECT writer_terms_version FROM accounts")).toBe(false);
  });

  it("REFUSES a gated draft priced at zero — it is not a sale, and it is not publishable either", async () => {
    // Until 2026-09-29 this case was scheduled (CA-A1): the paywalled
    // predicate is the publisher's — a marker AND a price — so a gate with no
    // price was "not a sale", never asked the agreement, and was then
    // published FREE by the publisher, the marker-stripped whole body in
    // public. The door now refuses it the way the editor and publish-now do,
    // and never gets as far as the agreement question.
    draftRow = { ...FREE_ROW, content_raw: `Free run${PAYWALL_MARKER}Paid run`, price_pence: 0, gate_position_pct: 50 };
    const res = await schedule();
    expect(res.statusCode).toBe(400);
    expect(res.json().error).toBe("paywall_price");
    expect(ran("UPDATE article_drafts")).toBe(false);
    expect(ran("SELECT writer_terms_version FROM accounts")).toBe(false);
  });
});

describe("publishPersonalArticle — the backstop the scheduler runs on", () => {
  const input = {
    writerId: WRITER,
    title: "A piece",
    dek: null,
    contentRaw: `Free run${PAYWALL_MARKER}Paid run`,
    nostrDTag: null,
    gatePositionPct: 50,
    pricePence: 300,
    coverImageUrl: null,
    commentsEnabled: true,
  };

  it("throws WriterTermsRequiredError for a paywalled publish, before signing", async () => {
    await expect(
      publishPersonalArticle(input, { sendEmail: false, matchDrives: false }),
    ).rejects.toBeInstanceOf(WriterTermsRequiredError);

    // The type is what the scheduler branches on — a generic Error would be
    // retried every cycle forever instead of un-scheduling the draft.
    // And nothing was signed: the refusal is before key-custody, not after.
    expect(signEvent).not.toHaveBeenCalled();
    expect(ran("INSERT INTO articles")).toBe(false);
  });

  it("publishes a FREE article without asking", async () => {
    await publishPersonalArticle(
      { ...input, contentRaw: "Just a free piece", pricePence: null },
      { sendEmail: false, matchDrives: false },
    );
    expect(signEvent).toHaveBeenCalled();
    expect(ran("SELECT writer_terms_version FROM accounts")).toBe(false);
  });
});

// =============================================================================
// WRITER ACCESS IS ASKED FIRST, AND OF EVERY PIECE (READER-WRITER-SPLIT-ADR §2).
//
// The Writer Agreement is asked only where the piece is paywalled, because a
// free publish is not a sale. The writer gate is about publishing at all, so
// it is its own unconditional question — and it goes BEFORE the agreement:
// asking a reader to accept a text for an act they cannot perform is a button
// that cannot do its job. Two pins per door: a reader's PAYWALLED piece with
// no agreement gets `writer_access_required`, not the terms refusal; and a
// reader's FREE piece — the case the terms gate's own condition lets through —
// is refused too.
// =============================================================================
describe("a READER at every door — writer access before the agreement", () => {
  const SCHEDULE_PAID: ScheduleRow = {
    ...FREE_ROW,
    content_raw: `Free run${PAYWALL_MARKER}Paid run`,
    price_pence: 300,
    gate_position_pct: 50,
  };

  async function schedule() {
    const app = Fastify({ logger: false });
    await app.register(draftRoutes);
    const res = await app.inject({
      method: "POST",
      url: `/drafts/${DRAFT}/schedule`,
      payload: { scheduledAt: "2099-01-01T00:00:00.000Z" },
    });
    await app.close();
    return res;
  }

  it("POST /articles: a paywalled piece, no agreement — writer_access_required, never the terms", async () => {
    writerAdmitted = false;
    const res = await index(PAID_ARTICLE);
    expect(res.statusCode).toBe(403);
    expect(res.json().error).toBe("writer_access_required");
    expect(ran("SELECT writer_terms_version FROM accounts")).toBe(false);
    expect(ran("INSERT INTO articles")).toBe(false);
  });

  it("POST /articles: a FREE piece is refused too", async () => {
    writerAdmitted = false;
    const res = await index({ ...PAID_ARTICLE, accessMode: "public", pricePence: 0, gatePositionPct: 0 });
    expect(res.statusCode).toBe(403);
    expect(res.json().error).toBe("writer_access_required");
    expect(ran("INSERT INTO articles")).toBe(false);
  });

  it("POST /drafts/:id/schedule: a paywalled draft, no agreement — writer_access_required", async () => {
    writerAdmitted = false;
    draftRow = { ...SCHEDULE_PAID };
    const res = await schedule();
    expect(res.statusCode).toBe(403);
    expect(res.json().error).toBe("writer_access_required");
    expect(ran("SELECT writer_terms_version FROM accounts")).toBe(false);
    expect(ran("UPDATE article_drafts")).toBe(false);
  });

  it("POST /drafts/:id/schedule: a FREE draft is refused too", async () => {
    writerAdmitted = false;
    const res = await schedule();
    expect(res.statusCode).toBe(403);
    expect(ran("UPDATE article_drafts")).toBe(false);
  });

  const input = {
    writerId: WRITER,
    title: "A piece",
    dek: null,
    contentRaw: `Free run${PAYWALL_MARKER}Paid run`,
    nostrDTag: null,
    gatePositionPct: 50,
    pricePence: 300,
    coverImageUrl: null,
    commentsEnabled: true,
  };

  it("publishPersonalArticle: a paywalled piece, no agreement — WriterAccessRequiredError, before signing", async () => {
    writerAdmitted = false;
    const err = await publishPersonalArticle(input, { sendEmail: false, matchDrives: false }).catch((e) => e);
    expect(err).toBeInstanceOf(WriterAccessRequiredError);
    expect(err).not.toBeInstanceOf(WriterTermsRequiredError);
    expect(signEvent).not.toHaveBeenCalled();
    expect(ran("SELECT writer_terms_version FROM accounts")).toBe(false);
    expect(ran("INSERT INTO articles")).toBe(false);
  });

  it("publishPersonalArticle: a FREE piece is refused too", async () => {
    writerAdmitted = false;
    await expect(
      publishPersonalArticle(
        { ...input, contentRaw: "Just a free piece", pricePence: null },
        { sendEmail: false, matchDrives: false },
      ),
    ).rejects.toBeInstanceOf(WriterAccessRequiredError);
    expect(signEvent).not.toHaveBeenCalled();
  });

  it("an account the read cannot find is a reader — the gate fails closed", async () => {
    await expect(
      publishPersonalArticle(
        { ...input, writerId: "00000000-0000-4000-8000-0000000000ff", contentRaw: "Free", pricePence: null },
        { sendEmail: false, matchDrives: false },
      ),
    ).rejects.toBeInstanceOf(WriterAccessRequiredError);
  });
});
