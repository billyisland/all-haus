// @vitest-environment jsdom
import { describe, it, expect, beforeAll, beforeEach, afterEach, vi } from "vitest";
import React, { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { readFileSync } from "node:fs";
import path from "node:path";

// Walkthrough A3: the two short-form composers had drifted by nine things, the
// workspace one (the box a member normally meets) the poorer. They now share
// ONE hook, `useNoteComposer`, and differ in presentation alone. This drives
// that hook for the behaviours the drift was made of, and pins structurally
// that both surfaces take it — a rule kept by remembering is how they drifted.

const publishNote = vi.fn();
vi.mock("../src/lib/publishNote", () => ({
  publishNote: (...args: unknown[]) => publishNote(...args),
}));

let accounts: unknown[] | null = [];
vi.mock("../src/hooks/useLinkedAccounts", () => ({
  useLinkedAccounts: () => accounts,
  useLinkedAccountsFailed: () => false,
}));

// The attachments a real upload would have produced — the upload itself is a
// file picker, which is the one part not worth driving.
let attachments: { url: string; type: "image" | "embed" }[] = [];
vi.mock("../src/hooks/useMediaAttachments", () => ({
  useMediaAttachments: () => {
    const buildContent = (t: string) =>
      [t.trim(), ...attachments.filter((a) => a.type === "image").map((a) => a.url)]
        .filter(Boolean)
        .join("\n");
    return {
      attachments,
      uploading: false,
      error: null,
      clearError: () => {},
      triggerImageUpload: () => {},
      removeAttachment: () => {},
      detectEmbeds: () => {},
      buildContent,
      totalCharCount: (t: string) => buildContent(t).length,
      reset: () => {},
    };
  },
}));

const editorOpen = vi.fn();
vi.mock("../src/stores/editorOverlay", () => ({
  useEditorOverlay: { getState: () => ({ open: editorOpen }) },
  seedFromNote: (body: string, att?: unknown[]) => ({ seed: { body, att } }),
}));
vi.mock("../src/components/workspace/Glasshouse", () => ({ activeGlasshouseRect: () => null }));
vi.mock("../src/components/workspace/prefetchEditor", () => ({ prefetchEditorOverlay: () => {} }));

const { useNoteComposer } = await import("../src/hooks/useNoteComposer");
const { useAuth } = await import("../src/stores/auth");

type Api = ReturnType<typeof useNoteComposer>;
let api: Api;
const close = vi.fn();

function Harness(props: { quoteTarget?: Parameters<typeof useNoteComposer>[0]["quoteTarget"] }) {
  api = useNoteComposer({ open: true, quoteTarget: props.quoteTarget ?? null, close });
  return null;
}

let root: Root;
beforeAll(() => {
  (globalThis as Record<string, unknown>).IS_REACT_ACT_ENVIRONMENT = true;
});
beforeEach(() => {
  publishNote.mockReset().mockResolvedValue({ noteEventId: "ev1" });
  close.mockReset();
  editorOpen.mockReset();
  attachments = [];
  accounts = [];
  useAuth.setState({ user: { pubkey: "pk", id: "u1" } as never, loading: false });
});
afterEach(() => act(() => root.unmount()));

function mount(props: Parameters<typeof Harness>[0] = {}) {
  root = createRoot(document.createElement("div"));
  act(() => root.render(<Harness {...props} />));
}
function type(text: string) {
  act(() => api.handleChange({ target: { value: text } } as never));
}
function key(k: string, mods: Partial<KeyboardEvent> = {}) {
  const e = { key: k, metaKey: false, ctrlKey: false, preventDefault: vi.fn(), ...mods };
  act(() => api.handleKeyDown(e as never));
  return e;
}

describe("useNoteComposer", () => {
  it("Enter is a newline; Ctrl/Cmd+Enter posts", async () => {
    mount();
    type("Line one");
    const bare = key("Enter");
    expect(bare.preventDefault).not.toHaveBeenCalled();
    expect(publishNote).not.toHaveBeenCalled();
    key("Enter", { ctrlKey: true });
    await act(async () => {});
    expect(publishNote).toHaveBeenCalledTimes(1);
    key("Enter", { metaKey: true });
    await act(async () => {});
    expect(publishNote).toHaveBeenCalledTimes(2);
  });

  it("posts an image-only note, and counts the image URLs that ship with it", async () => {
    attachments = [{ url: "https://m.test/a.webp", type: "image" }];
    mount();
    expect(api.canPost).toBe(true);
    expect(api.charCount).toBe("https://m.test/a.webp".length);
    await act(async () => api.handlePost());
    expect(publishNote.mock.calls[0][0]).toBe("https://m.test/a.webp");
  });

  it("reserves an external quote's appended URL in the count", () => {
    mount({
      quoteTarget: { eventId: "", eventKind: 1, authorPubkey: "", isExternal: true, quotedUrl: "https://bsky.test/p/1" },
    });
    type("hi");
    expect(api.charCount).toBe(2 + "https://bsky.test/p/1".length + 2);
  });

  it("offers only networks that can receive an original post, resting on crossPostDefault", async () => {
    accounts = [
      { id: "b", protocol: "atproto", isValid: true, crossPostDefault: true, externalHandle: "me" },
      { id: "m", protocol: "activitypub", isValid: true, crossPostDefault: false, externalHandle: "me" },
      { id: "n", protocol: "nostr_external", isValid: true, crossPostDefault: true, externalHandle: null },
      { id: "x", protocol: "atproto", isValid: false, crossPostDefault: true, externalHandle: "old" },
    ];
    mount();
    expect(api.crossPostAccounts.map((a) => a.id)).toEqual(["b", "m"]);
    expect(api.activeCrossPosts.map((a) => a.id)).toEqual(["b"]);
    act(() => api.toggleCrossPost(api.crossPostAccounts[1]));
    type("hello");
    await act(async () => api.handlePost());
    expect(publishNote.mock.calls[0][3]).toEqual([
      { linkedAccountId: "b", actionType: "original" },
      { linkedAccountId: "m", actionType: "original" },
    ]);
  });

  it("a quote offers no cross-post", () => {
    accounts = [{ id: "b", protocol: "atproto", isValid: true, crossPostDefault: true }];
    mount({ quoteTarget: { eventId: "e", eventKind: 1, authorPubkey: "p" } });
    expect(api.crossPostAccounts).toEqual([]);
  });

  it("a dirty box takes a two-step dismiss; a clean one closes at once", () => {
    mount();
    act(() => api.dismiss());
    expect(close).toHaveBeenCalledTimes(1);
    type("unsent");
    act(() => api.dismiss());
    expect(close).toHaveBeenCalledTimes(1);
    expect(api.confirmDismiss).toBe(true);
    act(() => api.dismiss());
    expect(close).toHaveBeenCalledTimes(2);
  });

  it("escalates with the attachments as well as the text", () => {
    attachments = [{ url: "https://m.test/a.webp", type: "image" }];
    mount();
    type("Start of something");
    act(() => api.escalateToArticle());
    expect(editorOpen.mock.calls[0][0].seed).toEqual({ body: "Start of something", att: attachments });
  });
});

// READER-WRITER-SPLIT-ADR §6.2: only a writer is offered an article. A reader
// over the limit is told the one way on — shorten it — since the escalation
// was until now the only way out once Post goes dead.
describe("the article offer is a writer's", () => {
  const long = "x".repeat(1200);

  it("a writer over the limit is offered an article", () => {
    useAuth.setState({ user: { pubkey: "pk", id: "u1", canWrite: true } as never, loading: false });
    mount();
    type(long);
    expect(api.canEscalate).toBe(true);
    expect(api.showNudge).toBe(true);
    expect(api.showTooLong).toBe(false);
  });

  it("a reader over the limit is told to shorten it, and offered no article", () => {
    useAuth.setState({ user: { pubkey: "pk", id: "u1", canWrite: false } as never, loading: false });
    mount();
    type(long);
    expect(api.canEscalate).toBe(false);
    expect(api.showNudge).toBe(false);
    expect(api.showTooLong).toBe(true);
  });

  it("an absent canWrite reads as a reader", () => {
    mount();
    expect(api.canEscalate).toBe(false);
  });

  it.each(["components/compose/ComposeOverlay.tsx", "components/workspace/Composer.tsx"])(
    "%s gates the standing offer and shows the reader's banner",
    (rel) => {
      const src = readFileSync(path.join(path.resolve(__dirname, "../src"), rel), "utf8");
      expect(src).toContain("c.canEscalate && !c.showNudge && (");
      expect(src).toContain("c.showTooLong && (");
      expect(src).toContain("{NOTE_TOO_LONG_READER}");
    },
  );
});

describe("both compose surfaces take the one hook", () => {
  const SRC = path.resolve(__dirname, "../src");
  it.each(["components/compose/ComposeOverlay.tsx", "components/workspace/Composer.tsx"])(
    "%s",
    (rel) => {
      const src = readFileSync(path.join(SRC, rel), "utf8");
      expect(src).toContain("useNoteComposer(");
      expect(src).toContain("<MediaPreview");
      expect(src).toContain("<AttachImageButton");
      expect(src).toContain("<CrossPostPill");
      // Behaviour lives in the hook: a surface that publishes, handles keys or
      // lists linked accounts itself is the drift coming back.
      expect(src).not.toMatch(/\bpublishNote\(/);
      expect(src).not.toMatch(/e\.key === ["']Enter["']/);
      expect(src).not.toMatch(/linkedAccounts(Api)?\.list\(|useLinkedAccounts\(/);
    },
  );
});
