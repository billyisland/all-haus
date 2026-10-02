// @vitest-environment jsdom
import { describe, it, expect, vi, afterEach } from "vitest";
import React, { act } from "react";
import { createRoot } from "react-dom/client";

// =============================================================================
// A paid piece whose paid half could not be read is NOT opened for editing.
//
// `GET /articles/by-event/:id` fetches the paid half from the key service
// "non-fatal" and answers `contentPaywall: null` on a failure. Loaded as it
// was, the editor held the free half alone with no gate marker, and the next
// Publish put the piece out FREE with its paid half gone (MODERNHAUS-ADR
// §E4.3). The load now refuses instead, as the modernhaus register does.
//
// MUTATION: the refusal deleted from useArticleEditorInit ⇒ case 1 fails with
// initialData holding the free half and no marker. The control (case 2) is what
// stops a blanket refusal of paid pieces passing.
// =============================================================================

(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT =
  true;

vi.mock("../src/lib/api", () => ({
  tags: { getForArticle: async () => ({ tags: [] }) },
  publications: { myMemberships: async () => ({ memberships: [] }) },
}));
vi.mock("../src/lib/drafts", () => ({
  loadDraft: async () => null,
  saveDraft: async () => ({ id: "d" }),
  scheduleDraft: async () => {},
  deleteDraft: async () => {},
}));
vi.mock("../src/lib/publish", () => ({
  publishArticle: async () => {},
  publishToPublication: async () => ({ status: "published" }),
}));
vi.mock("../src/lib/featureFlags", () => ({ publicationsEnabled: () => false }));
const AUTH = { user: { pubkey: "pk", username: "u" } };
vi.mock("../src/stores/auth", () => ({ useAuth: () => AUTH }));

const { useArticleEditorInit, PAID_HALF_UNAVAILABLE } = await import(
  "../src/hooks/useArticleEditorInit"
);

type Seen = { initialData: { content?: string } | null; loadError: string | null; editorReady: boolean };

async function openEdit(meta: Record<string, unknown>): Promise<Seen> {
  vi.stubGlobal("fetch", vi.fn(async () => ({ ok: true, json: async () => meta })));
  const seen: { current: Seen | null } = { current: null };
  function Probe() {
    const r = useArticleEditorInit({ editEventId: "ev-1", draftId: null, pubSlug: null, onComplete: () => {} });
    seen.current = { initialData: r.initialData, loadError: r.loadError, editorReady: r.editorReady };
    return null;
  }
  const host = document.createElement("div");
  const root = createRoot(host);
  await act(async () => {
    root.render(<Probe />);
  });
  await act(async () => {});
  act(() => root.unmount());
  return seen.current!;
}

const PAID = {
  id: "a1",
  title: "A paid piece",
  dTag: "a-paid-piece",
  contentFree: "the free half",
  isPaywalled: true,
  pricePence: 300,
  gatePositionPct: 40,
};

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("the editor refuses a paid piece without its paid half", () => {
  it("does not open, and says why, when the paid half came back null", async () => {
    const seen = await openEdit({ ...PAID, contentPaywall: null });
    expect(seen.initialData).toBeNull();
    expect(seen.editorReady).toBe(false);
    expect(seen.loadError).toBe(PAID_HALF_UNAVAILABLE);
  });

  it("control: opens a paid piece whose paid half arrived, gate marker and all", async () => {
    const seen = await openEdit({ ...PAID, contentPaywall: "the paid half" });
    expect(seen.loadError).toBeNull();
    expect(seen.initialData?.content).toContain("<!-- paywall-gate -->");
    expect(seen.initialData?.content).toContain("the paid half");
  });

  it("control: opens a free piece, which has no paid half to lose", async () => {
    const seen = await openEdit({ ...PAID, isPaywalled: false, pricePence: 0, contentPaywall: null });
    expect(seen.loadError).toBeNull();
    expect(seen.initialData?.content).toBe("the free half");
  });
});
