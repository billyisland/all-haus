import { describe, it, expect, vi, beforeEach } from "vitest";
import Fastify from "fastify";

// =============================================================================
// A REPLY IS TO SOMEBODY, AND POST /replies TOLD THE WRONG PERSON.
//
// The route notified the author of the RESOLVED target and nobody else — the
// root article or note. So replying to a comment told the author of the piece,
// while the person actually replied to learned nothing: no notification, no
// unread count, no way to discover that the conversation they were in had gone
// on without them. True of every native conversation on the platform, the
// article page included.
//
// Two people now have a claim on a nested reply and they are told DIFFERENT
// THINGS — "replied to your comment" against "replied to <your piece>" — and
// the only thing separating those two rows is `parent_comment_id`, bound on one
// and NULL on the other (migration 230). Everything else about them is
// identical, `comment_id` included: on BOTH it is the NEW reply, because that
// is what the panel renders and what `focus_post_id` opens. So this suite's job
// is the BINDING, and it checks it the way `activitypub-canonical-url` learned
// to — by zipping the column list against the VALUES tuple and resolving each
// placeholder through `params`. Asserting "the SQL mentions parent_comment_id
// and the params contain the parent's id" passes against a route that binds it
// to the wrong column, which is the exact off-by-one this shape is for.
//
// THE CONTROLS ARE HALF THE SUITE and each is a real way to get this wrong:
//
//   • a top-level reply must still produce exactly ONE row, parent NULL — a
//     change that always binds the parent breaks every reply to a piece;
//   • one person must never get two rows, and where the piece's author is also
//     the parent's author the SPECIFIC sentence is the one they get;
//   • the replier is dropped LAST, not by an early return — replying to your
//     OWN comment under somebody else's article still owes that writer a
//     notification, and a self-check at the top of the block swallows it.
//     That case is the reason the old `if (authorId !== contentAuthorId)`
//     could not simply be extended.
// =============================================================================

const REPLIER = "00000000-0000-4000-8000-00000000a001";
const WRITER = "00000000-0000-4000-8000-00000000b002";
const PARENT_AUTHOR = "00000000-0000-4000-8000-00000000c003";

const ARTICLE_ID = "00000000-0000-4000-8000-00000000d004";
const NEW_COMMENT = "00000000-0000-4000-8000-00000000e005";
const PARENT_ID = "00000000-0000-4000-8000-00000000f006";

const ARTICLE_EVENT = "a".repeat(64);

let calls: Array<{ sql: string; params: unknown[] }> = [];
// Who the parent comment belongs to — moved per test, since "the parent's
// author is also the piece's author" is one of the cases that must not double.
let parentAuthor = PARENT_AUTHOR;

function scriptedQuery(sql: string, params: unknown[] = []) {
  calls.push({ sql, params });

  if (sql.includes("FROM articles") && sql.includes("access_mode")) {
    return Promise.resolve({
      rows:
        params[0] === ARTICLE_EVENT
          ? [
              {
                id: ARTICLE_ID,
                writer_id: WRITER,
                comments_enabled: true,
                // Free: the paywall guard is proved next door, and a gated
                // fixture here would only stop the route reaching the code
                // under test.
                access_mode: "public",
                publication_id: null,
              },
            ]
          : [],
      rowCount: params[0] === ARTICLE_EVENT ? 1 : 0,
    });
  }

  // THE PARENT READ, and it is keyed on the PARAM. The resolver's own comments
  // leg is `WHERE nostr_event_id = $1` and this one is `WHERE id = $1`; both
  // are `SELECT … FROM comments`, so a mock dispatching on "does it say
  // comments" answers the wrong one and the suite pins itself.
  if (sql.includes("FROM comments") && sql.includes("WHERE id =")) {
    return Promise.resolve({
      rows:
        params[0] === PARENT_ID
          ? [{ target_event_id: ARTICLE_EVENT, author_id: parentAuthor }]
          : [],
      rowCount: params[0] === PARENT_ID ? 1 : 0,
    });
  }

  // The resolver's comments leg (target resolution) — no comment has this
  // event id, so the article above wins.
  if (sql.includes("FROM comments") && sql.includes("WHERE nostr_event_id")) {
    return Promise.resolve({ rows: [], rowCount: 0 });
  }

  if (sql.includes("INSERT INTO comments")) {
    return Promise.resolve({ rows: [{ id: NEW_COMMENT }], rowCount: 1 });
  }

  return Promise.resolve({ rows: [], rowCount: 0 });
}

vi.mock("@platform-pub/shared/db/client.js", () => ({
  pool: {
    query: (sql: string, params: unknown[] = []) => scriptedQuery(sql, params),
  },
  withTransaction: (
    cb: (client: { query: typeof scriptedQuery }) => Promise<unknown>,
  ) => cb({ query: scriptedQuery }),
}));

vi.mock("@platform-pub/shared/lib/logger.js", () => ({
  default: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

vi.mock("../src/services/article-access/index.js", () => ({
  checkArticleAccess: async () => ({ hasAccess: true }),
}));

// Mentions are their own suite and their own insert; silenced so the
// notification assertions below count only the reply's own rows.
vi.mock("../src/lib/mentions.js", () => ({
  resolveMentionedAccountIds: async () => [],
}));

let session = REPLIER;
vi.mock("../src/middleware/auth.js", () => ({
  requireAuth: async (req: { session?: { sub: string } }) => {
    req.session = { sub: session };
  },
  optionalAuth: async (req: { session?: { sub: string } }) => {
    req.session = { sub: session };
  },
}));

const { replyRoutes } = await import("../src/routes/replies.js");

// ---------------------------------------------------------------------------
// Resolve an INSERT's columns to the values actually bound to them.
//
// The point is the BINDING, not the presence of a name. `parent_comment_id`
// appearing in the SQL while the parent's id sits somewhere in `params` is true
// of a route that binds it to `note_id`, and equally true of one that shifts
// every placeholder by one; both would ship a notification that says the wrong
// sentence to the wrong person.
// ---------------------------------------------------------------------------
function boundColumns(
  call: { sql: string; params: unknown[] },
): Record<string, unknown> {
  const cols = call.sql
    .slice(call.sql.indexOf("(") + 1, call.sql.indexOf(")"))
    .split(",")
    .map((c) => c.trim());
  const valuesAt = call.sql.indexOf("VALUES");
  const tuple = call.sql
    .slice(call.sql.indexOf("(", valuesAt) + 1, call.sql.indexOf(")", valuesAt))
    .split(",")
    .map((v) => v.trim());
  expect(cols.length).toBe(tuple.length);
  const out: Record<string, unknown> = {};
  cols.forEach((col, i) => {
    const token = tuple[i];
    out[col] = token.startsWith("$")
      ? call.params[Number(token.slice(1)) - 1]
      : token.replace(/^'|'$/g, "");
  });
  return out;
}

function notifications(): Array<Record<string, unknown>> {
  return calls
    .filter((c) => c.sql.includes("INSERT INTO notifications"))
    .map(boundColumns);
}

async function build() {
  const app = Fastify();
  await app.register(replyRoutes);
  return app;
}

function post(
  app: Awaited<ReturnType<typeof build>>,
  parentCommentId?: string,
) {
  return app.inject({
    method: "POST",
    url: "/replies",
    payload: {
      nostrEventId: "f".repeat(64),
      targetEventId: ARTICLE_EVENT,
      targetKind: 30023,
      ...(parentCommentId ? { parentCommentId } : {}),
      content: "A remark.",
    },
  });
}

beforeEach(() => {
  calls = [];
  parentAuthor = PARENT_AUTHOR;
  session = REPLIER;
});

describe("POST /replies — who is told, and what they are told", () => {
  it("tells BOTH the person replied to and the piece's author", async () => {
    const app = await build();
    expect((await post(app, PARENT_ID)).statusCode).toBe(201);

    const rows = notifications();
    expect(rows).toHaveLength(2);
    expect(rows.every((r) => r.type === "new_reply")).toBe(true);

    const toParent = rows.find((r) => r.recipient_id === PARENT_AUTHOR);
    const toWriter = rows.find((r) => r.recipient_id === WRITER);
    expect(toParent).toBeDefined();
    expect(toWriter).toBeDefined();

    // The discriminator, bound on one row and only one.
    expect(toParent!.parent_comment_id).toBe(PARENT_ID);
    expect(toWriter!.parent_comment_id).toBeNull();

    // And on BOTH rows `comment_id` is the NEW reply — not the parent. This is
    // what the panel renders and what the conversation address is built from;
    // binding the parent here would open the wrong post and show the recipient
    // their own words back.
    expect(toParent!.comment_id).toBe(NEW_COMMENT);
    expect(toWriter!.comment_id).toBe(NEW_COMMENT);

    // Both still name the piece, so both rows remain findable.
    expect(toParent!.article_id).toBe(ARTICLE_ID);
    expect(toWriter!.article_id).toBe(ARTICLE_ID);
    expect(toParent!.actor_id).toBe(REPLIER);

    await app.close();
  });

  it("CONTROL: a top-level reply is still one row, with no parent bound", async () => {
    const app = await build();
    expect((await post(app)).statusCode).toBe(201);

    const rows = notifications();
    expect(rows).toHaveLength(1);
    expect(rows[0].recipient_id).toBe(WRITER);
    expect(rows[0].parent_comment_id).toBeNull();
    await app.close();
  });

  it("one person gets ONE row, and it is the specific sentence", async () => {
    // The writer answered under their own piece; a reader replies to them.
    parentAuthor = WRITER;
    const app = await build();
    expect((await post(app, PARENT_ID)).statusCode).toBe(201);

    const rows = notifications();
    expect(rows).toHaveLength(1);
    expect(rows[0].recipient_id).toBe(WRITER);
    // Not the vaguer copy: they are being told about their COMMENT.
    expect(rows[0].parent_comment_id).toBe(PARENT_ID);
    await app.close();
  });

  it("replying to your OWN comment still tells the piece's author", async () => {
    // The case an early self-check swallows. The replier owns the parent, so
    // their own row is dropped — and the writer's must survive that drop.
    parentAuthor = REPLIER;
    const app = await build();
    expect((await post(app, PARENT_ID)).statusCode).toBe(201);

    const rows = notifications();
    expect(rows).toHaveLength(1);
    expect(rows[0].recipient_id).toBe(WRITER);
    expect(rows[0].parent_comment_id).toBeNull();
    await app.close();
  });

  it("the writer replying under their own piece tells only the person replied to", async () => {
    session = WRITER;
    const app = await build();
    expect((await post(app, PARENT_ID)).statusCode).toBe(201);

    const rows = notifications();
    expect(rows).toHaveLength(1);
    expect(rows[0].recipient_id).toBe(PARENT_AUTHOR);
    expect(rows[0].parent_comment_id).toBe(PARENT_ID);
    expect(rows[0].actor_id).toBe(WRITER);
    await app.close();
  });

  it("the parent's author comes off the read that ALREADY validated it", async () => {
    // A structural pin with a reason: the guard above has just proved the
    // parent row is live and in this conversation, which is what makes its
    // author a recipient at all. A second lookup would be a second chance to
    // read a row that has changed underneath the first, and the notification
    // would then name somebody the guard never checked.
    const app = await build();
    await post(app, PARENT_ID);
    const parentReads = calls.filter(
      (c) => c.sql.includes("FROM comments") && c.sql.includes("WHERE id ="),
    );
    expect(parentReads).toHaveLength(1);
    expect(parentReads[0].sql).toContain("author_id");
    await app.close();
  });
});
