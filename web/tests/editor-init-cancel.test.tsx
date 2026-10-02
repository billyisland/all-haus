// @vitest-environment jsdom
import { describe, it, expect, vi } from "vitest";
import React, { act } from "react";
import { createRoot } from "react-dom/client";

// =============================================================================
// A load that resolves late must not retarget the next Publish.
//
// `useArticleEditorInit` resolves `/articles/by-event/:id` into `initialData`,
// and `initialData.editingDTag` is the d-tag `publishArticle` republishes
// UNDER — read LIVE at the press, by both `handlePublish` and
// `handleSchedule`. So a resolve that arrives after the writer has moved on is
// not a display bug: it replaces a published article with a different one.
//
// The window: dashboard Edit on article X → Escape before the two fetches
// resolve → ⌘K → write a note → "Make this an article". The seeded editor
// mounts SYNCHRONOUSLY (`editorReady` is true in the initialiser), so X's
// fetch resolves into an editor that is already up and taking keystrokes.
//
// MUTATION LOG (each applied to src/, suite re-run, reverted):
//   1. drop the `cancelled` flag, keeping the loadKey compare — PASSES
//   2. drop the loadKey compare, keeping `cancelled`          — PASSES
//   3. `current()` → `true`, i.e. no guard at all
//      ⇒ fails with editingDTag = "x-the-other-article": the piece the
//        writer is composing would publish over the other article.  DETECTED
//
// So this case proves that A guard is there, not WHICH — either half stops
// this scenario on its own. Both are kept because they answer different
// questions: `cancelled` covers unmount and re-run, the loadKey compare covers
// a resolve arriving for a target that is no longer the one being edited. The
// honest thing is to say so rather than to claim a pin the case does not make.
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
// A STABLE object, deliberately. The hook's effects take `user` as a
// dependency, so a mock that mints a fresh one every render re-runs the load
// effect on every render — and the seed branch sets a fresh `initialData`
// object, which re-renders, which re-runs the effect. The real store returns
// the same reference until the session changes; a mock that does not makes
// this file spin for ever with nothing to say why.
const AUTH = { user: { pubkey: "pk", username: "u" } };
vi.mock("../src/stores/auth", () => ({ useAuth: () => AUTH }));

const { useArticleEditorInit } = await import("../src/hooks/useArticleEditorInit");

describe("the editor's load effect cannot retarget a publish", () => {
  it("discards a resolve whose target the editor has moved on from", async () => {
    let hold: ((v: unknown) => void) | null = null;
    vi.stubGlobal(
      "fetch",
      vi.fn(
        () =>
          // Held open — this is the fetch the writer walks away from.
          new Promise((res) => {
            hold = res as (v: unknown) => void;
          }),
      ),
    );

    // Read back out of the render; typed loosely because TypeScript narrows
    // an only-assigned-in-a-callback local to `never` at the read site.
    const seen: { current: { editingDTag?: string } | null } = { current: null };
    function Probe(props: { editEventId?: string; seedContent?: string }) {
      const { initialData } = useArticleEditorInit({
        editEventId: props.editEventId,
        seedContent: props.seedContent,
        onComplete: () => {},
      } as never);
      seen.current = initialData as { editingDTag?: string } | null;
      return null;
    }

    const host = document.createElement("div");
    document.body.appendChild(host);
    const root = createRoot(host);

    // 1. Edit article X — the fetch is in flight and held.
    await act(async () => {
      root.render(<Probe editEventId="ev-x" />);
    });
    expect(hold).toBeTruthy();

    // 2. The writer escapes and escalates a note instead. The seeded editor
    //    resolves in the state initialiser, so it is already mounted.
    await act(async () => {
      root.render(<Probe seedContent="a note becoming an article" />);
    });
    expect(seen.current?.editingDTag).toBeUndefined();

    // 3. X's fetch lands, into an editor that is now writing something else.
    await act(async () => {
      hold!({
        ok: true,
        json: async () => ({
          id: "a1",
          title: "The other article",
          dTag: "x-the-other-article",
          contentFree: "body",
        }),
      });
    });

    // The whole claim: nothing from X reached the editor, so Publish cannot
    // put this piece out over X's d-tag.
    expect(seen.current?.editingDTag).toBeUndefined();

    act(() => {
      root.unmount();
    });
  });
});
