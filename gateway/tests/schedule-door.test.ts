import { describe, it, expect, vi, beforeEach } from "vitest";
import Fastify from "fastify";

// =============================================================================
// The schedule door holds every precondition the other doors hold (CA-A1).
//
// `POST /drafts/:id/schedule` asked only the Writer Agreement. A gate marker
// over a price of zero — which the editor refuses before signing and
// publish-now refuses at its press — went through this door untouched, and
// the publisher, whose paywalled predicate is "a marker AND a price", read it
// as a FREE piece and published the marker-stripped whole body in public. The
// dashboard schedules an autosaved draft with no client check, so this route
// was the only guard that press had, and it had none.
//
// Three things are pinned, one per describe:
//
//   1. the ROUTE answers `publishRefusal` as a 400 at the gesture, and writes
//      nothing — a status-only assertion passes against a route that
//      schedules and then answers 400;
//   2. the PUBLISHER throws the same refusal TYPED, before it signs and before
//      its first transaction — after that transaction the free row is already
//      committed, and a refusal is a 500 the scheduler retries every minute;
//   3. the SCHEDULER un-schedules on the type (draft kept intact) rather than
//      restoring `scheduled_at` for a retry that can never succeed — and it
//      STAMPS the d-tag on the draft before the first publish, so a retry of
//      a transient failure is an edit of one piece, never a second copy.
//
// Every refusal has a FREE CONTROL, because a blanket guard stops everybody
// writing and a suite of paywalled payloads goes green against it.
//
// The mocked pool answers from the SQL and the params it is handed
// (testing.md); the stamp is answered from the row's state, so a COALESCE that
// keeps a tag already there is exercised, not assumed. The row-per-minute leak
// itself needs Postgres's upsert and is proved in `scheduler-claim.test.ts`.
// =============================================================================

const WRITER = "00000000-0000-4000-8000-0000000000a1";
const DRAFT = "00000000-0000-4000-8000-0000000000d1";
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

const FREE: DraftRow = {
  id: DRAFT,
  writer_id: WRITER,
  title: "A piece",
  dek: null,
  content_raw: "The whole of it.",
  nostr_d_tag: null,
  gate_position_pct: null,
  price_pence: 0,
  publication_id: null,
  cover_image_url: null,
  comments_enabled: true,
  scheduled_at: null,
};
const PAID: DraftRow = {
  ...FREE,
  content_raw: `Free half.\n\n${MARKER}\n\nPaid half.`,
  price_pence: 40,
  gate_position_pct: 30,
};

let draft: DraftRow;
/** When set, the scheduler's claim answers with this instead of `draft`. */
let staleClaim: DraftRow | null = null;
let writerVersion: string | null;
let calls: Array<{ sql: string; params: unknown[] }>;
const ran = (fragment: string) => calls.filter((c) => c.sql.includes(fragment));

/** READER-WRITER-SPLIT-ADR: is the draft's author an admitted writer? */
let authorAdmitted = true;

function scriptedQuery(sql: string, params: unknown[] = []) {
  // The writer gate's read (lib/writer-gate.ts): admitted unless a case says
  // otherwise (the scheduler's un-schedule case below).
  if (sql.includes("AS can_write")) return Promise.resolve({ rows: [{ can_write: authorAdmitted }], rowCount: 1 });
  calls.push({ sql, params: [...params] });
  if (sql.includes("SELECT writer_terms_version FROM accounts")) {
    return Promise.resolve(
      params[0] === WRITER
        ? { rows: [{ writer_terms_version: writerVersion }], rowCount: 1 }
        : { rows: [], rowCount: 0 },
    );
  }
  if (sql.includes("UPDATE article_drafts") && sql.includes("FOR UPDATE SKIP LOCKED")) {
    // The scheduler's claim (FIRST: its subquery also reads FROM article_drafts): the due draft, a COPY of it — or the stale copy a
    // test planted, when it wants the row to have moved on since the claim.
    const row = staleClaim ?? draft;
    return Promise.resolve(
      row.scheduled_at !== null ? { rows: [{ ...row }], rowCount: 1 } : { rows: [], rowCount: 0 },
    );
  }
  if (sql.includes("FROM article_drafts") && sql.includes("SELECT")) {
    const hit = params[0] === draft.id && params[1] === draft.writer_id;
    return Promise.resolve(hit ? { rows: [{ ...draft }], rowCount: 1 } : { rows: [], rowCount: 0 });
  }
  if (sql.includes("SET nostr_d_tag = COALESCE(nostr_d_tag, $2)")) {
    // The stamp, answered from the row: a tag already there is kept.
    if (params[0] !== draft.id) return Promise.resolve({ rows: [], rowCount: 0 });
    draft.nostr_d_tag = draft.nostr_d_tag ?? (params[1] as string);
    return Promise.resolve({ rows: [{ nostr_d_tag: draft.nostr_d_tag }], rowCount: 1 });
  }
  if (sql.includes("UPDATE article_drafts")) {
    return Promise.resolve({ rows: [{ id: DRAFT, scheduled_at: "2099-01-01T00:00:00.000Z" }], rowCount: 1 });
  }
  if (sql.includes("DELETE FROM article_drafts")) {
    return Promise.resolve({ rows: [], rowCount: 1 });
  }
  if (sql.includes("SELECT nostr_event_id FROM articles")) {
    return Promise.resolve({ rows: [], rowCount: 0 });
  }
  if (sql.includes("INSERT INTO articles")) {
    return Promise.resolve({ rows: [{ id: "00000000-0000-4000-8000-0000000000c1" }], rowCount: 1 });
  }
  return Promise.resolve({ rows: [], rowCount: 0 });
}

vi.mock("@platform-pub/shared/db/client.js", () => ({
  pool: { query: (sql: string, p: unknown[] = []) => scriptedQuery(sql, p) },
  withTransaction: (cb: (c: { query: typeof scriptedQuery }) => Promise<unknown>) =>
    cb({ query: scriptedQuery }),
}));

const signEvent = vi.fn(async () => ({ id: "f".repeat(64), sig: "s", created_at: 1 }));
vi.mock("../src/lib/key-custody-client.js", () => ({
  signEvent: (...a: unknown[]) => signEvent(...(a as [])),
  generateKeypair: vi.fn(),
}));
const logged = vi.hoisted(() => ({ warn: vi.fn(), error: vi.fn() }));
vi.mock("@platform-pub/shared/lib/logger.js", () => ({
  default: { info: vi.fn(), warn: logged.warn, error: logged.error, debug: vi.fn() },
}));
vi.mock("@platform-pub/shared/lib/env.js", () => ({
  requireEnv: (name: string) => `stub-${name}`,
  requireEnvMinLength: (name: string) => `stub-${name}`,
  internalSecret: () => "stub-secret",
  publicationsEnabled: () => false,
}));
vi.mock("@platform-pub/shared/lib/relay-outbox.js", () => ({ enqueueRelayPublish: vi.fn() }));
vi.mock("@platform-pub/shared/lib/publish-emails.js", () => ({
  sendPublishNotifications: vi.fn(async () => undefined),
}));
vi.mock("../src/routes/drives.js", () => ({
  matchDriveForPublish: vi.fn(async () => null),
  queueDriveFulfilment: vi.fn(),
  checkAndTriggerDriveFulfilment: vi.fn(),
}));
vi.mock("../src/lib/article-event-rekey.js", () => ({ rekeyArticleEvent: vi.fn(async () => 0) }));
vi.mock("../src/lib/key-service-client.js", () => ({ keyServiceHeaders: () => ({}) }));
vi.mock("../src/services/publication-publisher.js", () => ({
  publishToPublication: vi.fn(),
  PublicationPaywallUnsupportedError: class extends Error {},
  PublicationsSuspendedError: class extends Error {},
}));
vi.mock("../src/middleware/auth.js", () => ({
  requireAuth: async (req: { session?: { sub: string } }) => {
    req.session = { sub: WRITER };
  },
  optionalAuth: async () => undefined,
}));

import { draftRoutes } from "../src/routes/drafts.js";
import {
  publishPersonalArticle,
  ArticleUnpublishableError,
} from "../src/services/article-publisher.js";
import { WRITER_TERMS_VERSION } from "@platform-pub/shared/lib/terms-versions.js";

beforeEach(() => {
  draft = { ...FREE };
  authorAdmitted = true;
  writerVersion = null;
  calls = [];
  signEvent.mockClear();
  logged.warn.mockReset();
  logged.error.mockReset();
});

// -----------------------------------------------------------------------------
// 1. The route
// -----------------------------------------------------------------------------

describe("POST /drafts/:id/schedule — refused at the gesture, nothing written", () => {
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

  const cases: Array<[string, Partial<DraftRow>, string]> = [
    ["no title", { title: "  " }, "title_required"],
    ["nothing to publish", { content_raw: "   " }, "content_required"],
    ["a gate with nothing behind it", { content_raw: `Free.\n\n${MARKER}\n\n`, price_pence: 40 }, "paywall_empty"],
    // THE finding: the paid half would have been published free.
    ["a gate with no price", { ...PAID, price_pence: 0 }, "paywall_price"],
    ["a gate with a null price", { ...PAID, price_pence: null }, "paywall_price"],
    // The vault refuses these AFTER the first transaction has committed.
    ["a gate at 0%", { ...PAID, gate_position_pct: 0 }, "paywall_gate"],
    ["a gate at 100%", { ...PAID, gate_position_pct: 100 }, "paywall_gate"],
    ["a gate with no position", { ...PAID, gate_position_pct: null }, "paywall_gate"],
  ];
  for (const [what, over, code] of cases) {
    it(`${what}: 400 ${code}, and the draft is not scheduled`, async () => {
      draft = { ...FREE, ...over };
      const res = await schedule();
      expect(res.statusCode).toBe(400);
      expect(res.json().error).toBe(code);
      expect(typeof res.json().message).toBe("string");
      expect(ran("UPDATE article_drafts")).toHaveLength(0);
      // Refused before the agreement is even asked.
      expect(ran("writer_terms_version")).toHaveLength(0);
    });
  }

  it("CONTROL: a well-formed paid draft under an accepted agreement schedules", async () => {
    draft = { ...PAID };
    writerVersion = WRITER_TERMS_VERSION;
    const res = await schedule();
    expect(res.statusCode).toBe(200);
    expect(ran("UPDATE article_drafts")).toHaveLength(1);
  });

  it("CONTROL: a free draft schedules, and is never asked for the agreement", async () => {
    const res = await schedule();
    expect(res.statusCode).toBe(200);
    expect(ran("UPDATE article_drafts")).toHaveLength(1);
    expect(ran("writer_terms_version")).toHaveLength(0);
  });

  it("the agreement is still asked, AFTER the piece has passed", async () => {
    draft = { ...PAID };
    const res = await schedule();
    expect(res.statusCode).toBe(403);
    expect(res.json().error).toBe("writer_terms_required");
    expect(ran("UPDATE article_drafts")).toHaveLength(0);
  });
});

// -----------------------------------------------------------------------------
// 2. The publisher's typed backstop
// -----------------------------------------------------------------------------

describe("publishPersonalArticle — the typed refusal, before signing and before the first transaction", () => {
  const input = (over: Partial<DraftRow>) => {
    const d = { ...FREE, ...over };
    return {
      writerId: d.writer_id,
      title: d.title ?? "",
      dek: d.dek,
      contentRaw: d.content_raw ?? "",
      nostrDTag: d.nostr_d_tag,
      gatePositionPct: d.gate_position_pct,
      pricePence: d.price_pence,
      coverImageUrl: d.cover_image_url,
      commentsEnabled: d.comments_enabled,
    };
  };
  const opts = { sendEmail: false, matchDrives: false };

  const cases: Array<[string, Partial<DraftRow>, string]> = [
    ["a gate with no price (the free-publish case)", { ...PAID, price_pence: 0 }, "paywall_price"],
    ["a gate at a position the vault refuses", { ...PAID, gate_position_pct: 0 }, "paywall_gate"],
    ["a gate with nothing behind it", { content_raw: `Free.\n\n${MARKER}\n\n`, price_pence: 40 }, "paywall_empty"],
    ["no title", { title: "" }, "title_required"],
    ["nothing to publish", { content_raw: " " }, "content_required"],
  ];
  for (const [what, over, code] of cases) {
    it(`${what}: throws ArticleUnpublishableError(${code}), signs nothing, writes nothing`, async () => {
      writerVersion = WRITER_TERMS_VERSION;
      const err = await publishPersonalArticle(input(over), opts).catch((e: unknown) => e);
      expect(err).toBeInstanceOf(ArticleUnpublishableError);
      expect((err as ArticleUnpublishableError).code).toBe(code);
      // BEFORE the sign and BEFORE the first transaction: after that
      // transaction the row is committed, and for the price-0 case it is the
      // whole body, access_mode 'public'.
      expect(signEvent).not.toHaveBeenCalled();
      expect(ran("INSERT INTO articles")).toHaveLength(0);
      expect(ran("INSERT INTO feed_items")).toHaveLength(0);
    });
  }

  it("CONTROL: a free piece publishes, and is never asked the agreement", async () => {
    const result = await publishPersonalArticle(input({}), opts);
    expect(result.articleId).toBe("00000000-0000-4000-8000-0000000000c1");
    expect(signEvent).toHaveBeenCalledTimes(1);
    expect(ran("INSERT INTO articles")).toHaveLength(1);
    expect(ran("writer_terms_version")).toHaveLength(0);
  });

  it("CONTROL: a well-formed paid piece gets as far as the agreement question", async () => {
    // Refused there (no acceptance), which proves the piece itself passed.
    const err = await publishPersonalArticle(input(PAID), opts).catch((e: unknown) => e);
    expect(err).not.toBeInstanceOf(ArticleUnpublishableError);
    expect((err as Error).name).toBe("WriterTermsRequiredError");
    expect(ran("writer_terms_version")).toHaveLength(1);
  });
});

// -----------------------------------------------------------------------------
// 3. The scheduler: disposition, and the d-tag stamped on claim
//
// The REAL publisher runs here, over the scripted pool, so what is proved is
// the pair together: the publisher's typed throw and the scheduler's answer to
// it. A transient fault is a `signEvent` rejection (key-custody down).
// -----------------------------------------------------------------------------

describe("publishScheduledDrafts — un-schedules on the type, stamps the d-tag before the publish", () => {
  beforeEach(() => {
    writerVersion = WRITER_TERMS_VERSION;
    draft = { ...FREE, scheduled_at: "2000-01-01T00:00:00Z" };
    staleClaim = null;
  });

  async function run() {
    const { publishScheduledDrafts } = await import("../src/workers/scheduler.js");
    await publishScheduledDrafts();
  }

  /** The tag the publisher wrote: $3 of its articles INSERT. */
  const publishedTag = (n = 0) => ran("INSERT INTO articles")[n]?.params[2];

  it("a typed refusal: scheduled_at cleared, draft kept, no retry, nothing signed", async () => {
    draft = { ...PAID, price_pence: 0, scheduled_at: "2000-01-01T00:00:00Z" };
    await run();
    expect(ran("SET scheduled_at = NULL")).toHaveLength(1);
    expect(ran("SET scheduled_at = now() WHERE")).toHaveLength(0);
    expect(ran("DELETE FROM article_drafts")).toHaveLength(0);
    expect(signEvent).not.toHaveBeenCalled();
    expect(ran("INSERT INTO articles")).toHaveLength(0);
    const [entry] = logged.warn.mock.calls[0];
    expect(entry).toMatchObject({ draftId: DRAFT, refusal: "paywall_price" });
  });

  it("a draft whose author is not a writer: un-scheduled like any typed refusal, nothing signed", async () => {
    // A reader holding a draft from before the gate (READER-WRITER-SPLIT-ADR):
    // only a grant clears it, so retrying every minute would log for ever.
    authorAdmitted = false;
    draft = { ...draft, scheduled_at: "2000-01-01T00:00:00Z" };
    await run();
    expect(ran("SET scheduled_at = NULL")).toHaveLength(1);
    expect(ran("SET scheduled_at = now() WHERE")).toHaveLength(0);
    expect(ran("DELETE FROM article_drafts")).toHaveLength(0);
    expect(signEvent).not.toHaveBeenCalled();
    expect(ran("INSERT INTO articles")).toHaveLength(0);
  });

  it("CONTROL: a transient fault restores scheduled_at for the next cycle", async () => {
    signEvent.mockRejectedValueOnce(new Error("key-custody down"));
    await run();
    expect(ran("SET scheduled_at = now() WHERE")).toHaveLength(1);
    expect(ran("SET scheduled_at = NULL")).toHaveLength(0);
    expect(ran("DELETE FROM article_drafts")).toHaveLength(0);
  });

  it("a never-published draft is stamped with a d-tag BEFORE the publish, and the publish uses it", async () => {
    await run();
    const [stamp] = ran("SET nostr_d_tag = COALESCE(nostr_d_tag, $2)");
    expect(stamp).toBeDefined();
    expect(stamp.params[0]).toBe(DRAFT);
    const minted = stamp.params[1] as string;
    expect(minted).toMatch(/^a-piece-[0-9a-z]+$/);
    // Ordering: the stamp precedes the publisher's first write.
    const stampIndex = calls.indexOf(stamp);
    const insertIndex = calls.indexOf(ran("INSERT INTO articles")[0]);
    expect(stampIndex).toBeLessThan(insertIndex);
    expect(publishedTag()).toBe(minted);
    expect(ran("DELETE FROM article_drafts")).toHaveLength(1);
  });

  it("the stamp lands in the SAME cycle a transient failure happens in, so the retry converges on one piece", async () => {
    // Cycle 1: stamped, then key-custody fails.
    signEvent.mockRejectedValueOnce(new Error("key-custody down"));
    await run();
    const minted = draft.nostr_d_tag;
    expect(minted).toMatch(/^a-piece-/);
    expect(ran("INSERT INTO articles")).toHaveLength(0);
    // Cycle 2: the claim returns the stamped row; no second mint, and the
    // publisher writes under the SAME tag — the upsert on (writer, d-tag)
    // is what makes this one piece rather than one per minute.
    calls = [];
    await run();
    expect(ran("SET nostr_d_tag = COALESCE")).toHaveLength(0);
    expect(publishedTag()).toBe(minted);
  });

  it("a draft that already carries a tag (an edit) is not re-stamped, and the tag passes through", async () => {
    draft = { ...draft, nostr_d_tag: "existing-tag" };
    await run();
    expect(ran("SET nostr_d_tag = COALESCE")).toHaveLength(0);
    expect(publishedTag()).toBe("existing-tag");
  });

  it("a tag the draft gained between the claim and the stamp wins over the mint (COALESCE)", async () => {
    staleClaim = { ...draft, nostr_d_tag: null };
    draft = { ...draft, nostr_d_tag: "saved-meanwhile" };
    await run();
    expect(ran("SET nostr_d_tag = COALESCE")).toHaveLength(1);
    expect(publishedTag()).toBe("saved-meanwhile");
  });
});
