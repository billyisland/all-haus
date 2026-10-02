import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import path from "node:path";

import { getDest } from "../src/lib/notifications/dest";
import type { Notification } from "../src/lib/api/notifications";
import { commentIdFromAnchor } from "../src/lib/post/reply-anchor";

// =============================================================================
// A NESTED REPLY MAKES TWO NOTIFICATIONS AND THEY MUST NOT READ ALIKE.
//
// `POST /replies` now tells the author of the comment that was replied to as
// well as the author of the piece (migration 230). The two rows carry the same
// actor, the same article and the same `comment_id` — on both, `comment_id` is
// the NEW reply — so the ONLY thing that says which is which is
// `parentComment`, bound on one and null on the other. Read it and the panel
// says "replied to your comment"; ignore it and both people are told somebody
// replied to the piece, which for the commenter names something they did not
// write.
//
// A HAND-WRITTEN RESPONSE INTERFACE IS A CLAIM ABOUT A SERVER THAT NOTHING
// CHECKS. There is no module path between the workspaces, so `tsc` is happy
// with a client field the gateway does not send and with a gateway field the
// client never reads — either way the sentence silently reverts to the wrong
// one, and nothing anywhere goes red. So the field name is PINNED by reading
// the gateway's own source, and each pin asserts its match was FOUND.
//
// The destination half is behavioural, because it is the half with a live
// branch in it and the half that would strand a reader on a page that is not
// the conversation they were told about.
// =============================================================================

const GATEWAY = path.resolve(__dirname, "..", "..", "gateway", "src");
const readGateway = (rel: string) =>
  readFileSync(path.join(GATEWAY, rel), "utf8");

function makeReply(overrides: Partial<Notification> = {}): Notification {
  return {
    id: "n1",
    type: "new_reply",
    read: false,
    createdAt: new Date().toISOString(),
    actor: { id: "a1", username: "ada", displayName: "Ada", avatar: null },
    article: null,
    note: null,
    comment: { id: "new-reply-uuid", content: "a remark" },
    parentComment: null,
    publication: null,
    focus: { postId: "p".repeat(64), view: "replies" },
    ...overrides,
  } as Notification;
}

const ARTICLE = {
  id: "art",
  title: "A Piece",
  slug: "ada-a-piece",
  writerUsername: "ada",
};

describe("where a reply notification takes you", () => {
  it("a reply to your COMMENT on an article opens that article at the reply", () => {
    const dest = getDest(
      makeReply({
        article: ARTICLE,
        parentComment: { id: "parent-uuid" },
      }),
    );
    expect(dest.kind).toBe("url");
    // The NEW reply's anchor, never the parent's — the recipient wrote the
    // parent and does not need taking to it.
    const href = (dest as { href: string }).href;
    expect(href).toBe("/article/ada-a-piece#reply-new-reply-uuid");
    // And the anchor PARSES back to that comment: nothing renders it as a DOM
    // id any more, so the page's ReplySection and the pane's routeToOverlay
    // both read it through this one function.
    expect(commentIdFromAnchor(href)).toBe("new-reply-uuid");
  });

  it("a reply inside a NOTE conversation opens the pane on the reply", () => {
    const dest = getDest(makeReply({ parentComment: { id: "parent-uuid" } }));
    expect(dest.kind).toBe("profile");
    expect((dest as { focus: { view: string } | null }).focus?.view).toBe(
      "replies",
    );
  });

  it("CONTROL: the piece author's copy still goes where it always did", () => {
    expect(getDest(makeReply({ article: ARTICLE }))).toEqual(
      getDest(makeReply({ article: ARTICLE, parentComment: { id: "x" } })),
    );
  });
});

describe("WIRE PIN — parentComment, both ends", () => {
  it("the route BINDS it, in the notification insert's column list", () => {
    const replies = readGateway("routes/replies.ts");
    const insert = replies
      .replace(/\s+/g, " ")
      .match(/INSERT INTO notifications \(([^)]+)\)/);
    expect(insert).not.toBeNull();
    expect(insert![1]).toContain("parent_comment_id");
    // And the row it is bound on is the one whose recipient is the parent's
    // author — the route builds that list rather than branching twice.
    expect(replies).toContain("parentCommentId: data.parentCommentId");
  });

  it("the read route SELECTS it and the mapper NAMES it as this client reads it", () => {
    const route = readGateway("routes/notifications.ts");
    expect(route).toContain("n.parent_comment_id");
    const mapped = route.match(/parentComment: [^\n]+/);
    expect(mapped).not.toBeNull();
    expect(mapped![0]).toContain("r.parent_comment_id");
  });

  it("STRUCTURAL PIN — the panel picks its sentence off that field", () => {
    // Not behavioural: `NotificationRow` is not exported and the branch is one
    // ternary inside a JSX tree. What is asserted is that the branch EXISTS —
    // its absence is the whole defect, and it is invisible to every other gate
    // the repo has. The words themselves are read back off the screen, which
    // is the only thing that can check copy.
    const panel = readFileSync(
      path.resolve(
        __dirname,
        "..",
        "src",
        "content",
        "notifications.ts",
      ),
      "utf8",
    );
    expect(panel).toContain("? { verb: ' replied to your comment'");
  });
});
