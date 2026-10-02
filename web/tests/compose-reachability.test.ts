import { describe, it, expect, beforeEach } from "vitest";
import { readFileSync, readdirSync } from "node:fs";
import path from "node:path";

import { useCompose } from "../src/stores/compose";
import { replyTargetFromPost } from "../src/lib/post/reply-target";
import type { Post } from "../src/lib/post/types";

// =============================================================================
// WHERE A SHORT-FORM POST IS WRITTEN, AND BY WHICH PUBLISHER.
//
// A NOTE and a QUOTE are new top-level posts: the surface that raises one asks
// `useCompose`, because it cannot know which of the two Glasshouse composers is
// up — the workspace `Composer` on the floor, the global `ComposeOverlay` off
// it. A REPLY is not one of those and no longer travels through the store at
// all: it is written IN SITU in the card's own footer (`NativeReplyBox`,
// mounted by `PostCardInteractive`), so there is no request to route and no
// mount to miss.
//
// Both of the faults this suite was written for came from that arrangement
// being wrong, and neither could be seen from the screen:
//
//   1. NOBODY WAS LISTENING. `LayoutShell` mounted the overlay only for
//      `mode === 'platform' && !overlayOpen`, and `WorkspaceView` bridged only
//      mode `note` — while every surface that actually asks (a profile, an
//      author, a tag, a source, the article page) is a CANVAS route or an
//      overlay body over one. Five Reply buttons and the article page's Quote
//      set store state no renderer read. They did nothing at all, in silence,
//      which is why nobody found the second fault:
//
//   2. THE PUBLISHER WAS THE WRONG ONE. The store had one target field, of the
//      QUOTE's shape, so `ComposeOverlay`'s reply mode handed it to
//      `publishNote` — a NIP-18 `q` tag and `isQuoteComment`. Pressing Reply
//      would have published a quote: a new top-level note joining no
//      conversation.
//
// The five Reply buttons are what moved in situ; the pins below hold the new
// arrangement in place, which is a strictly smaller one — one card component
// owns the act, and no host can wire it wrongly because no host wires it.
//
// The store and mapper suites are behavioural. The rest are STRUCTURAL PINS
// and say so: what they hold is a branch inside a component, a boolean in a
// shell and the ABSENCE of a call across the tree — things that would take a
// live session and a layout engine to exercise. They assert the SHAPE of the
// source, in the same register as `href-guard` next door. A comment cannot
// fail; these can.
// =============================================================================

const SRC = path.resolve(__dirname, "..", "src");
const read = (rel: string) => readFileSync(path.join(SRC, rel), "utf8");

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
    body: { text: "the body of the note" },
    ...overrides,
  } as unknown as Post;
}

describe("useCompose — two channels, and neither of them is reply", () => {
  beforeEach(() => {
    useCompose.getState().close();
  });

  it("openQuote carries a quote target", () => {
    useCompose.getState().openQuote({
      eventId: "e2",
      eventKind: 30023,
      authorPubkey: "pk",
    });
    const s = useCompose.getState();
    expect(s.isOpen).toBe(true);
    expect(s.mode).toBe("quote");
    expect(s.quoteTarget?.eventId).toBe("e2");
  });

  it("openNote carries no target at all", () => {
    useCompose.getState().openQuote({
      eventId: "e2",
      eventKind: 1,
      authorPubkey: "pk",
    });
    useCompose.getState().openNote();
    // A composer reading a stale quote target beside a note request would
    // publish the quote — `Composer` checks `isQuote` first.
    expect(useCompose.getState().mode).toBe("note");
    expect(useCompose.getState().quoteTarget).toBeNull();
  });

  it("close clears the target", () => {
    useCompose.getState().openQuote({
      eventId: "e2",
      eventKind: 1,
      authorPubkey: "pk",
    });
    useCompose.getState().close();
    expect(useCompose.getState().isOpen).toBe(false);
    expect(useCompose.getState().quoteTarget).toBeNull();
  });

  it("a SUSPENDED quote resumes as a quote on a plain openNote", () => {
    // A supersede keeps the draft (web-overlays.md › *A supersede is not a
    // discard*); pressing New note afterwards is coming back for it, and the
    // text was written about the quote.
    useCompose.getState().openQuote({ eventId: "e3", eventKind: 1, authorPubkey: "pk" });
    useCompose.getState().suspend();
    expect(useCompose.getState().isOpen).toBe(false);
    useCompose.getState().openNote();
    const s = useCompose.getState();
    expect(s.isOpen).toBe(true);
    expect(s.mode).toBe("quote");
    expect(s.quoteTarget?.eventId).toBe("e3");
    // …once: the resume spends the suspension.
    useCompose.getState().close();
    useCompose.getState().openNote();
    expect(useCompose.getState().quoteTarget).toBeNull();
  });

  it("an explicit openQuote after a suspend takes ITS target", () => {
    useCompose.getState().openQuote({ eventId: "e3", eventKind: 1, authorPubkey: "pk" });
    useCompose.getState().suspend();
    useCompose.getState().openQuote({ eventId: "e4", eventKind: 1, authorPubkey: "pk" });
    expect(useCompose.getState().quoteTarget?.eventId).toBe("e4");
  });

  it("has no reply channel to publish down", () => {
    // The channel is gone, not merely unused: an `openReply` left standing
    // with no composer reading `mode === "reply"` is fault 1 again, and the
    // store is where it would be reintroduced.
    const s = useCompose.getState() as unknown as Record<string, unknown>;
    expect(s.openReply).toBeUndefined();
    expect(s.replyTarget).toBeUndefined();
  });
});

describe("replyTargetFromPost — the one home, and its own gate", () => {
  it("refuses a post with no author pubkey (an external post is not repliable)", () => {
    expect(
      replyTargetFromPost(
        makePost({
          author: { ...makePost().author, pubkey: null },
        } as Partial<Post>),
      ),
    ).toBeNull();
  });

  it("threads under the EVENT id, not the post id", () => {
    // `version` is the nostr event id; `id` is the deterministic post_id, which
    // is not a thing any relay can be replied to.
    expect(replyTargetFromPost(makePost())?.eventId).toBe("event-1");
    expect(
      replyTargetFromPost(makePost({ version: null }))?.eventId,
    ).toBe("post-1");
  });

  it("carries the kind the target actually is", () => {
    expect(replyTargetFromPost(makePost())?.eventKind).toBe(1);
    expect(
      replyTargetFromPost(makePost({ type: "article" }))?.eventKind,
    ).toBe(30023);
  });

  it("names the author, so the banner does not read 'Replying to '", () => {
    expect(replyTargetFromPost(makePost())?.authorName).toBe("Ada");
  });

  it("falls back to the handle, as the byline does — never a hook import", () => {
    const nameless = makePost({
      author: { ...makePost().author, displayName: null, handle: "ada" },
    } as Partial<Post>);
    expect(replyTargetFromPost(nameless)?.authorName).toBe("ada");
    // Pure, so the server-rendered register can build the same target.
    expect(read("lib/post/reply-target.ts")).not.toMatch(/from\s+["'][^"']*hooks\//);
  });
});

describe("STRUCTURAL PIN — the composer mounts off the workspace", () => {
  // Not behavioural: `LayoutShell`'s gate is a boolean over four stores and a
  // URL, and what went wrong was its TERMS, not a value any render produces.
  const shell = read("components/layout/LayoutShell.tsx");
  const gate =
    shell
      .split("\n")
      .find((l) => l.includes("const composeMounted =")) ?? "";

  it("gates on the workspace's own mount flag", () => {
    expect(gate).toContain("workspaceMounted");
  });

  it("does NOT exclude canvas routes or an open pane overlay", () => {
    // The two terms that made every profile/tag/source/article compose request
    // inert. `overlayOpen` is true for exactly the surfaces that ask.
    expect(gate).not.toContain("'platform'");
    expect(gate).not.toContain("overlayOpen");
  });

  it("the workspace bridges the quote mode, not note alone", () => {
    const view = read("components/workspace/WorkspaceView.tsx");
    const bridge = view.slice(
      view.indexOf("const composeReqOpen"),
      view.indexOf("const [quoteTarget, setQuoteTarget]"),
    );
    expect(bridge).toContain('composeReqMode === "quote"');
  });
});

describe("STRUCTURAL PIN — the workspace composer SUSPENDS on a supersede", () => {
  // Its host's close clears the quote target, so a supersede routed through
  // it brought an unsent quote back as a note (W4's open item, 2026-09-25).
  it("hands the supersede to onSuspend, never onClose", () => {
    const src = read("components/workspace/Composer.tsx");
    expect(src).toContain("onSupersede={() => c.onSupersede(onSuspend)}");
    expect(src).not.toContain("c.onSupersede(onClose)");
  });

  it("the host's plain reopens go through the one resume-aware opener", () => {
    const src = read("components/workspace/WorkspaceView.tsx");
    expect(src).toMatch(/onSuspend=\{\(\) => \{\s*composerSuspendedRef\.current = true;/);
    // No plain reopen clears the target by hand any more.
    expect(src).not.toMatch(/setQuoteTarget\(null\);\s*setComposerOpen\("note"\)/);
  });
});

describe("STRUCTURAL PIN — a reply is written in the card, by the reply publisher", () => {
  const card = read("components/post/PostCardInteractive.tsx");
  const box = read("components/post/NativeReplyBox.tsx");

  it("the card builds its own target through the one home and mounts the box", () => {
    expect(card).toContain("replyTargetFromPost(post)");
    expect(card).toContain("<NativeReplyBox");
    // The affordance is gated on the target, which is what makes it
    // native-only: an external post has no author pubkey, and replies back to
    // its origin through `InlineReplyBox` instead.
    expect(card.replace(/\s+/g, " ")).toContain(
      "onReply={ replyTarget ? () => setNativeReplyOpen((open) => !open) : undefined }",
    );
  });

  it("the box publishes a reply with the reply publisher", () => {
    expect(box).toContain("await publishReply({");
    expect(box).not.toContain("publishNote");
  });

  it("no surface asks a Glasshouse composer for a reply", () => {
    // The whole tree, because the fault this replaces was five hand-wired
    // hosts each raising the same request: the pin is the ABSENCE of the call
    // anywhere, not its absence from a list somebody has to keep current.
    const hits: string[] = [];
    const walk = (dir: string) => {
      for (const e of readdirSync(dir, { withFileTypes: true })) {
        const full = path.join(dir, e.name);
        if (e.isDirectory()) walk(full);
        else if (/\.tsx?$/.test(e.name)) {
          const src = readFileSync(full, "utf8");
          if (/\bopenReply\s*\(/.test(src)) hits.push(path.relative(SRC, full));
        }
      }
    };
    walk(SRC);
    expect(hits, `openReply must not be called: ${hits.join(", ")}`).toEqual([]);
  });

  it("neither Glasshouse composer publishes a reply any more", () => {
    for (const rel of [
      "components/compose/ComposeOverlay.tsx",
      "components/workspace/Composer.tsx",
    ]) {
      const src = read(rel);
      expect(src, `${rel} must not publish replies`).not.toContain(
        "publishReply(",
      );
    }
  });
});
