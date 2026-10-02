import { describe, it, expect, vi, beforeEach } from "vitest";
import Fastify from "fastify";

// =============================================================================
// The moderation record — what a report can name, and who wins a race for it
// (CONSOLIDATED-TODO L6.3 + L6.4; D1 §9.2, D7 §2/§5/§8)
//
// THREE THINGS THIS FILE EXISTS TO CATCH, all of which were live until L6.3.
//
// (1) A REPORT COULD ONLY NAME A NATIVE THING. The table held a Nostr event id
//     or an account id, so an external card — which is most of what the
//     workspace shows — had no identifier to be reported with. The first suite
//     files one report of each of the five target kinds and reads them back off
//     the admin list, because a target the schema drops is silent: the report
//     files, the queue shows "No target recorded", and it reads like the
//     reporter's mistake rather than ours.
//
// (2) THE PRIORITY IS DERIVED, NOT SENT. D7 §2's deadline is a published
//     commitment keyed on the category, so a client that could choose it could
//     choose our deadline. The filing route computes it and the test asserts
//     the DERIVATION rather than an echo — csam is P0, spam is P2 — which is
//     also what makes "reports past their deadline" a query rather than a
//     judgement.
//
// (3) TWO ADMINS RESOLVING ONE REPORT. The route used to read the status under
//     `FOR UPDATE`, write the suspension, and only then notice it had lost —
//     and `withTransaction` commits on a normal return, so the 409 it reported
//     came with the suspension committed behind it. The guard is now the
//     resolving UPDATE itself and it runs FIRST, so a loser has written nothing.
//
// THE MOCK ANSWERS FROM THE SQL IT IS HANDED. It keeps a real in-memory table
// and reads the claim's own `status NOT IN (…)` out of the query string, so a
// route that dropped the guard fails here rather than passing against a
// fixture. And the concurrency test FORCES its interleaving: left to the event
// loop the first request runs to completion before the second issues a query,
// so a route with no claim at all would pass.
//
// Mutation-checked, and the notes are on each test.
// =============================================================================

process.env.APP_URL ??= "https://all.haus.test";

interface ReportRow {
  id: string;
  reporter_id: string | null;
  target_nostr_event_id: string | null;
  target_account_id: string | null;
  target_post_id: string | null;
  target_conversation_id: string | null;
  target_profile_id: string | null;
  category: string;
  priority: string | null;
  notes: string | null;
  snapshot: unknown;
  status: string;
  action: string | null;
  reason: string | null;
  reasoning: string | null;
  subject_account_id: string | null;
  appeal_deadline: Date | null;
  appealed_at: Date | null;
  appeal_text: string | null;
  appeal_outcome: string | null;
  appeal_reasoning: string | null;
  appeal_decided_at: Date | null;
  created_at: Date;
  triaged_at: Date | null;
  reviewed_at: Date | null;
  priority_raised_at: Date | null;
  priority_raised_by: string | null;
  priority_raise_reason: string | null;
  reviewed_by: string | null;
}

interface CommentRow {
  id: string;
  nostr_event_id: string | null;
  author_id: string;
  deleted_at: Date | null;
  /** `feed_items.deleted_at` for this reply's card, kept beside it. */
  card_deleted_at: Date | null;
}

let comments: CommentRow[] = [];
let reports: ReportRow[] = [];
let accountStatus = new Map<string, { status: string; suspended_until: Date | null }>();
let conversationMembers: Array<{ conversation_id: string; user_id: string }> = [];
/** The `accounts` rows that exist, for the filing route's existence check. */
let existingAccounts = new Set<string>();
let adminAllowed = true;
let sessionSub = "admin-id";
/** Set by the concurrency test; see the pre-read branch in `query`. */
let selectBarrier: (() => Promise<void>) | null = null;

/** Hold the first `n` report pre-reads until all `n` have arrived, then let go. */
function holdReadsUntil(n: number) {
  let arrived = 0;
  let open!: () => void;
  const gate = new Promise<void>((r) => (open = r));
  selectBarrier = () => {
    if (++arrived >= n) open();
    return gate;
  };
}

const sendModerationNoticeEmail = vi.fn(async () => ({ sent: 1, skipped: 0 }));
const claimStepUpToken = vi.fn(async () => true);
const txOutcomes: Array<"commit" | "rollback"> = [];
const requestStepUpToken = vi.fn(async () => ({
  token: "appeal-token",
  expiresAt: new Date(),
}));

let nextId = 0;

/** Report ids are UUIDs, because the routes refuse a path id that is not one
 *  (`isUuid` — a malformed id answers 404, never a 400 or a Postgres 500). A
 *  fixture spelled "r1" therefore tests the guard and nothing past it. */
function reportId(n: number): string {
  return `aaaaaaaa-0000-4000-8000-${String(n).padStart(12, "0")}`;
}

function query(sql: string, params: unknown[] = []): Promise<any> {
  // --- filing ----------------------------------------------------------------
  if (/INSERT INTO moderation_reports/.test(sql) && /RETURNING id, created_at/.test(sql)) {
    const row: ReportRow = {
      id: reportId(++nextId),
      reporter_id: params[0] as string,
      target_nostr_event_id: params[1] as string | null,
      target_account_id: params[2] as string | null,
      target_post_id: params[3] as string | null,
      target_conversation_id: params[4] as string | null,
      target_profile_id: params[5] as string | null,
      category: params[6] as string,
      notes: params[7] as string | null,
      priority: params[8] as string,
      snapshot: params[9],
      status: "open",
      action: null,
      reason: null,
      reasoning: null,
      subject_account_id: null,
      appeal_deadline: null,
      appealed_at: null,
      appeal_text: null,
      appeal_outcome: null,
      appeal_reasoning: null,
      appeal_decided_at: null,
      created_at: new Date("2026-09-17T09:00:00Z"),
      triaged_at: null,
      reviewed_at: null,
      reviewed_by: null,
      priority_raised_at: null,
      priority_raised_by: null,
      priority_raise_reason: null,
    };
    reports.push(row);
    return Promise.resolve({
      rows: [{ id: row.id, created_at: row.created_at }],
      rowCount: 1,
    });
  }

  if (/FROM conversation_members/.test(sql)) {
    const hit = conversationMembers.some(
      (m) => m.conversation_id === params[0] && m.user_id === params[1],
    );
    return Promise.resolve({ rows: hit ? [{ "?column?": 1 }] : [], rowCount: hit ? 1 : 0 });
  }

  // --- what a report resolves to (§0z item 6) ---------------------------------
  // The resolver's timeline read, answered from the post id it is handed: a
  // native note by UUID_A, an external item, or nothing. The external item is
  // UNCLAIMED (claimant_id NULL); a member's claimed post elsewhere resolving
  // to them is Postgres's to evaluate and is pinned DB-backed, in
  // presence-identity-claim.test.ts.
  if (/SELECT fi\.item_type, fi\.author_id, fi\.nostr_event_id/.test(sql)) {
    if (params[0] === NATIVE_POST) {
      return Promise.resolve({
        rows: [{ item_type: "note", author_id: UUID_A, nostr_event_id: NATIVE_EVENT }],
        rowCount: 1,
      });
    }
    if (params[0] === COMMENT_POST) {
      return Promise.resolve({
        rows: [{ item_type: "comment", author_id: UUID_A, nostr_event_id: COMMENT_EVENT }],
        rowCount: 1,
      });
    }
    if (params[0] === "external-post") {
      return Promise.resolve({
        rows: [{ item_type: "external", author_id: null, nostr_event_id: null, claimant_id: null }],
        rowCount: 1,
      });
    }
    return Promise.resolve({ rows: [], rowCount: 0 });
  }
  // "Whose event is this?" — the content tables by event id. Before the
  // snapshot branch below, which the same FROM clause would otherwise match.
  if (/SELECT writer_id AS account_id FROM articles/.test(sql)) {
    return params[0] === NATIVE_EVENT
      ? Promise.resolve({ rows: [{ account_id: UUID_A }], rowCount: 1 })
      : Promise.resolve({ rows: [], rowCount: 0 });
  }

  // The snapshot capture. Deliberately answers NOTHING — the capture is
  // best-effort and a report must file whether or not we could describe what
  // was reported, which is what the `{captured:false}` branch is for.
  if (/FROM feed_items WHERE post_id/.test(sql)) {
    return Promise.resolve({ rows: [], rowCount: 0 });
  }
  if (/FROM articles WHERE nostr_event_id/.test(sql)) {
    return Promise.resolve({ rows: [], rowCount: 0 });
  }
  // The filing route's existence check answers from its PARAM — the ids it
  // was handed — against the set of accounts that exist.
  if (/SELECT id FROM accounts WHERE id = ANY\(\$1::uuid\[\]\)/.test(sql)) {
    const ids = params[0] as string[];
    const rows = ids.filter((id) => existingAccounts.has(id)).map((id) => ({ id }));
    return Promise.resolve({ rows, rowCount: rows.length });
  }
  if (/SELECT username, display_name, bio FROM accounts/.test(sql)) {
    return Promise.resolve({ rows: [], rowCount: 0 });
  }

  // --- the queue -------------------------------------------------------------
  if (/FROM moderation_reports r/.test(sql)) {
    const showAll = !/status IN \('open', 'under_review'\)\n/.test(sql)
      ? true
      : false;
    const rows = reports
      .filter((r) =>
        /AND r\.status IN \('open', 'under_review'\)/.test(sql)
          ? r.status === "open" || r.status === "under_review"
          : true,
      )
      .map((r) => ({
        ...r,
        reporter_username: null,
        target_account_username: null,
        target_profile_username: null,
        subject_username: null,
        priority_raised_by_username: r.priority_raised_by,
      }));
    void showAll;
    return Promise.resolve({ rows, rowCount: rows.length });
  }
  if (/COUNT\(\*\) FILTER/.test(sql) && /FROM moderation_reports/.test(sql)) {
    return Promise.resolve({
      rows: [{ open: String(reports.filter((r) => r.status === "open").length), overdue: "0", appeals: "0" }],
      rowCount: 1,
    });
  }

  // --- the pre-read the resolution takes before its transaction --------------
  if (/SELECT id, target_nostr_event_id, target_account_id, target_post_id/.test(sql)) {
    const read = () => {
      const r = reports.find((x) => x.id === params[0]);
      // A COPY, never the live row: shared identity lets one request observe
      // another's writes, which is how a losing racer comes to read as a
      // resend rather than a refused claim.
      return { rows: r ? [{ ...r }] : [], rowCount: r ? 1 : 0 };
    };
    const snapshot = read();
    return selectBarrier
      ? selectBarrier().then(() => snapshot)
      : Promise.resolve(snapshot);
  }

  // --- the claim -------------------------------------------------------------
  if (/UPDATE moderation_reports/.test(sql) && /RETURNING id/.test(sql) && /SET status = \$1::report_status/.test(sql)) {
    const r = reports.find((x) => x.id === params[2]);
    if (!r) return Promise.resolve({ rows: [], rowCount: 0 });
    // The guard is READ OUT OF THE SQL. Drop it from the route and this mock
    // happily resolves the same report twice, which is what the race test
    // then catches.
    if (
      /status NOT IN \('resolved_removed', 'resolved_no_action', 'resolved_actioned'\)/.test(sql) &&
      ["resolved_removed", "resolved_no_action", "resolved_actioned"].includes(r.status)
    ) {
      return Promise.resolve({ rows: [], rowCount: 0 });
    }
    r.status = params[0] as string;
    r.reviewed_by = params[1] as string;
    // DISTINCT, ASCENDING. Two decisions resolved in the same millisecond are
    // unordered, and the appeal lift below asks which came LATER — a fixture
    // that cannot tell them apart would make that guard untestable (and, worse,
    // pass it by accident). Postgres's `now()` is transaction time and two
    // resolves are two transactions, so this models the real thing.
    r.reviewed_at = new Date(REVIEW_EPOCH + reviewSeq++);
    r.triaged_at = r.triaged_at ?? new Date();
    r.action = params[3] as string;
    r.reason = params[4] as string;
    r.reasoning = params[5] as string;
    r.subject_account_id = params[6] as string | null;
    r.appeal_deadline = params[7] as Date | null;
    return Promise.resolve({ rows: [{ id: r.id }], rowCount: 1 });
  }

  if (/SELECT status::text AS status, priority FROM moderation_reports/.test(sql)) {
    const r = reports.find((x) => x.id === params[0]);
    return Promise.resolve({
      rows: r ? [{ status: r.status, priority: r.priority }] : [],
      rowCount: r ? 1 : 0,
    });
  }
  if (/SELECT status::text AS status FROM moderation_reports/.test(sql)) {
    const r = reports.find((x) => x.id === params[0]);
    return Promise.resolve({ rows: r ? [{ status: r.status }] : [], rowCount: r ? 1 : 0 });
  }

  // --- the priority raise (§0z item 8) ----------------------------------------
  // Both guards are READ OUT OF THE SQL: drop the status test or the direction
  // test from the route and this mock raises a resolved report, or lowers one.
  if (/UPDATE moderation_reports/.test(sql) && /SET priority = \$2/.test(sql)) {
    const r = reports.find((x) => x.id === params[0]);
    if (!r) return Promise.resolve({ rows: [], rowCount: 0 });
    const next = params[1] as string;
    if (
      /status IN \('open', 'under_review'\)/.test(sql) &&
      !(r.status === "open" || r.status === "under_review")
    ) {
      return Promise.resolve({ rows: [], rowCount: 0 });
    }
    if (/priority IS NULL OR priority > \$2/.test(sql) && !(r.priority === null || r.priority > next)) {
      return Promise.resolve({ rows: [], rowCount: 0 });
    }
    r.priority = next;
    r.priority_raised_at = new Date();
    r.priority_raised_by = params[2] as string;
    r.priority_raise_reason = params[3] as string;
    return Promise.resolve({ rows: [{ id: r.id, created_at: r.created_at }], rowCount: 1 });
  }

  // The standing-decision pre-read (§0z item 14): status + timer.
  if (/SELECT status::text AS status, suspended_until FROM accounts/.test(sql)) {
    const cur = accountStatus.get(params[0] as string);
    return Promise.resolve({
      rows: [{ status: cur?.status ?? "active", suspended_until: cur?.suspended_until ?? null }],
      rowCount: 1,
    });
  }

  // --- filing an appeal (§0ab guard (d)) --------------------------------------
  if (/SELECT subject_account_id FROM moderation_reports WHERE id = \$1/.test(sql)) {
    const r = reports.find((x) => x.id === params[0]);
    return Promise.resolve({ rows: r ? [{ subject_account_id: r.subject_account_id }] : [] });
  }
  if (/UPDATE moderation_reports/.test(sql) && /SET appealed_at = now\(\), appeal_text = \$2/.test(sql)) {
    const r = reports.find((x) => x.id === params[0]);
    // The three guards the route's UPDATE carries, answered from the row.
    if (
      !r ||
      r.appealed_at !== null ||
      r.appeal_deadline === null ||
      r.appeal_deadline.getTime() <= Date.now()
    ) {
      return Promise.resolve({ rows: [], rowCount: 0 });
    }
    r.appealed_at = new Date();
    r.appeal_text = params[1] as string;
    return Promise.resolve({ rows: [], rowCount: 1 });
  }

  // --- the appeal decision (§0ab item 3) --------------------------------------
  if (/UPDATE moderation_reports/.test(sql) && /SET appeal_outcome = \$2/.test(sql)) {
    const r = reports.find((x) => x.id === params[0]);
    if (!r) return Promise.resolve({ rows: [], rowCount: 0 });
    // Both guards read out of the SQL, so a route that dropped either decides
    // an un-appealed or an already-decided appeal here exactly as in Postgres.
    if (/appealed_at IS NOT NULL/.test(sql) && r.appealed_at === null) {
      return Promise.resolve({ rows: [], rowCount: 0 });
    }
    if (/appeal_decided_at IS NULL/.test(sql) && r.appeal_decided_at !== null) {
      return Promise.resolve({ rows: [], rowCount: 0 });
    }
    r.appeal_outcome = params[1] as string;
    r.appeal_reasoning = params[2] as string;
    r.appeal_decided_at = new Date();
    return Promise.resolve({
      rows: [
        {
          subject_account_id: r.subject_account_id,
          action: r.action,
          reviewed_at: r.reviewed_at,
        },
      ],
      rowCount: 1,
    });
  }

  // --- the appeal LIFT (§0ab item 3) ------------------------------------------
  // Distinct from the ladder's write below: this one clears a status rather
  // than setting one, and BOTH of its guards are read out of the SQL. Drop
  // either from the route and this mock lifts a decision the appealed report
  // did not write, which is the bug the cases below describe.
  if (/UPDATE accounts SET status = 'active'/.test(sql)) {
    const current = accountStatus.get(params[0] as string)?.status ?? "active";
    if (/status::text = \$2/.test(sql) && current !== params[1]) {
      return Promise.resolve({ rows: [], rowCount: 0 });
    }
    if (/later\.reviewed_at > \$5/.test(sql)) {
      const actions = params[3] as string[];
      const after = params[4] as Date;
      const later = reports.some(
        (x) =>
          x.subject_account_id === params[0] &&
          x.id !== params[2] &&
          x.action !== null &&
          actions.includes(x.action) &&
          x.reviewed_at !== null &&
          x.reviewed_at > after &&
          x.appeal_outcome !== "reversed",
      );
      if (later) return Promise.resolve({ rows: [], rowCount: 0 });
    }
    accountStatus.set(params[0] as string, { status: "active", suspended_until: null });
    return Promise.resolve({ rows: [], rowCount: 1 });
  }

  // --- the account half ------------------------------------------------------
  if (/UPDATE accounts/.test(sql) && /status = \$2::account_status/.test(sql)) {
    // THE GUARD IS READ OUT OF THE SQL (§0z item 14): the allowed-from list is
    // $4, and a route that dropped `status = ANY($4…)` writes over a standing
    // decision here exactly as it would in Postgres.
    const current = accountStatus.get(params[0] as string)?.status ?? "active";
    if (/status = ANY\(\$4::account_status\[\]\)/.test(sql)) {
      const allowed = params[3] as string[];
      if (!allowed.includes(current)) return Promise.resolve({ rows: [], rowCount: 0 });
    }
    accountStatus.set(params[0] as string, {
      status: params[1] as string,
      suspended_until: params[2] as Date | null,
    });
    return Promise.resolve({ rows: [], rowCount: 1 });
  }

  // Removal prepares — one removable note (NATIVE_EVENT, by UUID_A), answered
  // from the event id handed over; every other id matches nothing, which is
  // what the matched-nothing refusal case needs.
  if (/FROM articles a JOIN accounts/.test(sql)) return Promise.resolve({ rows: [], rowCount: 0 });
  if (/FROM notes WHERE/.test(sql)) {
    return params[0] === NATIVE_EVENT
      ? Promise.resolve({
          rows: [{ id: "note-1", nostr_event_id: NATIVE_EVENT, author_id: UUID_A }],
          rowCount: 1,
        })
      : Promise.resolve({ rows: [], rowCount: 0 });
  }

  // --- the reply arm (§0ab item 4) -------------------------------------------
  // A real little table, because both prepares read it on different keys and
  // both writes are conditional on `deleted_at`. The `deleted_at IS NULL` test
  // is READ OUT OF THE SQL: a route that dropped it would remove an
  // already-removed reply here exactly as it would in Postgres, and the
  // matched-nothing refusal would stop firing.
  if (/FROM comments\s+WHERE nostr_event_id = \$1/.test(sql)) {
    const live = comments.filter(
      (c) =>
        c.nostr_event_id === params[0] &&
        (!/deleted_at IS NULL/.test(sql) || c.deleted_at === null),
    );
    return Promise.resolve({ rows: live.map((c) => ({ ...c })), rowCount: live.length });
  }
  if (/FROM comments\s+WHERE author_id = \$1/.test(sql)) {
    const live = comments.filter(
      (c) =>
        c.author_id === params[0] &&
        (!/deleted_at IS NULL/.test(sql) || c.deleted_at === null),
    );
    return Promise.resolve({ rows: live.map((c) => ({ ...c })), rowCount: live.length });
  }
  if (/UPDATE comments SET deleted_at/.test(sql)) {
    const c = comments.find((x) => x.id === params[0]);
    if (!c || (/deleted_at IS NULL/.test(sql) && c.deleted_at !== null)) {
      return Promise.resolve({ rows: [], rowCount: 0 });
    }
    c.deleted_at = new Date();
    return Promise.resolve({ rows: [], rowCount: 1 });
  }
  if (/UPDATE feed_items SET deleted_at/.test(sql) && /comment_id = \$1/.test(sql)) {
    const c = comments.find((x) => x.id === params[0]);
    if (c) c.card_deleted_at = new Date();
    return Promise.resolve({ rows: [], rowCount: c ? 1 : 0 });
  }

  return Promise.resolve({ rows: [], rowCount: 0 });
}

vi.mock("@platform-pub/shared/db/client.js", () => ({
  pool: { query: (sql: string, params?: unknown[]) => query(sql, params) },
  // A transaction that hands the callback the SAME query function. It commits
  // by doing nothing, which is exactly the behaviour the claim's ordering is
  // written against: a refusal RETURNED from inside is a commit.
  // Each outcome is recorded, because the appeal route's rule is about WHICH
  // one it reached: a refusal after the token claim must roll back (§0ab
  // guard (d)), and "returned false" is a commit here exactly as in Postgres.
  withTransaction: async (fn: (client: unknown) => Promise<unknown>) => {
    try {
      const out = await fn({ query: (sql: string, params?: unknown[]) => query(sql, params) });
      txOutcomes.push("commit");
      return out;
    } catch (err) {
      txOutcomes.push("rollback");
      throw err;
    }
  },
}));

vi.mock("@platform-pub/shared/lib/logger.js", () => ({
  default: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

vi.mock("@platform-pub/shared/lib/member-notices.js", () => ({
  sendModerationNoticeEmail: (...a: unknown[]) =>
    (sendModerationNoticeEmail as unknown as (...x: unknown[]) => unknown)(...a),
  MODERATION_NOTICE_KINDS: [],
}));

vi.mock("@platform-pub/shared/auth/magic-links.js", () => ({
  requestStepUpToken: (...a: unknown[]) =>
    (requestStepUpToken as unknown as (...x: unknown[]) => unknown)(...a),
  claimStepUpToken: (...a: unknown[]) =>
    (claimStepUpToken as unknown as (...x: unknown[]) => unknown)(...a),
}));

vi.mock("@platform-pub/shared/lib/relay-outbox.js", () => ({
  enqueueRelayPublish: vi.fn(async () => {}),
}));

vi.mock("../src/lib/key-custody-client.js", () => ({
  signEvent: vi.fn(async () => ({})),
  // The batch signer (CA-A8): positional, one signed shape per template.
  signEvents: vi.fn(async (_signer: string, templates: unknown[]) => templates.map(() => ({}))),
}));

vi.mock("../src/middleware/auth.js", () => ({
  requireAuth: (req: any, _reply: any, done: any) => {
    req.session = { sub: sessionSub };
    done();
  },
  invalidateAuthCache: vi.fn(),
}));

vi.mock("../src/middleware/admin.js", () => ({
  requireAdmin: (req: any, reply: any, done: any) => {
    if (!adminAllowed) return reply.status(403).send({ error: "forbidden" });
    req.session = { sub: "admin-id" };
    done();
  },
  getAdminIds: () => Promise.resolve(["admin-id"]),
}));

const { moderationRoutes } = await import("../src/routes/moderation.js");

async function build() {
  const app = Fastify({ logger: false });
  await app.register(moderationRoutes);
  return app;
}

function file(app: any, body: Record<string, unknown>) {
  return app.inject({ method: "POST", url: "/reports", payload: body });
}

function resolve(app: any, id: string, body: Record<string, unknown>) {
  return app.inject({ method: "PATCH", url: `/admin/reports/${id}`, payload: body });
}

function decideAppeal(app: any, id: string, body: Record<string, unknown>) {
  return app.inject({ method: "PATCH", url: `/admin/reports/${id}/appeal`, payload: body });
}

/** A fixed base plus a counter: see the claim arm's note on ordering. */
const REVIEW_EPOCH = Date.parse("2026-09-18T00:00:00Z");
let reviewSeq = 0;

const R1 = reportId(1);
const R2 = reportId(2);

const UUID_A = "11111111-1111-4111-8111-111111111111";
const UUID_B = "22222222-2222-4222-8222-222222222222";
const UUID_C = "33333333-3333-4333-8333-333333333333";
/** A native note's post id and the event it was published under. */
const NATIVE_POST = "native-post";
const NATIVE_EVENT = "e".repeat(64);
/**
 * A native REPLY's post id and event — a card with its own `feed_items` row
 * since migration 232, which is what makes it reportable and is why the
 * content rung has to know about it (§0ab item 4).
 */
const COMMENT_POST = "comment-post";
const COMMENT_EVENT = "c".repeat(64);
/** What an external card's `version` is: a content hash, event-shaped. */
const EXTERNAL_VERSION_HASH = "a".repeat(64);

beforeEach(() => {
  reports = [];
  accountStatus = new Map();
  conversationMembers = [{ conversation_id: UUID_C, user_id: "reporter-id" }];
  existingAccounts = new Set([UUID_A, UUID_B]);
  adminAllowed = true;
  sessionSub = "reporter-id";
  selectBarrier = null;
  nextId = 0;
  reviewSeq = 0;
  comments = [
    { id: "cmt-1", nostr_event_id: COMMENT_EVENT, author_id: UUID_A, deleted_at: null, card_deleted_at: null },
  ];
  sendModerationNoticeEmail.mockClear();
  requestStepUpToken.mockClear();
  claimStepUpToken.mockClear();
  txOutcomes.length = 0;
});

describe("what a report can name (L6.3)", () => {
  it("files one report of each target kind, and the queue shows all five", async () => {
    const app = await build();

    const filed = [
      { targetNostrEventId: "e".repeat(64), category: "harassment" },
      { targetPostId: "post-abc", category: "hate" },
      { targetAccountId: UUID_A, category: "spam" },
      { targetProfileId: UUID_B, category: "other" },
      { targetConversationId: UUID_C, category: "cyberflashing" },
    ];
    for (const body of filed) {
      const res = await file(app, body);
      expect(res.statusCode, JSON.stringify(body)).toBe(201);
    }

    sessionSub = "admin-id";
    const list = await app.inject({ method: "GET", url: "/admin/reports" });
    expect(list.statusCode).toBe(200);
    const body = list.json();
    expect(body.reports).toHaveLength(5);

    // Read the TARGET back off each row rather than counting them: a schema
    // that silently dropped `targetPostId` still returns five reports, all of
    // them pointing at nothing.
    const targets = body.reports.map(
      (r: any) =>
        r.targetNostrEventId ??
        r.targetPostId ??
        r.targetAccountId ??
        r.targetProfileId ??
        r.targetConversationId,
    );
    expect(targets.filter(Boolean)).toHaveLength(5);
    expect(targets).toContain("post-abc");
    expect(targets).toContain(UUID_C);

    await app.close();
  });

  it("refuses a conversation the reporter is not in, and says 404 rather than 403", async () => {
    // A conversation id is not a public identifier. Accepting one from anybody
    // makes the route an oracle over which conversations exist (a filed report
    // is a 201, an absent one a refusal) and puts a private thread in front of
    // a reviewer on a stranger's say-so. The refusal is 404 for
    // the reason the private-source rule gives: not-yours must be
    // indistinguishable from not-there.
    const app = await build();
    const res = await file(app, {
      targetConversationId: "44444444-4444-4444-8444-444444444444",
      category: "harassment",
    });
    expect(res.statusCode).toBe(404);
    expect(reports).toHaveLength(0);
    await app.close();
  });

  it("answers 404 for a person who does not exist, never the foreign key's 500", async () => {
    // §0ab tail (x). A well-formed uuid naming nobody reached the INSERT and
    // died on the `accounts` FK as `internal_error`. MUTATION: drop the
    // existence check and both cases file (this mock has no FK), so the 404
    // assertions fail; the control below keeps a check that refused EVERY
    // person from passing.
    const app = await build();
    const NOBODY = "44444444-4444-4444-8444-444444444444";

    for (const body of [
      { targetAccountId: NOBODY, category: "spam" },
      { targetProfileId: NOBODY, category: "spam" },
      // One real, one not: every id named must exist.
      { targetAccountId: UUID_A, targetProfileId: NOBODY, category: "spam" },
    ]) {
      const res = await file(app, body);
      expect(res.statusCode, JSON.stringify(body)).toBe(404);
      expect(res.json().error).toBe("account_not_found");
    }
    expect(reports).toHaveLength(0);

    const ok = await file(app, { targetProfileId: UUID_B, category: "spam" });
    expect(ok.statusCode).toBe(201);
  });

  it("refuses a report that names nothing", async () => {
    const app = await build();
    const res = await file(app, { category: "spam" });
    expect(res.statusCode).toBe(400);
    expect(reports).toHaveLength(0);
    await app.close();
  });

  it("DERIVES the triage priority from the category and never takes it from the client", async () => {
    const app = await build();

    const p0 = await file(app, { targetPostId: "p1", category: "csam" });
    expect(p0.json().priority).toBe("P0");
    // 24 hours after the row's created_at, not 24 hours after "now" — the
    // deadline is a fact about the report.
    expect(p0.json().triageDeadline).toBe("2026-09-18T09:00:00.000Z");

    const p1 = await file(app, { targetPostId: "p2", category: "hate" });
    expect(p1.json().priority).toBe("P1");

    const p2 = await file(app, { targetPostId: "p3", category: "spam" });
    expect(p2.json().priority).toBe("P2");
    expect(p2.json().triageDeadline).toBe("2026-09-24T09:00:00.000Z");

    // And a client that sends one is ignored rather than obeyed.
    const spoofed = await file(app, {
      targetPostId: "p4",
      category: "spam",
      priority: "P0",
    });
    expect(spoofed.json().priority).toBe("P2");

    await app.close();
  });

  it("refuses a category the enum cannot hold", async () => {
    const app = await build();
    const res = await file(app, { targetPostId: "p9", category: "vibes" });
    expect(res.statusCode).toBe(400);
    expect(reports).toHaveLength(0);
    await app.close();
  });
});

describe("the ladder, and the record it leaves (L6.4)", () => {
  beforeEach(() => {
    sessionSub = "admin-id";
  });

  it("stores BOTH sentences, the action and the appeal deadline", async () => {
    const app = await build();
    sessionSub = "reporter-id";
    await file(app, { targetAccountId: UUID_A, category: "harassment" });
    sessionSub = "admin-id";

    const res = await resolve(app, R1, {
      action: "suspend_7d",
      reason: "repeated targeted abuse",
      reasoning: "third upheld report; ICJG threats limb met",
    });
    expect(res.statusCode).toBe(200);

    const row = reports[0];
    expect(row.status).toBe("resolved_removed");
    expect(row.action).toBe("suspend_7d");
    expect(row.reason).toBe("repeated targeted abuse");
    expect(row.reasoning).toBe("third upheld report; ICJG threats limb met");
    expect(row.subject_account_id).toBe(UUID_A);
    expect(row.appeal_deadline).toBeInstanceOf(Date);

    // The 7-day rung writes its TIMER. Without it the suspension is indefinite
    // wearing a shorter name, and the sweep has nothing to find.
    expect(accountStatus.get(UUID_A)?.status).toBe("suspended");
    expect(accountStatus.get(UUID_A)?.suspended_until).toBeInstanceOf(Date);

    await app.close();
  });

  it("clears the timer on the indefinite rungs", async () => {
    // A stale `suspended_until` on a permanent suspension would lift it a week
    // later, from the sweep, with nobody having decided that.
    const app = await build();
    sessionSub = "reporter-id";
    await file(app, { targetAccountId: UUID_A, category: "terrorism" });
    sessionSub = "admin-id";

    await resolve(app, R1, {
      action: "terminate",
      reason: "terrorism content",
      reasoning: "CTIRU referred",
    });
    expect(accountStatus.get(UUID_A)?.status).toBe("moderated");
    expect(accountStatus.get(UUID_A)?.suspended_until).toBeNull();
    await app.close();
  });

  it("requires the judgement as well as the reason", async () => {
    const app = await build();
    sessionSub = "reporter-id";
    await file(app, { targetPostId: "p1", category: "spam" });
    sessionSub = "admin-id";

    const noReasoning = await resolve(app, R1, {
      action: "no_action",
      reason: "fine",
    });
    expect(noReasoning.statusCode).toBe(400);
    expect(reports[0].status).toBe("open");

    const blank = await resolve(app, R1, {
      action: "no_action",
      reason: "fine",
      reasoning: "   ",
    });
    expect(blank.statusCode).toBe(400);
    expect(reports[0].status).toBe("open");

    await app.close();
  });

  it("warns without removing, and lands on its own resolved status", async () => {
    // `warn` in `resolved_removed` would say on the queue that content went
    // when it did not; in `resolved_no_action` it would say nothing happened to
    // somebody we had just written to.
    const app = await build();
    sessionSub = "reporter-id";
    await file(app, { targetAccountId: UUID_A, category: "other" });
    sessionSub = "admin-id";

    await resolve(app, R1, {
      action: "warn",
      reason: "please keep it civil",
      reasoning: "ToS-only; no illegal-content limb",
    });
    expect(reports[0].status).toBe("resolved_actioned");
    expect(accountStatus.has(UUID_A)).toBe(false);
    await app.close();
  });

  it("refuses the account rungs when the report resolves to nobody", async () => {
    const app = await build();
    sessionSub = "reporter-id";
    await file(app, { targetPostId: "orphan", category: "spam" });
    sessionSub = "admin-id";

    const res = await resolve(app, R1, {
      action: "suspend",
      reason: "x",
      reasoning: "y",
    });
    expect(res.statusCode).toBe(409);
    expect(res.json().error).toBe("no_subject_account");
    // AND NOTHING MOVED. The old route's failure was not the refusal, it was
    // resolving the report having done nothing.
    expect(reports[0].status).toBe("open");
    await app.close();
  });

  it("refuses a WARNING when there is nobody to warn", async () => {
    // Found by DRIVING it, not by reading it. A warning's whole effect is the
    // email, so on a report about an ingested post — which has no all.haus
    // account behind it — pressing Warn resolved the report, wrote a creditable
    // record and warned nobody. The other five actions all still DO something
    // without a recipient, which is why this guard is narrow and separate.
    const app = await build();
    sessionSub = "reporter-id";
    await file(app, { targetPostId: "external-post", category: "hate" });
    sessionSub = "admin-id";

    const res = await resolve(app, R1, {
      action: "warn",
      reason: "please stop",
      reasoning: "upheld",
    });
    expect(res.statusCode).toBe(409);
    expect(res.json().error).toBe("no_subject_account");
    expect(reports[0].status).toBe("open");
    expect(sendModerationNoticeEmail).not.toHaveBeenCalled();
    await app.close();
  });

  it("allows a warning where the report DOES name somebody", async () => {
    // The control: a guard that refused every warning would pass the test
    // above and delete the rung.
    const app = await build();
    sessionSub = "reporter-id";
    await file(app, { targetAccountId: UUID_A, category: "hate" });
    sessionSub = "admin-id";

    const res = await resolve(app, R1, {
      action: "warn",
      reason: "please stop",
      reasoning: "upheld",
    });
    expect(res.statusCode).toBe(200);
    expect(reports[0].status).toBe("resolved_actioned");
    expect(sendModerationNoticeEmail).toHaveBeenCalledTimes(1);
    await app.close();
  });

  it("tells the member, with an appeal link, and never on a dismissal", async () => {
    const app = await build();
    sessionSub = "reporter-id";
    await file(app, { targetAccountId: UUID_A, category: "harassment" });
    await file(app, { targetAccountId: UUID_B, category: "spam" });
    sessionSub = "admin-id";

    await resolve(app, R1, { action: "suspend", reason: "abuse", reasoning: "upheld" });
    expect(requestStepUpToken).toHaveBeenCalledWith(UUID_A, "appeal", expect.any(Date));
    const [, kind, , opts] = sendModerationNoticeEmail.mock.calls[0] as unknown as [
      string,
      string,
      string,
      { appealUrl?: string },
    ];
    expect(kind).toBe("account_suspended");
    expect(opts.appealUrl).toContain(`/appeal/${R1}?token=`);

    sendModerationNoticeEmail.mockClear();
    await resolve(app, R2, { action: "no_action", reason: "no", reasoning: "not a breach" });
    // Nothing was done to them, so nothing is said to them.
    expect(sendModerationNoticeEmail).not.toHaveBeenCalled();
    await app.close();
  });

  it("lets exactly one of two concurrent resolvers win, and the loser writes NOTHING", async () => {
    // FORCE THE INTERLEAVING. Left to the event loop the first request runs to
    // completion before the second issues a query, so a route with no claim at
    // all passes. Both pre-reads are held until both have arrived; both then
    // see an open report and both attempt to resolve it.
    //
    // BOTH RACERS ARE ACCOUNT ACTIONS, AND DELIBERATELY DIFFERENT ONES. That is
    // what makes the second assertion able to fail: a loser that reached the
    // account half before finding out it had lost would leave
    // `accounts.status` holding ITS verdict, committed, behind a 409. With one
    // racer that touches no account there is nothing for that assertion to see.
    const app = await build();
    sessionSub = "reporter-id";
    await file(app, { targetAccountId: UUID_A, category: "harassment" });
    sessionSub = "admin-id";

    holdReadsUntil(2);
    const [a, b] = await Promise.all([
      resolve(app, R1, { action: "suspend", reason: "one", reasoning: "j1" }),
      resolve(app, R1, { action: "terminate", reason: "two", reasoning: "j2" }),
    ]);

    expect([a.statusCode, b.statusCode].sort()).toEqual([200, 409]);

    // ONE decision on the record, not the last one written. Two winners would
    // leave the row holding one action and the other's reason.
    const row = reports[0];
    const wonSuspend = a.statusCode === 200;
    expect(row.reason).toBe(wonSuspend ? "one" : "two");
    expect(row.action).toBe(wonSuspend ? "suspend" : "terminate");

    // And the loser wrote nothing at all. The account carries the WINNER's
    // verdict — not whichever transaction happened to run its UPDATE last.
    expect(accountStatus.get(UUID_A)?.status).toBe(
      wonSuspend ? "suspended" : "moderated",
    );

    // Exactly one member notice: one thing happened to them.
    expect(sendModerationNoticeEmail).toHaveBeenCalledTimes(1);

    await app.close();
  });

  it("refuses a second resolution outright — the pre-read's own fast path", async () => {
    const app = await build();
    sessionSub = "reporter-id";
    await file(app, { targetPostId: "p1", category: "spam" });
    sessionSub = "admin-id";

    await resolve(app, R1, { action: "no_action", reason: "a", reasoning: "b" });
    const again = await resolve(app, R1, { action: "warn", reason: "c", reasoning: "d" });
    expect(again.statusCode).toBe(409);
    expect(reports[0].reason).toBe("a");
    await app.close();
  });
});

describe("what a report from the workspace resolves to (§0z item 6)", () => {
  // The web sends BOTH ids on every card — `post.id` and `post.version` — and
  // until 2026-09-18 the resolver short-circuited on the event id, so no
  // report filed from a card or an article page ever reached the ladder's
  // account rungs, and an external card's version hash resolved as native
  // content that matched nothing. These cases file the way the web files.
  beforeEach(() => {
    sessionSub = "reporter-id";
  });

  it("a native card, both ids: the account rungs reach the author", async () => {
    const app = await build();
    await file(app, { targetPostId: NATIVE_POST, targetNostrEventId: NATIVE_EVENT, category: "hate" });
    sessionSub = "admin-id";

    const res = await resolve(app, R1, { action: "suspend", reason: "x", reasoning: "y" });
    // Pre-fix: 409 no_subject_account, because the event id answered first
    // and carried no account. Either half of the fix answers this case on its
    // own (post id first, OR the content-table lookup by event id), so this
    // does not pin the ORDER — the external case below is what does.
    expect(res.statusCode).toBe(200);
    expect(reports[0].subject_account_id).toBe(UUID_A);
    expect(accountStatus.get(UUID_A)?.status).toBe("suspended");
    await app.close();
  });

  it("an external card, both ids: the version hash does not make it native", async () => {
    const app = await build();
    await file(app, {
      targetPostId: "external-post",
      targetNostrEventId: EXTERNAL_VERSION_HASH,
      category: "hate",
    });
    sessionSub = "admin-id";

    const res = await resolve(app, R1, { action: "remove_content", reason: "x", reasoning: "y" });
    // Pre-fix: 200, resolved_removed, nothing removed.
    expect(res.statusCode).toBe(409);
    expect(res.json().error).toBe("external_content_not_removable");
    expect(reports[0].status).toBe("open");
    await app.close();
  });

  it("an event id alone: whose account is answered from the content tables", async () => {
    const app = await build();
    await file(app, { targetNostrEventId: NATIVE_EVENT, category: "harassment" });
    sessionSub = "admin-id";

    const res = await resolve(app, R1, { action: "warn", reason: "please stop", reasoning: "upheld" });
    expect(res.statusCode).toBe(200);
    expect(reports[0].subject_account_id).toBe(UUID_A);
    expect(sendModerationNoticeEmail).toHaveBeenCalledTimes(1);
    await app.close();
  });

  it("a removal that matches nothing is refused, not recorded", async () => {
    const app = await build();
    await file(app, { targetNostrEventId: "f".repeat(64), category: "spam" });
    sessionSub = "admin-id";

    const res = await resolve(app, R1, { action: "remove_content", reason: "x", reasoning: "y" });
    expect(res.statusCode).toBe(409);
    expect(res.json().error).toBe("no_removable_content");
    expect(reports[0].status).toBe("open");
    await app.close();
  });

  it("remove_content removes a REPLY — the one content action on a reported comment (§0ab item 4)", async () => {
    // Since migration 232 a native reply is a card with its own event id, so it
    // is reportable from every feed and resolves to a NON-external target. The
    // prepare read `articles` and `notes` only, so this answered 409
    // `no_removable_content` from the day replies became cards — the button was
    // in the queue and there was nothing behind it. `authorOfEvent` has always
    // unioned `comments`, so the ACCOUNT rungs worked on the same report: the
    // asymmetry was between two functions in one file.
    const app = await build();
    await file(app, { targetPostId: COMMENT_POST, targetNostrEventId: COMMENT_EVENT, category: "harassment" });
    sessionSub = "admin-id";

    const res = await resolve(app, R1, { action: "remove_content", reason: "x", reasoning: "y" });
    expect(res.statusCode).toBe(200);
    expect(reports[0].status).toBe("resolved_removed");
    // The WRITING goes, not just the card: `GET /replies` reads
    // `comments.deleted_at` and served the full text while it stayed NULL.
    expect(comments[0].deleted_at).toBeInstanceOf(Date);
    expect(comments[0].card_deleted_at).toBeInstanceOf(Date);
    // And the notice reaches the reply's author, resolved from the row.
    expect(reports[0].subject_account_id).toBe(UUID_A);
    await app.close();
  });

  it("a reply already removed is REFUSED, not recorded a second time", async () => {
    // The matched-nothing contract, on the new arm. Without the
    // `deleted_at IS NULL` test the report would close `resolved_removed` with
    // nothing removed — the silent no-op the refusal exists to end.
    comments[0].deleted_at = new Date("2026-09-01T00:00:00Z");
    const app = await build();
    await file(app, { targetPostId: COMMENT_POST, targetNostrEventId: COMMENT_EVENT, category: "harassment" });
    sessionSub = "admin-id";

    const res = await resolve(app, R1, { action: "remove_content", reason: "x", reasoning: "y" });
    expect(res.statusCode).toBe(409);
    expect(res.json().error).toBe("no_removable_content");
    expect(reports[0].status).toBe("open");
    await app.close();
  });

  it("suspending a member removes their REPLIES too, not only their reply cards (§0ab item 4, sibling)", async () => {
    // `account_suspended` says "the writing you had published has been removed
    // from all.haus and from the relays it had reached". The sweep stamped
    // `feed_items` and left `comments.deleted_at` NULL, so the article page went
    // on serving the full text and no tombstone was ever published — the
    // sentence was false on both clauses.
    const app = await build();
    await file(app, { targetAccountId: UUID_A, category: "harassment" });
    sessionSub = "admin-id";

    const res = await resolve(app, R1, { action: "suspend_7d", reason: "x", reasoning: "y" });
    expect(res.statusCode).toBe(200);
    expect(accountStatus.get(UUID_A)?.status).toBe("suspended");
    expect(comments[0].deleted_at).toBeInstanceOf(Date);
    expect(comments[0].card_deleted_at).toBeInstanceOf(Date);
    await app.close();
  });

  it("control: a removal that matches a note goes through", async () => {
    // A refusal that fired on every removal would pass the case above and
    // delete the rung.
    const app = await build();
    await file(app, { targetPostId: NATIVE_POST, targetNostrEventId: NATIVE_EVENT, category: "spam" });
    sessionSub = "admin-id";

    const res = await resolve(app, R1, { action: "remove_content", reason: "x", reasoning: "y" });
    expect(res.statusCode).toBe(200);
    expect(reports[0].status).toBe("resolved_removed");
    expect(reports[0].subject_account_id).toBe(UUID_A);
    await app.close();
  });
});

describe("raising the priority — Terms 9.3's 24 hours gets its instrument (§0z item 8)", () => {
  const raise = (app: any, id: string, body: Record<string, unknown>) =>
    app.inject({ method: "PATCH", url: `/admin/reports/${id}/priority`, payload: body });

  beforeEach(() => {
    sessionSub = "reporter-id";
  });

  it("a credible threat filed under harassment can be made P0, with who/when/why on the row", async () => {
    const app = await build();
    await file(app, { targetAccountId: UUID_A, category: "harassment" });
    expect(reports[0].priority).toBe("P1"); // derived from the category
    sessionSub = "admin-id";

    const res = await raise(app, R1, { priority: "P0", reason: "names an address and a time" });
    expect(res.statusCode).toBe(200);
    expect(reports[0].priority).toBe("P0");
    expect(reports[0].priority_raised_by).toBe("admin-id");
    expect(reports[0].priority_raise_reason).toBe("names an address and a time");
    expect(reports[0].priority_raised_at).toBeInstanceOf(Date);
    // The deadline is recomputed from created_at, not from now: 24h after
    // filing, which for a report filed on 2026-09-17 has long passed.
    expect(res.json().triageDeadline).toBe("2026-09-18T09:00:00.000Z");

    // …and the queue carries the raise, so the screen can show it.
    const list = await app.inject({ method: "GET", url: "/admin/reports" });
    const row = list.json().reports.find((r: { id: string }) => r.id === R1);
    expect(row.priority).toBe("P0");
    expect(row.priorityRaiseReason).toBe("names an address and a time");
    expect(row.triageDeadline).toBe("2026-09-18T09:00:00.000Z");
    await app.close();
  });

  it("a raise needs a reason — a space is not one", async () => {
    const app = await build();
    await file(app, { targetAccountId: UUID_A, category: "harassment" });
    sessionSub = "admin-id";

    expect((await raise(app, R1, { priority: "P0", reason: "   " })).statusCode).toBe(400);
    expect((await raise(app, R1, { priority: "P0" })).statusCode).toBe(400);
    expect(reports[0].priority).toBe("P1");
    await app.close();
  });

  it("never LOWERS: the priority is the claim, and the finding goes in reasoning", async () => {
    const app = await build();
    await file(app, { targetAccountId: UUID_A, category: "csam" });
    expect(reports[0].priority).toBe("P0");
    sessionSub = "admin-id";

    const res = await raise(app, R1, { priority: "P2", reason: "plainly not" });
    expect(res.statusCode).toBe(409);
    expect(res.json()).toEqual({ error: "not_a_raise", priority: "P0" });
    expect(reports[0].priority).toBe("P0");
    expect(reports[0].priority_raised_at).toBeNull();
    await app.close();
  });

  it("refuses on a resolved report, and says which state it found", async () => {
    const app = await build();
    await file(app, { targetAccountId: UUID_A, category: "harassment" });
    sessionSub = "admin-id";
    await resolve(app, R1, { action: "no_action", reason: "x", reasoning: "y" });

    const res = await raise(app, R1, { priority: "P0", reason: "late" });
    expect(res.statusCode).toBe(409);
    expect(res.json().error).toBe("not_open");
    expect(reports[0].priority).toBe("P1");
    await app.close();
  });

  it("is admin-only, and 404s a non-uuid", async () => {
    const app = await build();
    await file(app, { targetAccountId: UUID_A, category: "harassment" });
    sessionSub = "admin-id";
    adminAllowed = false;
    const refused = await raise(app, R1, { priority: "P0", reason: "x" });
    expect([401, 403]).toContain(refused.statusCode);
    expect(reports[0].priority).toBe("P1");
    adminAllowed = true;
    expect((await raise(app, "not-a-uuid", { priority: "P0", reason: "x" })).statusCode).toBe(404);
    await app.close();
  });
});

describe("a later, lesser decision does not downgrade a standing one (§0z item 14)", () => {
  beforeEach(() => {
    sessionSub = "reporter-id";
  });

  it("a terminated member drawing a second report resolved suspend_7d keeps their termination", async () => {
    const app = await build();
    await file(app, { targetAccountId: UUID_A, category: "csam" });
    sessionSub = "admin-id";
    expect((await resolve(app, R1, { action: "terminate", reason: "x", reasoning: "y" })).statusCode).toBe(200);
    expect(accountStatus.get(UUID_A)?.status).toBe("moderated");

    sessionSub = "reporter-id";
    await file(app, { targetAccountId: UUID_A, category: "spam" });
    sessionSub = "admin-id";
    const res = await resolve(app, R2, { action: "suspend_7d", reason: "x", reasoning: "y" });
    // Pre-fix: 200, `suspended` with a timer, and the sweep lifted the
    // termination a week later.
    expect(res.statusCode).toBe(409);
    expect(res.json()).toMatchObject({ error: "standing_decision", status: "moderated" });
    expect(accountStatus.get(UUID_A)?.status).toBe("moderated");
    expect(accountStatus.get(UUID_A)?.suspended_until).toBeNull();
    // Refused BEFORE the claim: the second report is still open.
    expect(reports[1].status).toBe("open");
    await app.close();
  });

  it("an appeal REVERSED on the earlier report does not lift the later decision (§0ab item 3)", async () => {
    // The §0z item 14 rule read from the other end. Suspended 7 days by R1,
    // then terminated by R2 (which `ACCOUNT_ACTION_FROM.terminate` permits from
    // `suspended`). Winning the appeal on R1 says the SUSPENSION was wrong; it
    // says nothing about the termination, which stands until it is appealed on
    // its own. Pre-fix the lift asked `status IN ('suspended','moderated')` —
    // whatever was standing — so the lesser report's appeal reactivated a
    // terminated member, and the only trace was `accountLifted: true`.
    const app = await build();
    await file(app, { targetAccountId: UUID_A, category: "harassment" });
    sessionSub = "admin-id";
    await resolve(app, R1, { action: "suspend_7d", reason: "x", reasoning: "y" });

    sessionSub = "reporter-id";
    await file(app, { targetAccountId: UUID_A, category: "csam" });
    sessionSub = "admin-id";
    await resolve(app, R2, { action: "terminate", reason: "x", reasoning: "y" });
    expect(accountStatus.get(UUID_A)?.status).toBe("moderated");

    reports[0].appealed_at = new Date();
    const res = await decideAppeal(app, R1, { outcome: "reversed", reasoning: "on reflection" });

    // The appeal is still DECIDED — it is a judgement about R1 — and it is the
    // account state that is left alone.
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ outcome: "reversed", accountLifted: false });
    expect(reports[0].appeal_outcome).toBe("reversed");
    expect(accountStatus.get(UUID_A)?.status).toBe("moderated");
    await app.close();
  });

  it("control: appealing the decision that IS standing lifts it", async () => {
    // Without this the case above passes against a route that never lifts
    // anything at all.
    const app = await build();
    await file(app, { targetAccountId: UUID_A, category: "harassment" });
    sessionSub = "admin-id";
    await resolve(app, R1, { action: "suspend_7d", reason: "x", reasoning: "y" });
    expect(accountStatus.get(UUID_A)?.status).toBe("suspended");

    reports[0].appealed_at = new Date();
    const res = await decideAppeal(app, R1, { outcome: "reversed", reasoning: "on reflection" });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ accountLifted: true });
    expect(accountStatus.get(UUID_A)?.status).toBe("active");
    expect(accountStatus.get(UUID_A)?.suspended_until).toBeNull();
    await app.close();
  });

  it("control: reversing the LATER decision lifts it, earlier report notwithstanding", async () => {
    // The later decision is the one standing, so its appeal is the one that
    // reaches the account — and the earlier, already-served suspension is not a
    // reason to refuse.
    const app = await build();
    await file(app, { targetAccountId: UUID_A, category: "harassment" });
    sessionSub = "admin-id";
    await resolve(app, R1, { action: "suspend_7d", reason: "x", reasoning: "y" });
    sessionSub = "reporter-id";
    await file(app, { targetAccountId: UUID_A, category: "csam" });
    sessionSub = "admin-id";
    await resolve(app, R2, { action: "terminate", reason: "x", reasoning: "y" });

    reports[1].appealed_at = new Date();
    const res = await decideAppeal(app, R2, { outcome: "reversed", reasoning: "on reflection" });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ accountLifted: true });
    expect(accountStatus.get(UUID_A)?.status).toBe("active");
    await app.close();
  });

  it("an UPHELD appeal lifts nothing, whatever is standing", async () => {
    const app = await build();
    await file(app, { targetAccountId: UUID_A, category: "harassment" });
    sessionSub = "admin-id";
    await resolve(app, R1, { action: "suspend_7d", reason: "x", reasoning: "y" });

    reports[0].appealed_at = new Date();
    const res = await decideAppeal(app, R1, { outcome: "upheld", reasoning: "it stands" });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ accountLifted: false });
    expect(accountStatus.get(UUID_A)?.status).toBe("suspended");
    await app.close();
  });

  it("control: a timed suspension may be made a termination", async () => {
    const app = await build();
    await file(app, { targetAccountId: UUID_A, category: "harassment" });
    sessionSub = "admin-id";
    expect((await resolve(app, R1, { action: "suspend_7d", reason: "x", reasoning: "y" })).statusCode).toBe(200);
    expect(accountStatus.get(UUID_A)?.suspended_until).toBeInstanceOf(Date);

    sessionSub = "reporter-id";
    await file(app, { targetAccountId: UUID_A, category: "csam" });
    sessionSub = "admin-id";
    const res = await resolve(app, R2, { action: "terminate", reason: "x", reasoning: "y" });
    expect(res.statusCode).toBe(200);
    expect(accountStatus.get(UUID_A)?.status).toBe("moderated");
    expect(accountStatus.get(UUID_A)?.suspended_until).toBeNull();
    await app.close();
  });
});

describe("an appeal token is spent only on an appeal that was filed (§0ab guard (d))", () => {
  const appeal = (app: Awaited<ReturnType<typeof build>>, id: string) =>
    app.inject({
      method: "POST",
      url: `/moderation/appeal/${id}`,
      payload: { token: "appeal-token", text: "the frame is literary" },
    });

  /** A resolved report on UUID_A whose window is open or closed, as asked. */
  async function decided(app: Awaited<ReturnType<typeof build>>, windowOpen: boolean) {
    sessionSub = "reporter-id";
    await file(app, { targetAccountId: UUID_A, category: "harassment" });
    sessionSub = "admin-id";
    expect((await resolve(app, R1, { action: "suspend_7d", reason: "x", reasoning: "y" })).statusCode).toBe(200);
    expect(reports[0].subject_account_id).toBe(UUID_A);
    if (!windowOpen) reports[0].appeal_deadline = new Date(Date.now() - 1000);
    txOutcomes.length = 0;
  }

  it("a closed window refuses AND rolls the claim back, so the token survives", async () => {
    // Pre-fix the callback RETURNED false after claiming: a commit, so the
    // token was burned with no appeal recorded — and a token for report A
    // posted at report B's URL burned A's the same way.
    const app = await build();
    await decided(app, false);
    const res = await appeal(app, R1);
    expect(res.statusCode).toBe(403);
    expect(res.json()).toEqual({ error: "appeal_not_available" });
    expect(claimStepUpToken).toHaveBeenCalledTimes(1);
    expect(txOutcomes).toEqual(["rollback"]);
    expect(reports[0].appealed_at).toBeNull();
    await app.close();
  });

  it("a second appeal on the same report rolls back too", async () => {
    const app = await build();
    await decided(app, true);
    expect((await appeal(app, R1)).statusCode).toBe(201);
    expect((await appeal(app, R1)).statusCode).toBe(403);
    expect(txOutcomes).toEqual(["commit", "rollback"]);
    await app.close();
  });

  it("control: an appeal inside the window is filed and committed", async () => {
    const app = await build();
    await decided(app, true);
    const res = await appeal(app, R1);
    expect(res.statusCode).toBe(201);
    expect(txOutcomes).toEqual(["commit"]);
    expect(reports[0].appeal_text).toBe("the frame is literary");
    await app.close();
  });

  it("a refused TOKEN is a plain refusal — nothing was claimed, so nothing rolls back", async () => {
    const app = await build();
    await decided(app, true);
    claimStepUpToken.mockResolvedValueOnce(false);
    const res = await appeal(app, R1);
    expect(res.statusCode).toBe(403);
    expect(res.json()).toEqual({ error: "appeal_not_available" });
    expect(reports[0].appealed_at).toBeNull();
    await app.close();
  });
});
