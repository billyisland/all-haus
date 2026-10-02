// @vitest-environment jsdom
import { describe, it, expect, beforeAll, beforeEach, afterEach, vi } from "vitest";
import React, { act } from "react";
import { createRoot, type Root } from "react-dom/client";

// =============================================================================
// WORKSPACE-QUEUE-ADR §XI.2 R1/R2: the floor's two drags, rehomed in the ⚙
// panel when the desktop became the queue (C2).
//
// R2 — a source row's "Move" picker writes the move, drops the row, and tells
// the caller both feeds changed; a refusal SAYS so, in the route's own words.
// R1 — "Merge into" only CHOOSES the target (the caller's MergeFeedConfirm
// asks), and is offered exactly where Delete is: never for the last visible
// feed.
// =============================================================================

const listSources = vi.fn();
const moveSource = vi.fn();
vi.mock("../src/lib/api", async (orig) => {
  const real = (await orig()) as Record<string, unknown>;
  return {
    ...real,
    workspaceFeeds: {
      ...(real.workspaceFeeds as object),
      listSources: (...a: unknown[]) => listSources(...a),
      moveSource: (...a: unknown[]) => moveSource(...a),
    },
  };
});
vi.mock("../src/lib/api/linked-accounts", () => ({
  getNetworkCapabilities: () => Promise.resolve({ followImportProtocols: [] }),
}));
vi.mock("../src/lib/api/formulas", () => ({
  formulasAvailable: () => Promise.resolve(false),
  formulas: {},
}));

// jsdom has neither, and Glasshouse measures itself with both.
(globalThis as unknown as { ResizeObserver: unknown }).ResizeObserver =
  class {
    observe() {}
    unobserve() {}
    disconnect() {}
  };
if (!window.matchMedia) {
  (window as unknown as { matchMedia: unknown }).matchMedia = (q: string) => ({
    matches: false,
    media: q,
    addEventListener() {},
    removeEventListener() {},
    addListener() {},
    removeListener() {},
    onchange: null,
    dispatchEvent: () => false,
  });
}

const { FeedComposer } = await import("../src/components/workspace/FeedComposer");
const { ApiError } = await import("../src/lib/api/client");

function feed(id: string, name: string, sortRank: number, hidden = false) {
  return {
    id,
    name,
    sortRank,
    hidden,
    createdAt: "2026-09-01T00:00:00Z",
  } as never;
}
const A = feed("fa", "Alpha", 1);
const B = feed("fb", "Beta", 2);
const C = feed("fc", "Gamma", 3, true);

const SOURCE = {
  id: "s1",
  sourceType: "external_source",
  accountId: null,
  mutedAt: null,
  throughput: 1,
  samplingMode: "random",
  excludeReplies: false,
  hasEngagementSignal: true,
  display: { label: "Some Blog", href: null, sublabel: null },
};

let root: Root;
let host: HTMLDivElement;
beforeAll(() => {
  (globalThis as Record<string, unknown>).IS_REACT_ACT_ENVIRONMENT = true;
});
beforeEach(() => {
  listSources.mockReset().mockResolvedValue({ sources: [SOURCE], importBinding: null });
  moveSource.mockReset();
  host = document.createElement("div");
  document.body.appendChild(host);
  root = createRoot(host);
});
afterEach(() => {
  act(() => root.unmount());
  host.remove();
});

async function mount(props: Record<string, unknown> = {}) {
  await act(async () => {
    root.render(
      <FeedComposer
        feed={A}
        open
        onClose={() => {}}
        allFeeds={[C, B, A]}
        {...props}
      />,
    );
  });
}

const buttonByText = (text: string) =>
  Array.from(document.querySelectorAll("button")).find(
    (b) => b.textContent === text,
  );

describe("the ⚙ panel's Move (R2)", () => {
  it("lists every OTHER feed in the member's order, hidden ones marked", async () => {
    await mount({ onSourceMoved: () => {} });
    await act(async () => buttonByText("Move")!.click());
    const dialog = document.querySelector('[aria-label="Move Some Blog to another channel"]');
    expect(dialog).not.toBeNull();
    const rows = Array.from(dialog!.querySelectorAll("button")).map((b) => b.textContent);
    expect(rows).toEqual(["Beta", "GammaHIDDEN"]);
  });

  it("writes the move, drops the row and reports both feeds", async () => {
    moveSource.mockResolvedValue({ ok: true });
    const onSourceMoved = vi.fn();
    await mount({ onSourceMoved });
    await act(async () => buttonByText("Move")!.click());
    await act(async () => buttonByText("Beta")!.click());
    expect(moveSource).toHaveBeenCalledWith("fa", "s1", "fb");
    expect(onSourceMoved).toHaveBeenCalledWith("fa", "fb");
    expect(document.body.textContent).not.toContain("Some Blog");
  });

  it("a refusal says so in the route's words, and the row stays", async () => {
    moveSource.mockRejectedValue(
      new ApiError(409, { error: "That channel already has this source." }),
    );
    const onSourceMoved = vi.fn();
    await mount({ onSourceMoved });
    await act(async () => buttonByText("Move")!.click());
    await act(async () => buttonByText("Beta")!.click());
    expect(onSourceMoved).not.toHaveBeenCalled();
    expect(document.body.textContent).toContain("That channel already has this source.");
    expect(document.body.textContent).toContain("Some Blog");
  });

  it("is absent where the caller cannot take a move, and with nowhere to go", async () => {
    await mount();
    expect(buttonByText("Move")).toBeUndefined();
    await mount({ onSourceMoved: () => {}, allFeeds: [A] });
    expect(buttonByText("Move")).toBeUndefined();
  });
});

describe("the ⚙ panel's Merge into (R1)", () => {
  it("hands the chosen target to the caller and writes nothing itself", async () => {
    const onMergeInto = vi.fn();
    await mount({ onMergeInto });
    await act(async () => buttonByText("Merge into")!.click());
    await act(async () => buttonByText("Beta")!.click());
    expect(onMergeInto).toHaveBeenCalledWith(B);
    expect(moveSource).not.toHaveBeenCalled();
  });

  it("is offered where Delete is: never for the last visible feed", async () => {
    await mount({ onMergeInto: () => {}, deleteBlocked: true });
    expect(buttonByText("Merge into")).toBeUndefined();
  });

  it("has no orientation control any more (§XI.3)", async () => {
    await mount({ onTextSizeChange: () => {} });
    expect(document.querySelector('[data-explain="feedComposer.orientation"]')).toBeNull();
  });
});
