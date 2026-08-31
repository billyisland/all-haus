import { describe, it, expect } from "vitest";
import { reducer, INITIAL, type State } from "./usePostThread";
import type { PostThreadResponse } from "../lib/api/post";
import type { Post } from "../lib/post/types";

// =============================================================================
// Re-root vs quote-jump — the "↑ Full conversation" seniority split.
//
// An intra-conversation re-root (ancestor/reply click, `set-focal`) moves ONLY
// the focal: rootId stays on the opened item, so PostThread's `!atRoot` renders
// "↑ Full conversation" back to it. A quote-tile click (`set-root`) jumps to a
// DIFFERENT conversation, so root and focal move together — the quoted post
// opens with full seniority and no residue pointing at the quoting host
// (parity with the feed-level expandQuote grammar). These tests pin the
// reducer directly: the web suite has no DOM rig, and the wiring itself
// (PostThread → rerootAsRoot) is browser-verified.
// =============================================================================

function post(id: string): Post {
  // Only identity matters to the transitions under test.
  return { id } as unknown as Post;
}

function res(focalId: string, posts: Post[] = []): PostThreadResponse {
  return { focalId, posts, repostEdges: [], totalDescendants: 0 };
}

// A thread opened on "host" (the root ingest sets rootId = focalId = host).
function openedOnHost(): State {
  return reducer(
    reducer(INITIAL, { kind: "init-start" }),
    { kind: "ingest", res: res("host", [post("host"), post("reply")]), root: true },
  );
}

describe("re-root vs quote-jump (rootId seniority)", () => {
  it("root ingest anchors root and focal on the opened item", () => {
    const s = openedOnHost();
    expect(s.rootId).toBe("host");
    expect(s.focalId).toBe("host");
  });

  it("set-focal (ancestor/reply re-root) keeps rootId — the link renders", () => {
    const s = reducer(openedOnHost(), { kind: "set-focal", id: "reply" });
    expect(s.focalId).toBe("reply");
    expect(s.rootId).toBe("host"); // !atRoot → "↑ Full conversation" shows
  });

  it("set-root (quote-jump) moves root AND focal — no residue of the host", () => {
    const s = reducer(openedOnHost(), { kind: "set-root", id: "quoted" });
    expect(s.focalId).toBe("quoted");
    expect(s.rootId).toBe("quoted"); // atRoot → no "↑ Full conversation"
  });

  it("a later non-root ingest never re-anchors a quote-jumped root", () => {
    const jumped = reducer(openedOnHost(), { kind: "set-root", id: "quoted" });
    const s = reducer(jumped, {
      kind: "ingest",
      res: res("quoted", [post("quoted"), post("q-reply")]),
    });
    expect(s.rootId).toBe("quoted");
    expect(s.focalId).toBe("quoted");
  });
});

describe("reroot-failed reverts", () => {
  it("a failed quote-jump (target never fetched) restores focal AND root", () => {
    const jumped = reducer(openedOnHost(), { kind: "set-root", id: "quoted" });
    // "quoted" is not in the pool (the /thread fetch failed), so revert both.
    const s = reducer(jumped, {
      kind: "reroot-failed",
      revertTo: "host",
      revertRootTo: "host",
    });
    expect(s.focalId).toBe("host");
    expect(s.rootId).toBe("host");
  });

  it("a failed intra-thread re-root leaves rootId alone (no revertRootTo)", () => {
    const rerooted = reducer(openedOnHost(), { kind: "set-focal", id: "gone" });
    const s = reducer(rerooted, { kind: "reroot-failed", revertTo: "host" });
    expect(s.focalId).toBe("host");
    expect(s.rootId).toBe("host");
  });

  it("keeps the jump when the target is renderable (only its reply page failed)", () => {
    // The quoted post IS in the pool (e.g. cached) — the view renders, so the
    // user's click is kept: focal and root both stay on the quoted post.
    const withQuoted = reducer(openedOnHost(), {
      kind: "ingest",
      res: res("host", [post("quoted")]),
    });
    const jumped = reducer(withQuoted, { kind: "set-root", id: "quoted" });
    const s = reducer(jumped, {
      kind: "reroot-failed",
      revertTo: "host",
      revertRootTo: "host",
    });
    expect(s.focalId).toBe("quoted");
    expect(s.rootId).toBe("quoted");
  });
});
