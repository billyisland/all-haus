// @vitest-environment jsdom
import { describe, it, expect, beforeAll, afterEach, vi } from "vitest";
import React, { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import type { Post } from "../../../lib/post/types";
import type { CardContext } from "../../post/chassis";

// WORKSPACE-QUEUE-ADR §VII.5 (B5). A preview row wears the read wash of a
// full card and is NEVER something the pass tracker can count: it carries no
// `data-seen-at`, which is the only thing `usePassTracker` observes. And a
// click on a row is the row's — a note walks, an article opens the reader —
// never also the compact entry's, where any click walks: an article opened
// from a preview must leave the queue where it was (D6).

class NoopObserver {
  observe() {}
  unobserve() {}
  disconnect() {}
}

beforeAll(() => {
  const g = globalThis as Record<string, unknown>;
  g.ResizeObserver = NoopObserver;
  g.IntersectionObserver = NoopObserver;
  g.IS_REACT_ACT_ENVIRONMENT = true;
  g.React = React;
  // The byline's hover asks whether the device can hover.
  window.matchMedia = ((q: string) => ({ matches: false, media: q })) as unknown as typeof window.matchMedia;
});

const { PostCard } = await import("../../post/PostCard");
const { PreviewLayer } = await import("./PreviewLayer");
const { paletteFor } = await import("../tokens");

let root: Root | null = null;
let host: HTMLDivElement | null = null;
afterEach(() => {
  act(() => root?.unmount());
  host?.remove();
  root = null;
  host = null;
});

function render(el: React.ReactElement): HTMLDivElement {
  host = document.createElement("div");
  document.body.appendChild(host);
  root = createRoot(host);
  act(() => root!.render(el));
  return host;
}

function makePost(over: Partial<Post> = {}): Post {
  return {
    id: "p1",
    version: null,
    origin: { protocol: "rss", uri: "u1", sourceName: "A Blog", publication: null },
    author: {
      id: null,
      accountId: null,
      displayName: "Jane",
      handle: null,
      handleUri: null,
      pubkey: null,
      pipStatus: "unknown",
    },
    type: "note",
    accessMode: "free",
    body: { text: "hello", html: null, title: null, summary: null, media: [], contentWarning: null, poll: null },
    inReplyTo: null,
    quotes: null,
    originCounts: null,
    scoresheet: { up: 0, down: 0, reposts: 0 },
    biddabilityTier: "D",
    publishedAt: 1_700_000_000,
    isContextOnly: false,
    isDeleted: false,
    isMuted: false,
    feedItemId: null,
    externalItemId: null,
    ...over,
  };
}

const palette = paletteFor("basic", false);
const ctx = (seen: CardContext["seen"]): CardContext => ({
  density: "compact",
  palette,
  bodyPx: 16,
  feedId: "f-1",
  seen,
});

const card = (el: HTMLElement) => el.querySelector<HTMLElement>("[data-post-id]")!;

describe("a preview row (§VII.5)", () => {
  it("recedes once read, and carries nothing the tracker counts", () => {
    const row = card(render(<PostCard post={makePost()} level="preview" ctx={ctx("read")} />));
    expect(row.hasAttribute("data-seen-at")).toBe(false);
    expect(row.hasAttribute("data-receded")).toBe(true);
    expect(row.style.background).toContain("color-mix");
  });

  it("is the plain card while unread or new, and where we do not know", () => {
    for (const seen of ["unread", "new", null] as const) {
      const row = card(render(<PostCard post={makePost()} level="preview" ctx={ctx(seen)} />));
      expect(row.hasAttribute("data-receded")).toBe(false);
      expect(row.style.background).not.toContain("color-mix");
    }
  });

  it("— where the same post as a FEED card is counted (the fixture can fail)", () => {
    const row = card(render(<PostCard post={makePost()} level="feed" ctx={ctx("read")} />));
    expect(row.getAttribute("data-seen-at")).toBe("1700000000");
    expect(row.hasAttribute("data-receded")).toBe(true);
  });

  it("shows a content warning's label and no way to reveal the text", () => {
    const el = render(
      <PostCard
        post={makePost({ body: { ...makePost().body, contentWarning: "Spoilers" } })}
        level="preview"
        ctx={ctx(null)}
      />,
    );
    expect(el.textContent).toContain("Spoilers");
    expect(el.textContent).not.toContain("hello");
    expect(el.textContent).not.toContain("SHOW CONTENT");
    expect(el.querySelector("time")).toBeNull();
  });
});

describe("a click on a preview row (§VII.5, D6)", () => {
  function layer(post: Post, onFocus: () => void, onOpenReader: () => void, onEntry: () => void) {
    return render(
      // The compact entry's clip, which walks on any click.
      <div data-entry onClick={onEntry}>
        <PreviewLayer shown opacityAt={() => 1} width={240} anchor={{ get: () => undefined, set: () => {} }}>
          <PostCard post={post} level="preview" ctx={ctx(null)} onFocus={onFocus} onOpenReader={onOpenReader} />
        </PreviewLayer>
      </div>,
    );
  }

  it("on a note walks, once — the entry does not hear it", () => {
    const onFocus = vi.fn();
    const onOpenReader = vi.fn();
    const onEntry = vi.fn();
    const el = layer(makePost(), onFocus, onOpenReader, onEntry);
    act(() => card(el).click());
    expect(onFocus).toHaveBeenCalledTimes(1);
    expect(onOpenReader).not.toHaveBeenCalled();
    expect(onEntry).not.toHaveBeenCalled();
  });

  it("on an article opens the reader, and the queue does not move", () => {
    const onFocus = vi.fn();
    const onOpenReader = vi.fn();
    const onEntry = vi.fn();
    const el = layer(makePost({ type: "article", body: { ...makePost().body, title: "T" } }), onFocus, onOpenReader, onEntry);
    act(() => card(el).click());
    expect(onOpenReader).toHaveBeenCalledTimes(1);
    expect(onFocus).not.toHaveBeenCalled();
    expect(onEntry).not.toHaveBeenCalled();
  });

  it("between the rows still walks the entry", () => {
    const onEntry = vi.fn();
    const el = layer(makePost(), vi.fn(), vi.fn(), onEntry);
    act(() => el.querySelector<HTMLElement>("[data-queue-preview]")!.click());
    expect(onEntry).toHaveBeenCalledTimes(1);
  });
});
