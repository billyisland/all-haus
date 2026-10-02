import { describe, it, expect, vi, beforeEach } from "vitest";
import Fastify from "fastify";

// =============================================================================
// QUOTING SOMEBODY'S REPLY TOLD NOBODY.
//
// `POST /notes` resolved the quoted author with two hand-written lookups —
// `notes`, then `articles` — and never `comments`. Quote is mounted on every
// thread card the product draws (`PostActions`, all tiers), and a comment is
// projected as a Post carrying its own event id, so quoting a reply was a fully
// reachable act that produced a `new_quote` notification for nobody at all.
//
// It was also the §2.7 search order upside down. `notes` is the ONE table whose
// `nostr_event_id` is attacker-chosen, and it was being asked FIRST — so a note
// planted under an article's event id decided who was told they had been
// quoted. `resolveEventTarget` is the one home and searches articles, then
// comments, then the squattable table last; it carries `authorId` for all
// three, which is the whole of what this site needs.
//
// AND THE LOOKUP MOVED INSIDE THE TRY. It sat outside, under the route's own
// catch, which returns 500 — for a note that is already indexed AND already
// published to the relay. The mention block one statement below had the same
// bug and had already been fixed; this is the other copy. The last test drives
// it, because "fire-and-forget" is a claim about a catch block and only a
// throwing fixture can check it.
// =============================================================================

const AUTHOR = "00000000-0000-4000-8000-0000000000a1";
const COMMENT_AUTHOR = "00000000-0000-4000-8000-0000000000b2";
const ARTICLE_AUTHOR = "00000000-0000-4000-8000-0000000000c3";
const NOTE_AUTHOR = "00000000-0000-4000-8000-0000000000d4";

const QUOTED_COMMENT_EVENT = "c".repeat(64);
const QUOTED_ARTICLE_EVENT = "a".repeat(64);
const QUOTED_NOTE_EVENT = "n".repeat(64);
const MY_EVENT = "f".repeat(64);

let calls: Array<{ sql: string; params: unknown[] }> = [];
// Set to make the quoted-author resolution throw, for the last test.
let breakResolution = false;

function scriptedQuery(sql: string, params: unknown[] = []) {
  calls.push({ sql, params });

  if (sql.includes("FROM articles") && sql.includes("UNION ALL")) {
    return Promise.resolve({ rows: [], rowCount: 0 });
  }
  if (sql.includes("INSERT INTO notes")) {
    return Promise.resolve({ rows: [{ id: "note-1" }], rowCount: 1 });
  }
  if (sql.includes("FROM accounts")) {
    return Promise.resolve({
      rows: [{ display_name: "A", avatar_blossom_url: null, username: "a" }],
      rowCount: 1,
    });
  }

  // ── the resolver's three legs, each answered from its own param ──────────
  if (sql.includes("FROM articles") && sql.includes("access_mode")) {
    if (breakResolution) return Promise.reject(new Error("db down"));
    return Promise.resolve({
      rows:
        params[0] === QUOTED_ARTICLE_EVENT
          ? [
              {
                id: "art-1",
                writer_id: ARTICLE_AUTHOR,
                comments_enabled: true,
                access_mode: "public",
                publication_id: null,
              },
            ]
          : [],
      rowCount: params[0] === QUOTED_ARTICLE_EVENT ? 1 : 0,
    });
  }
  if (sql.includes("FROM comments") && sql.includes("WHERE nostr_event_id")) {
    return Promise.resolve({
      rows:
        params[0] === QUOTED_COMMENT_EVENT
          ? [
              {
                id: "comment-1",
                author_id: COMMENT_AUTHOR,
                target_event_id: QUOTED_ARTICLE_EVENT,
              },
            ]
          : [],
      rowCount: params[0] === QUOTED_COMMENT_EVENT ? 1 : 0,
    });
  }
  if (sql.includes("FROM notes WHERE nostr_event_id")) {
    return Promise.resolve({
      rows:
        params[0] === QUOTED_NOTE_EVENT
          ? [{ id: "note-0", author_id: NOTE_AUTHOR, comments_enabled: true }]
          : [],
      rowCount: params[0] === QUOTED_NOTE_EVENT ? 1 : 0,
    });
  }

  return Promise.resolve({ rows: [], rowCount: 0 });
}

vi.mock("@platform-pub/shared/db/client.js", () => ({
  pool: { query: (sql: string, p: unknown[] = []) => scriptedQuery(sql, p) },
  withTransaction: (
    cb: (c: { query: typeof scriptedQuery }) => Promise<unknown>,
  ) => cb({ query: scriptedQuery }),
}));

vi.mock("@platform-pub/shared/lib/logger.js", () => ({
  default: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

vi.mock("../src/lib/mentions.js", () => ({
  resolveMentionedAccountIds: async () => [],
}));

vi.mock("../src/middleware/auth.js", () => ({
  requireAuth: async (req: { session?: { sub: string } }) => {
    req.session = { sub: AUTHOR };
  },
}));

const { noteRoutes } = await import("../src/routes/notes.js");

async function build() {
  const app = Fastify();
  await app.register(noteRoutes);
  return app;
}

function quote(
  app: Awaited<ReturnType<typeof build>>,
  quotedEventId: string,
  quotedEventKind = 1,
) {
  return app.inject({
    method: "POST",
    url: "/notes",
    payload: {
      nostrEventId: MY_EVENT,
      content: "worth reading",
      isQuoteComment: true,
      quotedEventId,
      quotedEventKind,
    },
  });
}

function quoteNotifications(): Array<unknown[]> {
  return calls
    .filter(
      (c) =>
        c.sql.includes("INSERT INTO notifications") &&
        c.sql.includes("new_quote"),
    )
    .map((c) => c.params);
}

beforeEach(() => {
  calls = [];
  breakResolution = false;
});

describe("POST /notes — who is told they were quoted", () => {
  it("tells the author of a quoted COMMENT (the case that told nobody)", async () => {
    const app = await build();
    expect((await quote(app, QUOTED_COMMENT_EVENT)).statusCode).toBe(201);
    const rows = quoteNotifications();
    expect(rows).toHaveLength(1);
    // (recipient, actor, note) — the note is the one doing the quoting.
    expect(rows[0][0]).toBe(COMMENT_AUTHOR);
    expect(rows[0][1]).toBe(AUTHOR);
    await app.close();
  });

  it("CONTROL: an article is still resolved, and to its writer", async () => {
    const app = await build();
    expect((await quote(app, QUOTED_ARTICLE_EVENT, 30023)).statusCode).toBe(201);
    const rows = quoteNotifications();
    expect(rows).toHaveLength(1);
    expect(rows[0][0]).toBe(ARTICLE_AUTHOR);
    await app.close();
  });

  it("CONTROL: a note is still resolved, and to its author", async () => {
    const app = await build();
    expect((await quote(app, QUOTED_NOTE_EVENT)).statusCode).toBe(201);
    const rows = quoteNotifications();
    expect(rows).toHaveLength(1);
    expect(rows[0][0]).toBe(NOTE_AUTHOR);
    await app.close();
  });

  it("asks the squattable table LAST", async () => {
    // Order is the guard, not a preference: the arm that can be planted must
    // only ever be reached once the two that cannot have both declined. Read
    // off the calls the route actually made, in the order it made them.
    const app = await build();
    await quote(app, QUOTED_NOTE_EVENT);
    const legs = calls
      .map((c) => c.sql)
      // `eventIdIsTaken`'s collision check is one statement naming articles
      // AND comments, and it runs before any of this — excluded by its
      // UNION, or it counts as a leg it is not.
      .filter((sql) => !sql.includes("UNION ALL"))
      .filter(
        (sql) =>
          (sql.includes("FROM articles") && sql.includes("access_mode")) ||
          (sql.includes("FROM comments") && sql.includes("WHERE nostr_event_id")) ||
          sql.includes("FROM notes WHERE nostr_event_id"),
      );
    expect(legs).toHaveLength(3);
    expect(legs[0]).toContain("FROM articles");
    expect(legs[1]).toContain("FROM comments");
    expect(legs[2]).toContain("FROM notes");
    await app.close();
  });

  it("a failed lookup does not 500 a note that is already published", async () => {
    // The note is indexed and on the relay by the time this runs. Answering
    // 500 tells the client the publish failed, and the only honest thing left
    // to lose is the notification.
    breakResolution = true;
    const app = await build();
    const res = await quote(app, QUOTED_COMMENT_EVENT);
    expect(res.statusCode).toBe(201);
    expect(quoteNotifications()).toHaveLength(0);
    await app.close();
  });

  it("never notifies you about your own quote of yourself", async () => {
    const app = await build();
    // The resolver answers with AUTHOR for this one.
    calls = [];
    const res = await app.inject({
      method: "POST",
      url: "/notes",
      payload: {
        nostrEventId: MY_EVENT,
        content: "quoting myself",
        isQuoteComment: true,
        quotedEventId: "z".repeat(64), // resolves to nothing at all
        quotedEventKind: 1,
      },
    });
    expect(res.statusCode).toBe(201);
    expect(quoteNotifications()).toHaveLength(0);
    await app.close();
  });
});
