import { describe, it, expect, vi, beforeEach } from "vitest";
import Fastify from "fastify";

// =============================================================================
// POST /replies CARRIES THE GATE (ARTICLE-HEADED-CONVERSATIONS-ADR D7, ship 1).
//
// WHY IT EXISTS. `POST /replies` is the only path that creates a kind-1111
// comment, and for as long as the route had existed it verified the target
// exists, that comments are enabled and that the author is not blocked — and
// never once asked whether the caller could READ the piece. The GET twenty
// lines below it did. The rule was enforced by the article page declining to
// draw a composer, and by nothing else: a UI rule is not an access control, and
// the hole was reachable by anyone who could form the request.
//
// THE SECOND TEST IS THE MORE IMPORTANT ONE. `checkArticleAccess` carries no
// `access_mode` term — for a free article by somebody else it returns
// {hasAccess: false} exactly as it does for an unpaid paywalled one — so the
// guard built as a BARE CALL 403s every comment on every free article on the
// site. That failure is total rather than partial, and a suite whose only new
// fixture is paywalled goes green against it. Hence the free-article case, and
// hence its assertion that the checker was never REACHED rather than merely
// that the status was 201.
//
// Mutation-proved both ways: drop the `access_mode === "paywalled"` branch and
// the free case goes red; drop the guard entirely and the paywalled case does.
// =============================================================================

const READER = "00000000-0000-4000-8000-0000000000a1";
const WRITER = "00000000-0000-4000-8000-0000000000b2";
const PAYWALLED_ARTICLE = "00000000-0000-4000-8000-0000000000c3";
const FREE_ARTICLE = "00000000-0000-4000-8000-0000000000d4";
const NEW_COMMENT = "00000000-0000-4000-8000-0000000000e5";
const EXISTING_COMMENT_EVENT = "e".repeat(64);

const PAYWALLED_EVENT = "a".repeat(64);
const FREE_EVENT = "b".repeat(64);

let calls: Array<{ sql: string; params: unknown[] }> = [];
let accessCalls: Array<unknown[]> = [];
let accessAnswer = { hasAccess: false };

// The squat refusal (CA-B2) asks `articles UNION ALL notes` inside the
// transaction — a different question from the kind-keyed SECOND lookup these
// pins exist to forbid, so it is left out of the scan by its own shape.
function ran(fragment: string): boolean {
  return calls.some((c) => !c.sql.includes("UNION ALL") && c.sql.includes(fragment));
}

// The mock answers FROM THE SQL IT IS HANDED (house rule), and hands out COPIES
// so no request can observe another's rows.
function scriptedQuery(sql: string, params: unknown[] = []) {
  calls.push({ sql, params });

  if (sql.includes("FROM articles") && sql.includes("access_mode")) {
    const ev = params[0];
    if (ev === PAYWALLED_EVENT) {
      return Promise.resolve({
        rows: [
          {
            id: PAYWALLED_ARTICLE,
            writer_id: WRITER,
            comments_enabled: true,
            access_mode: "paywalled",
            publication_id: null,
          },
        ],
        rowCount: 1,
      });
    }
    if (ev === FREE_EVENT) {
      return Promise.resolve({
        rows: [
          {
            id: FREE_ARTICLE,
            writer_id: WRITER,
            comments_enabled: true,
            access_mode: "public",
            publication_id: null,
          },
        ],
        rowCount: 1,
      });
    }
    return Promise.resolve({ rows: [], rowCount: 0 });
  }

  // The resolver's comments leg. `EXISTING_COMMENT_EVENT` is a real reply, and
  // the route must refuse it as a TARGET (nesting is `parentCommentId`).
  if (sql.includes("FROM comments") && sql.includes("WHERE nostr_event_id")) {
    const ev = params[0];
    if (ev === EXISTING_COMMENT_EVENT) {
      return Promise.resolve({
        rows: [
          {
            id: NEW_COMMENT,
            author_id: WRITER,
            target_event_id: FREE_EVENT,
          },
        ],
        rowCount: 1,
      });
    }
    return Promise.resolve({ rows: [], rowCount: 0 });
  }

  if (sql.includes("FROM blocks")) {
    return Promise.resolve({ rows: [], rowCount: 0 });
  }

  if (sql.includes("INSERT INTO comments")) {
    return Promise.resolve({ rows: [{ id: NEW_COMMENT }], rowCount: 1 });
  }

  // The pre-S25 notification context lookup: a bare `SELECT id FROM articles`
  // after the insert, keyed on the DECLARED kind. Answered so that a route
  // which still runs it is caught by the "did not run" assertion below rather
  // than by a coincidentally-NULL row.
  if (sql.includes("SELECT id FROM articles")) {
    return Promise.resolve({ rows: [{ id: FREE_ARTICLE }], rowCount: 1 });
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

vi.mock("../src/middleware/auth.js", () => ({
  requireAuth: async (req: { session?: { sub: string } }) => {
    req.session = { sub: READER };
  },
  optionalAuth: async (req: { session?: { sub: string } }) => {
    req.session = { sub: READER };
  },
}));

// The checker itself is proven by access.test.ts; what is under test here is
// WHETHER IT IS REACHED, and on which articles.
vi.mock("../src/services/article-access/index.js", () => ({
  checkArticleAccess: async (...args: unknown[]) => {
    accessCalls.push(args);
    return { ...accessAnswer };
  },
}));

const { replyRoutes } = await import("../src/routes/replies.js");

async function build() {
  const app = Fastify();
  await app.register(replyRoutes);
  return app;
}

function post(
  app: Awaited<ReturnType<typeof build>>,
  targetEventId: string,
  targetKind = 30023,
) {
  return app.inject({
    method: "POST",
    url: "/replies",
    payload: {
      nostrEventId: "f".repeat(64),
      targetEventId,
      targetKind,
      content: "A comment on a piece.",
    },
  });
}

beforeEach(() => {
  calls = [];
  accessCalls = [];
  accessAnswer = { hasAccess: false };
});

describe("POST /replies — the paywall guard (D7)", () => {
  it("403s a paywalled article for a reader without access", async () => {
    const app = await build();
    const res = await post(app, PAYWALLED_EVENT);
    expect(res.statusCode).toBe(403);
    // And it got there by ASKING, not by refusing everything paywalled.
    expect(accessCalls).toHaveLength(1);
    expect(accessCalls[0]).toEqual([READER, PAYWALLED_ARTICLE, WRITER, null]);
    // Nothing was written.
    expect(ran("INSERT INTO comments")).toBe(false);
    await app.close();
  });

  it("201s a paywalled article for a reader who HAS access", async () => {
    accessAnswer = { hasAccess: true };
    const app = await build();
    const res = await post(app, PAYWALLED_EVENT);
    expect(res.statusCode).toBe(201);
    expect(res.json().commentId).toBe(NEW_COMMENT);
    expect(accessCalls).toHaveLength(1);
    await app.close();
  });

  // THE ONE THAT CATCHES THE BARE CALL. With the guard written as an
  // unconditional `checkArticleAccess`, this reader — who is not the writer —
  // is refused, and so is every other commenter on every free article.
  it("201s a FREE article for a reader who is not its author, without asking the checker at all", async () => {
    const app = await build();
    const res = await post(app, FREE_EVENT);
    expect(res.statusCode).toBe(201);
    expect(res.json().commentId).toBe(NEW_COMMENT);
    expect(accessCalls).toHaveLength(0);
    expect(ran("INSERT INTO comments")).toBe(true);
    await app.close();
  });

  // The guard's ingredients ride on the FIRST article read, not a second one:
  // the widened SELECT is what makes the branch possible at all.
  it("the target read carries id, access_mode and publication_id", async () => {
    const app = await build();
    await post(app, FREE_EVENT);
    const target = calls.find(
      (c) => c.sql.includes("FROM articles") && c.sql.includes("WHERE nostr_event_id"),
    );
    expect(target).toBeDefined();
    expect(target!.sql).toContain("access_mode");
    expect(target!.sql).toContain("publication_id");
    await app.close();
  });
});

describe("POST /replies — the declared kind cannot choose the table (§2.7)", () => {
  it("guards a paywalled article even when the request calls it a note", async () => {
    // The squat, and the whole of §2.7: `POST /notes` takes the event id from
    // the client with no signer check, so an attacker mints a note under the
    // article's id and sends `targetKind: 1`. The old route branched on that
    // kind, read `notes`, and skipped the guard — landing the comment on the
    // paywalled article's conversation, with the `new_reply` notification going
    // to the squatter rather than the writer.
    const app = await build();
    const res = await post(app, PAYWALLED_EVENT, 1);

    expect(res.statusCode).toBe(403);
    expect(accessCalls).toHaveLength(1);
    expect(accessCalls[0]).toEqual([READER, PAYWALLED_ARTICLE, WRITER, null]);
    expect(ran("INSERT INTO comments")).toBe(false);
    await app.close();
  });

  it("reads articles first and never reaches the squattable table", async () => {
    const app = await build();
    await post(app, PAYWALLED_EVENT, 1);

    const tables = calls
      .filter((c) => c.sql.includes("WHERE nostr_event_id"))
      .map((c) => (c.sql.includes("FROM articles") ? "articles" : "other"));
    expect(tables[0]).toBe("articles");
    expect(ran("FROM notes")).toBe(false);
    await app.close();
  });

  it("persists the RESOLVED kind, not the claimed one", async () => {
    // `comments.target_kind` is read as a fact about the row it points at, so
    // storing the client's claim would record the squat's version for ever.
    accessAnswer = { hasAccess: true };
    const app = await build();
    await post(app, PAYWALLED_EVENT, 1);

    const insert = calls.find((c) => c.sql.includes("INSERT INTO comments"));
    expect(insert).toBeDefined();
    expect(insert!.params[3]).toBe(30023);
    await app.close();
  });
});

describe("POST /replies — the notification binds the RESOLVED target (S25)", () => {
  it("links the article when an honest reply declares kind 1 on it", async () => {
    // The honest mismatch S5 tolerates: a native reply is projected as
    // `type: "note"`, so its composer declares kind 1 for what is an article.
    // The guard and the INSERT already used the resolved row; the `new_reply`
    // notification's context lookup still branched on the declared kind, read
    // `notes`, found nothing, and wrote both reference columns NULL — right
    // recipient, no link. The reference must come off the resolver.
    const app = await build();
    const res = await post(app, FREE_EVENT, 1);
    expect(res.statusCode).toBe(201);

    const notification = calls.find(
      (c) => c.sql.includes("INSERT INTO notifications") && c.sql.includes("'new_reply'"),
    );
    expect(notification).toBeDefined();
    expect(notification!.params[2]).toBe(FREE_ARTICLE); // article_id
    expect(notification!.params[3]).toBeNull(); // note_id
    // …and it got there without a second, kind-keyed lookup: neither the
    // bare article SELECT nor the notes table was read after the insert.
    expect(ran("SELECT id FROM articles")).toBe(false);
    expect(ran("FROM notes")).toBe(false);
    await app.close();
  });
});

describe("POST /replies — a reply is not a reply TARGET", () => {
  it("400s a comment's event id, however it is declared", async () => {
    // `comments.target_event_id` is the CONVERSATION'S ROOT — replies-to-replies
    // share it and nest via `parentCommentId`, which the parent check enforces.
    // Accepting a comment here would mint a row whose target is not a root, and
    // every reader that assumes one would quietly stop finding it.
    const app = await build();
    const res = await post(app, EXISTING_COMMENT_EVENT, 1111);

    expect(res.statusCode).toBe(400);
    expect(res.json().error).toBe("target_is_reply");
    expect(ran("INSERT INTO comments")).toBe(false);
    await app.close();
  });

  it("refuses it when the request calls it a note, too", async () => {
    // The resolver ignores the declared kind, so the refusal cannot be dodged
    // by mis-declaring — which is the same property the guard relies on.
    const app = await build();
    const res = await post(app, EXISTING_COMMENT_EVENT, 1);

    expect(res.statusCode).toBe(400);
    expect(res.json().error).toBe("target_is_reply");
    await app.close();
  });
});
