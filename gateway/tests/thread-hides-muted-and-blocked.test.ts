import { describe, it, expect, vi } from "vitest";
import Fastify from "fastify";

// =============================================================================
// THE WORKSPACE THREAD HIDES WHAT THE ARTICLE PAGE HIDES (W2, walkthrough A7).
//
// `GET /thread/:postId` stamped `isMuted` on every comment and no card read it,
// so a muted member's remarks went on appearing in every workspace
// conversation; blocks were not applied there at all. The ruling put the hide
// in the PROJECTOR — the one home both the card and the count read — so a
// hidden comment is out of the page, the cursor and `totalDescendants`
// together.
//
// WHAT THIS PINS AND WHAT IT DOES NOT. The drop is JavaScript over the
// conversation (`assembleNativeThread`), so a mocked pool can test it honestly
// — IF the mock answers the hide-set query from its params rather than
// regardless of them, which it does (keyed on the viewer id). Which accounts
// belong IN that set is SQL (a UNION over both block directions and the
// viewer's mutes) and is pinned against real rows in `block-and-mute.test.ts`;
// here the set is a fixture, said out loud.
//
// MUTATION LOG (each applied, suite re-run, then reverted):
//   1. post-thread.ts: drop the `.filter(...)` on the subtree
//      ⇒ "a hidden author's comment is not in the page or the count" fails.
//                                                                    DETECTED
//   2. post-thread.ts: drop the `c.deleted_at !== null ||` term
//      ⇒ "a hidden author's DELETED comment still holds its place" fails.
//                                                                    DETECTED
// =============================================================================

const VIEWER = "00000000-0000-4000-8000-0000000000a1";
const WRITER = "00000000-0000-4000-8000-0000000000b2";
const HIDDEN = "00000000-0000-4000-8000-0000000000c3";
const OTHER = "00000000-0000-4000-8000-0000000000d4";

const ROOT_POST_ID = "2".repeat(64);
const ROOT_EVENT_ID = "3".repeat(64);
const HIDDEN_POST_ID = "4".repeat(64);
const REPLY_POST_ID = "5".repeat(64);
const DELETED_POST_ID = "6".repeat(64);

function comment(
  n: number,
  postId: string,
  author: string,
  opts: { parent?: { id: string; postId: string }; deleted?: boolean } = {},
) {
  return {
    id: `00000000-0000-4000-8000-00000000e00${n}`,
    derived_post_id: postId,
    nostr_event_id: String(n).repeat(64),
    parent_comment_id: opts.parent?.id ?? null,
    parent_post_id: opts.parent?.postId ?? null,
    target_event_id: ROOT_EVENT_ID,
    target_kind: 1,
    content: opts.deleted ? "gone" : `comment ${n}`,
    published_at_epoch: 1700000000 + n,
    deleted_at: opts.deleted ? new Date() : null,
    author_id: author,
    acc_display_name: null,
    acc_username: `u${n}`,
    nostr_pubkey: "f".repeat(64),
    pip_status: "known",
    vt_up: 0,
    vt_down: 0,
  };
}

// A hidden author's comment; a visible reply TO it (it must not be orphaned);
// the hidden author's deleted comment (the article page renders "[deleted]" for
// it, and so must this); and nothing by the viewer.
const CONVERSATION = [
  comment(7, HIDDEN_POST_ID, HIDDEN),
  comment(8, REPLY_POST_ID, OTHER, {
    parent: { id: "00000000-0000-4000-8000-00000000e007", postId: HIDDEN_POST_ID },
  }),
  comment(9, DELETED_POST_ID, HIDDEN, { deleted: true }),
];

function noteRow() {
  return {
    post_id: ROOT_POST_ID,
    item_type: "note",
    access_mode: "free",
    source_protocol: "nostr",
    nostr_event_id: ROOT_EVENT_ID,
    author_id: WRITER,
    acc_display_name: "Wren",
    acc_username: "wren",
    published_at_epoch: 1700000000,
    media: [],
  };
}

function scriptedQuery(sql: string, params: unknown[] = []) {
  // The comment's conversation root, read through its own feed_items card
  // (CA-G5). Matched first: its SQL also carries `WHERE fi.post_id = $1`.
  if (sql.includes("SELECT c.target_event_id") && sql.includes("fi.comment_id")) {
    return Promise.resolve({ rows: [{ target_event_id: ROOT_EVENT_ID }], rowCount: 1 });
  }
  if (sql.includes("WHERE fi.post_id = $1")) {
    return Promise.resolve(
      params[0] === ROOT_POST_ID
        ? { rows: [noteRow()], rowCount: 1 }
        : { rows: [], rowCount: 0 },
    );
  }
  if (sql.includes("SELECT post_id FROM feed_items")) {
    return Promise.resolve({ rows: [{ post_id: ROOT_POST_ID }], rowCount: 1 });
  }
  if (sql.includes("FROM comments c") && sql.includes("ORDER BY c.published_at ASC")) {
    return Promise.resolve({
      rows: CONVERSATION.map((c) => ({ ...c })),
      rowCount: CONVERSATION.length,
    });
  }
  // The viewer's hide set — a FIXTURE (see the header), but answered from the
  // param: a different viewer hides nobody.
  if (sql.includes("FROM mutes WHERE muter_id = $1") && sql.includes("UNION")) {
    return Promise.resolve(
      params[0] === VIEWER
        ? { rows: [{ id: HIDDEN }], rowCount: 1 }
        : { rows: [], rowCount: 0 },
    );
  }
  return Promise.resolve({ rows: [], rowCount: 0 });
}

vi.mock("@platform-pub/shared/db/client.js", () => ({
  pool: { query: (sql: string, params: unknown[] = []) => scriptedQuery(sql, params) },
  withTransaction: (cb: (c: { query: typeof scriptedQuery }) => Promise<unknown>) =>
    cb({ query: scriptedQuery }),
}));
vi.mock("@platform-pub/shared/lib/logger.js", () => ({
  default: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));
let sessionSub: string | null = VIEWER;
vi.mock("../src/middleware/auth.js", () => ({
  requireAuth: async (req: { session?: { sub: string } }) => {
    req.session = { sub: VIEWER };
  },
  optionalAuth: async (req: { session?: { sub: string } }) => {
    if (sessionSub) req.session = { sub: sessionSub };
  },
}));
vi.mock("../src/services/article-access/index.js", () => ({
  checkArticleAccess: async () => ({ hasAccess: true }),
}));

const { postThreadRoutes } = await import("../src/routes/post-thread.js");

async function thread(postId: string) {
  const app = Fastify();
  await app.register(postThreadRoutes);
  const res = await app.inject({ url: `/thread/${postId}` });
  await app.close();
  return res.json() as { focalId: string; posts: { id: string }[]; totalDescendants: number };
}

describe("GET /thread/:postId — hidden authors (W2)", () => {
  it("a hidden author's comment is not in the page or the count, and its replies stay", async () => {
    sessionSub = VIEWER;
    const body = await thread(ROOT_POST_ID);
    const ids = body.posts.map((p) => p.id);
    expect(ids).not.toContain(HIDDEN_POST_ID);
    expect(ids).toContain(REPLY_POST_ID);
    expect(body.totalDescendants).toBe(2);
  });

  it("a hidden author's DELETED comment still holds its place, as on the article page", async () => {
    sessionSub = VIEWER;
    const ids = (await thread(ROOT_POST_ID)).posts.map((p) => p.id);
    expect(ids).toContain(DELETED_POST_ID);
  });

  it("the control: an anonymous reader hides nobody", async () => {
    sessionSub = null;
    const body = await thread(ROOT_POST_ID);
    expect(body.posts.map((p) => p.id)).toContain(HIDDEN_POST_ID);
    expect(body.totalDescendants).toBe(3);
  });

  it("a hidden comment opened ON PURPOSE is still the focal", async () => {
    sessionSub = VIEWER;
    const body = await thread(HIDDEN_POST_ID);
    expect(body.focalId).toBe(HIDDEN_POST_ID);
    expect(body.posts.map((p) => p.id)).toContain(HIDDEN_POST_ID);
  });
});
