import {
  describe,
  it,
  expect,
  beforeAll,
  afterAll,
  beforeEach,
  afterEach,
  vi,
} from "vitest";
import pg from "pg";

// =============================================================================
// The scheduler, against Postgres: a refused draft writes NOTHING, and a
// retried one converges on ONE piece (CA-A1, 2026-09-29).
//
// Two things a mocked pool cannot prove. (1) "Refused BEFORE the first
// transaction" is a claim about what was COMMITTED — the paid half of a gated
// draft with no price was published free, and a gate the vault refuses was
// committed as a `paywalled` row with no vault, both by a transaction that
// had already closed when the refusal came. (2) "A retry is an edit of the
// same piece" is a claim about the articles upsert's conflict target: the
// scheduler handed the publisher the draft's NULL d-tag, `generateDTag`
// appends a timestamp, and a publish that failed after its first transaction
// (the vault call) left a NEW `articles` + `feed_items` row per minute for as
// long as the retry ran. Only the real upsert says whether the stamp closed it.
//
// The scheduler runs FOR REAL over the shared pool with the real publisher;
// key-custody is a mock that signs with a fresh id every call (as the real one
// does), and the key service is `fetch` answering 503 — the transient failure
// that sits after the first transaction. Fixtures COMMIT and are cleaned up in
// afterEach, keyed on the fixture account.
//
// MUTATION LOG (each applied to src/, the suite re-run, reverted):
//   A. drop the `publishRefusal` throw from `publishPersonalArticle`
//      ⇒ "a gate over no price" fails: one PUBLIC row holding the whole
//        body; "a gate the vault refuses" fails: one paywalled row, no
//        vault, and the draft still scheduled.                        DETECTED
//   B. move that throw to AFTER the first transaction
//      ⇒ the same two fail the same way — the row is already committed
//        when the refusal comes.                                      DETECTED
//   C. drop `stampDTag` (pass `draft.nostr_d_tag` again)
//      ⇒ "a retried publish converges" fails: two articles rows, two
//        cards, after two cycles.                                     DETECTED
//   D. drop `ArticleUnpublishableError` from the scheduler's permanent
//      branch ⇒ "a gate over no price" fails: `scheduled_at` restored,
//        the draft still due.                                         DETECTED
//
// Skipped without a DB URL — CI supplies one and FAILS on a skip. Locally, BOTH
// vars (the fixtures use their own client; the code under test uses the shared
// pool, which reads DATABASE_URL):
//   DATABASE_URL=postgresql://platformpub:PASSWORD@localhost:5432/platformpub \
//   TEST_DATABASE_URL=$DATABASE_URL npx vitest run tests/scheduler-claim.test.ts
//
// A NOTE ON THE RUNNING STACK: the scheduler claims EVERY due draft in the
// database, so this suite runs the same claim the dev gateway runs once a
// minute. The fixture is inserted and claimed within milliseconds, so the dev
// scheduler losing the race to it is the expected case; if it ever wins, the
// fixture writer has no custodial key and the real publish fails cleanly.
// =============================================================================

const DB_URL = process.env.TEST_DATABASE_URL ?? process.env.DATABASE_URL;

process.env.KEY_SERVICE_URL ??= "http://key-service.test";
process.env.PAYMENT_SERVICE_URL ??= "http://payment-service.test";
process.env.READER_HASH_KEY ??= "a".repeat(64);
process.env.INTERNAL_SERVICE_TOKEN ??= "test-token";
process.env.INTERNAL_SECRET ??= "b".repeat(64);

const randHex = (n = 32) =>
  Array.from({ length: n }, () =>
    Math.floor(Math.random() * 256)
      .toString(16)
      .padStart(2, "0"),
  ).join("");

// Key-custody: a fresh id per signature, as the real signer gives.
const signEvent = vi.fn(
  async (
    _writerId: string,
    ev: { kind: number; content: string; tags: string[][]; created_at: number },
  ) => ({
    ...ev,
    id: randHex(),
    pubkey: randHex(),
    sig: randHex(64),
  }),
);
vi.mock("../src/lib/key-custody-client.js", () => ({
  signEvent: (...a: unknown[]) => signEvent(...(a as [string, never])),
  generateKeypair: vi.fn(),
}));
vi.mock("@platform-pub/shared/lib/publish-emails.js", () => ({
  sendPublishNotifications: vi.fn(async () => undefined),
}));
vi.mock("../src/routes/drives.js", () => ({
  matchDriveForPublish: vi.fn(async () => null),
  queueDriveFulfilment: vi.fn(),
  checkAndTriggerDriveFulfilment: vi.fn(async () => undefined),
}));
vi.mock("../src/services/publication-publisher.js", () => ({
  publishToPublication: vi.fn(),
  PublicationPaywallUnsupportedError: class extends Error {},
  PublicationsSuspendedError: class extends Error {},
}));

// The key service's vault call: down. The one failure that sits AFTER the
// publisher's first transaction.
const fetchMock = vi.fn(async () => ({
  ok: false,
  status: 503,
  json: async () => ({ error: "key service down" }),
}));
vi.stubGlobal("fetch", fetchMock);

const { publishScheduledDrafts } = await import("../src/workers/scheduler.js");
const { pool } = await import("@platform-pub/shared/db/client.js");
const { WRITER_TERMS_VERSION } = await import(
  "@platform-pub/shared/lib/terms-versions.js"
);

const MARKER = "<!-- paywall-gate -->";

describe.skipIf(!DB_URL)("the scheduler against Postgres", () => {
  let client: pg.Client;
  let writer: string;

  beforeAll(async () => {
    client = new pg.Client({ connectionString: DB_URL });
    await client.connect();
  });
  afterAll(async () => {
    await client.end();
    await pool.end();
  });

  beforeEach(async () => {
    signEvent.mockClear();
    fetchMock.mockClear();
    const { rows } = await client.query<{ id: string }>(
      `INSERT INTO accounts
         (username, display_name, nostr_pubkey, writer_terms_version, writer_terms_accepted_at,
          writer_admitted_at)
       VALUES ($1, 'Scheduled writer', $2, $3, now(), now()) RETURNING id`,
      [`sched-${randHex(6)}`, randHex(), WRITER_TERMS_VERSION],
    );
    writer = rows[0].id;
  });

  afterEach(async () => {
    // Outbox rows and their worker jobs first (no FK, keyed on the article),
    // then the articles (cards cascade), the drafts, the account.
    const { rows: outbox } = await client.query<{ id: string }>(
      `SELECT ro.id FROM relay_outbox ro
        JOIN articles a ON a.id = ro.entity_id WHERE a.writer_id = $1`,
      [writer],
    );
    for (const { id } of outbox) {
      await client.query(`SELECT graphile_worker.remove_job($1)`, [
        `relay_publish_${id}`,
      ]);
      await client.query(`DELETE FROM relay_outbox WHERE id = $1`, [id]);
    }
    await client.query(`DELETE FROM articles WHERE writer_id = $1`, [writer]);
    await client.query(`DELETE FROM article_drafts WHERE writer_id = $1`, [
      writer,
    ]);
    await client.query(`DELETE FROM accounts WHERE id = $1`, [writer]);
  });

  // --- fixtures -------------------------------------------------------------

  async function dueDraft(over: {
    content_raw: string;
    price_pence: number | null;
    gate_position_pct: number | null;
  }): Promise<string> {
    const { rows } = await client.query<{ id: string }>(
      `INSERT INTO article_drafts
         (writer_id, title, content_raw, price_pence, gate_position_pct,
          comments_enabled, scheduled_at)
       VALUES ($1, 'A scheduled piece', $2, $3, $4, TRUE, now() - interval '1 second')
       RETURNING id`,
      [writer, over.content_raw, over.price_pence, over.gate_position_pct],
    );
    return rows[0].id;
  }

  async function articles() {
    const { rows } = await client.query<{
      access_mode: string;
      content_free: string;
      nostr_d_tag: string;
    }>(
      `SELECT access_mode, content_free, nostr_d_tag FROM articles
        WHERE writer_id = $1 ORDER BY created_at`,
      [writer],
    );
    return rows;
  }
  async function cards() {
    const { rows } = await client.query<{ n: string }>(
      `SELECT count(*)::text AS n FROM feed_items WHERE author_id = $1`,
      [writer],
    );
    return Number(rows[0].n);
  }
  async function draft(id: string) {
    const { rows } = await client.query<{
      scheduled_at: Date | null;
      content_raw: string;
      nostr_d_tag: string | null;
      due: boolean;
    }>(
      `SELECT scheduled_at, content_raw, nostr_d_tag,
              (scheduled_at IS NOT NULL AND scheduled_at <= now()) AS due
         FROM article_drafts WHERE id = $1`,
      [id],
    );
    return rows[0] ?? null;
  }

  const PAID_BODY = `The free run.\n\n${MARKER}\n\nThe paid run.`;

  // --- the refusals: nothing committed -------------------------------------

  it("a gate over no price: nothing signed, nothing committed, the draft un-scheduled and intact", async () => {
    // Before the fix this draft was read as a FREE piece and its whole body,
    // paid run included, was committed `public` and enqueued to the relay.
    const id = await dueDraft({
      content_raw: PAID_BODY,
      price_pence: 0,
      gate_position_pct: 50,
    });
    await publishScheduledDrafts();

    expect(await articles()).toEqual([]);
    expect(await cards()).toBe(0);
    expect(signEvent).not.toHaveBeenCalled();
    const d = await draft(id);
    expect(d).not.toBeNull();
    expect(d!.scheduled_at).toBeNull();
    expect(d!.content_raw).toBe(PAID_BODY);
  });

  it("a gate the vault refuses: nothing committed (it used to commit a paywalled row with no vault)", async () => {
    const id = await dueDraft({
      content_raw: PAID_BODY,
      price_pence: 40,
      gate_position_pct: 0,
    });
    await publishScheduledDrafts();

    expect(await articles()).toEqual([]);
    expect(await cards()).toBe(0);
    expect(fetchMock).not.toHaveBeenCalled();
    const d = await draft(id);
    expect(d!.scheduled_at).toBeNull();
    expect(d!.due).toBe(false);
  });

  // --- the retry: one piece ------------------------------------------------

  it("a retried publish converges on ONE piece: the d-tag is stamped on the draft in the failing cycle", async () => {
    const id = await dueDraft({
      content_raw: PAID_BODY,
      price_pence: 40,
      gate_position_pct: 30,
    });

    // Cycle 1: first transaction commits, the vault call fails, the draft is
    // restored for retry — and now carries the tag the row was written under.
    await publishScheduledDrafts();
    let rows = await articles();
    expect(rows).toHaveLength(1);
    expect(rows[0].access_mode).toBe("paywalled");
    expect(rows[0].content_free).toBe("The free run.");
    expect(fetchMock).toHaveBeenCalledTimes(1);
    let d = await draft(id);
    expect(d).not.toBeNull();
    expect(d!.due).toBe(true);
    expect(d!.nostr_d_tag).toBe(rows[0].nostr_d_tag);

    // Cycle 2 (what the next minute does): the same tag, so the upsert lands
    // on the same row. Before the stamp this was a second row, and a third
    // the minute after.
    await publishScheduledDrafts();
    rows = await articles();
    expect(rows).toHaveLength(1);
    expect(rows[0].nostr_d_tag).toBe(d!.nostr_d_tag);
    expect(await cards()).toBe(1);
    expect(signEvent).toHaveBeenCalledTimes(2);
    d = await draft(id);
    expect(d!.due).toBe(true);
  });

  // --- the control -----------------------------------------------------------

  it("CONTROL: a free draft publishes, once, and the draft is deleted", async () => {
    const id = await dueDraft({
      content_raw: "Just a free piece.",
      price_pence: 0,
      gate_position_pct: null,
    });
    await publishScheduledDrafts();

    const rows = await articles();
    expect(rows).toHaveLength(1);
    expect(rows[0].access_mode).toBe("public");
    expect(rows[0].content_free).toBe("Just a free piece.");
    expect(await cards()).toBe(1);
    expect(fetchMock).not.toHaveBeenCalled();
    expect(await draft(id)).toBeNull();
    const { rows: outbox } = await client.query(
      `SELECT 1 FROM relay_outbox ro JOIN articles a ON a.id = ro.entity_id
        WHERE a.writer_id = $1`,
      [writer],
    );
    expect(outbox).toHaveLength(1);
  });
});
