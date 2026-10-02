import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import path from "node:path";

import { replyTargetFromPost } from "../src/lib/post/reply-target";
import type { Post } from "../src/lib/post/types";

// =============================================================================
// REPLYING TO A REPLY — the address is the conversation, not the remark.
//
// `POST /replies` takes the conversation's ROOT as its target and nests with
// `parentCommentId`; a comment sent as the target is refused, 400
// `target_is_reply`. A native comment reaches the browser as a Post of
// `type: "note"` carrying its OWN event id in `version`, so until the gateway
// started stamping `conversation` there was nothing on the shape to tell the
// two apart — and `replyTargetFromPost` addressed every reply at the comment
// it was replying to. Every card in every thread offered Reply; every one of
// those replies came back 400, after the event had already been signed and
// published to the relay. The article page's own `ReplySection` was unaffected
// throughout: it threads the article's event id and passes the comment's uuid,
// which is the arrangement this restores for the card path.
//
// The first half is behavioural over the one home. The second is a WIRE PIN
// and says so: `conversation` crosses the web↔gateway boundary, there is no
// module path between the workspaces, and a field renamed on one side is
// invisible to `tsc` on the other — it reappears as the same 400. Each pin
// asserts its match was FOUND, so a moved constant fails rather than passing
// by matching nothing.
// =============================================================================

const GATEWAY = path.resolve(__dirname, "..", "..", "gateway", "src");
const readGateway = (rel: string) =>
  readFileSync(path.join(GATEWAY, rel), "utf8");

function makePost(overrides: Partial<Post> = {}): Post {
  return {
    id: "post-1",
    version: "event-1",
    type: "note",
    author: {
      id: "a1",
      accountId: "a1",
      displayName: "Ada",
      handle: "ada",
      handleUri: null,
      pubkey: "pk-ada",
      pipStatus: "unknown",
    },
    body: { text: "the body" },
    ...overrides,
  } as unknown as Post;
}

/** A comment as the thread projector serves one: a note-typed Post that says
 *  which conversation it is a remark inside. */
function makeComment(overrides: Partial<Post> = {}): Post {
  return makePost({
    id: "comment-post-id",
    version: "comment-event",
    conversation: {
      rootEventId: "root-event",
      rootKind: 30023,
      commentId: "comment-uuid",
    },
    ...overrides,
  });
}

describe("replyTargetFromPost — a reply to a comment", () => {
  it("threads under the conversation's ROOT, never the comment", () => {
    const t = replyTargetFromPost(makeComment())!;
    expect(t.eventId).toBe("root-event");
    // The whole defect in one assertion: the comment's own event is what the
    // gateway refuses as a target.
    expect(t.eventId).not.toBe("comment-event");
  });

  it("declares the ROOT's kind, not the note-shaped projection's", () => {
    expect(replyTargetFromPost(makeComment())!.eventKind).toBe(30023);
    expect(
      replyTargetFromPost(
        makeComment({
          conversation: {
            rootEventId: "root-event",
            rootKind: 1,
            commentId: "comment-uuid",
          },
        }),
      )!.eventKind,
    ).toBe(1);
  });

  it("nests by the comment's row id and tags its event", () => {
    const t = replyTargetFromPost(makeComment())!;
    // The index linkage the route checks against the target...
    expect(t.parentCommentId).toBe("comment-uuid");
    // ...and the NIP-10 `e` reply tag, which is the comment's own event.
    expect(t.parentCommentEventId).toBe("comment-event");
  });

  it("still names the COMMENT's author — that is who is being replied to", () => {
    const t = replyTargetFromPost(makeComment())!;
    expect(t.authorPubkey).toBe("pk-ada");
    expect(t.authorName).toBe("Ada");
  });
});

describe("replyTargetFromPost — a reply to a THING is unchanged", () => {
  // The control. A guard written for the nested case that also rewrites the
  // top-level one would break every reply on the platform, and a suite made
  // only of comments would go green against it.
  it("threads under the post's own event and nests under nothing", () => {
    const t = replyTargetFromPost(makePost())!;
    expect(t.eventId).toBe("event-1");
    expect(t.eventKind).toBe(1);
    expect(t.parentCommentId).toBeUndefined();
    expect(t.parentCommentEventId).toBeUndefined();
  });

  it("an article target keeps kind 30023", () => {
    expect(replyTargetFromPost(makePost({ type: "article" }))!.eventKind).toBe(
      30023,
    );
  });

  it("an external post is still no target at all", () => {
    expect(
      replyTargetFromPost(
        makePost({ author: { ...makePost().author, pubkey: null } } as Partial<Post>),
      ),
    ).toBeNull();
  });
});

describe("WIRE PIN — the field, and the refusal it exists to avoid", () => {
  it("the gateway stamps `conversation` with the three keys this reads", () => {
    const mapper = readGateway("lib/post-mapper.ts");
    const stamp = mapper
      .replace(/\s+/g, " ")
      .match(/conversation: \{ rootEventId: [^}]+\}/);
    // FOUND, not merely matched: a renamed field would otherwise make this
    // suite pass by testing nothing.
    expect(stamp).not.toBeNull();
    expect(stamp![0]).toContain("rootEventId");
    expect(stamp![0]).toContain("rootKind");
    expect(stamp![0]).toContain("commentId");
  });

  it("`POST /replies` still refuses a comment as a target", () => {
    // If this refusal is ever relaxed the branch above becomes decoration —
    // but the signed event's own `root` tag would still be pointing at a
    // comment, so the client must go on addressing the root regardless.
    const route = readGateway("routes/replies.ts");
    expect(route).toContain("target.kind === 1111");
    expect(route).toContain('error: "target_is_reply"');
  });
});
