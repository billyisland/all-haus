// @vitest-environment jsdom
import { describe, it, expect, beforeEach, vi } from "vitest";
import React, { act } from "react";
import { createRoot } from "react-dom/client";


// =============================================================================
// The hand-back belongs where the SUPERSEDE happens.
//
// A pane that supersedes a URL-synced one has to hand it back. That was wired
// in exactly ONE store — `useCompose.close()` — while the supersede itself is
// the primitive's doing and every Glasshouse participates in it automatically.
// So every other superseder left the address naming a pane that was no longer
// on screen, with the pane suspended in its store and Back visibly doing
// nothing. The ∀ menu opens five such panes over any pane by design, and the
// workspace's own composer never opens the compose store at all
// (`setComposerOpen("note")`) — so the one superseder that was wired was also
// the one the menu could not reach.
//
// THIS DRIVES THE REAL COMPONENT, because that is the whole of the finding.
// The existing suite calls `reopenAddressedPane()` directly, which is why
// removing the call from `useCompose.close()` left 62/62 green: every case
// tested the function and none tested that anything invokes it.
//
// MUTATION LOG (each applied to src/, suite re-run, reverted):
//   1. drop `scheduleAddressedPaneHandback()` from Glasshouse's release path
//      ⇒ "puts the suspended pane back when the last pane goes" fails.  DETECTED
//   2. fire it synchronously instead of in a microtask
//      ⇒ "a HANDOFF is not a close" fails: the outgoing pane's cleanup runs
//        before the newcomer's mount effect, so the address would be re-opened
//        on top of a pane that is arriving.                            DETECTED
// =============================================================================

// React 18 wants to be told it is in a test environment, or every `act` warns.
(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT =
  true;

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

const { Glasshouse } = await import("../src/components/workspace/Glasshouse");
const { useProfile } = await import("../src/stores/profileOverlay");

function mount(ui: React.ReactElement) {
  const host = document.createElement("div");
  document.body.appendChild(host);
  const root = createRoot(host);
  act(() => {
    root.render(ui);
  });
  return {
    unmount: () =>
      act(() => {
        root.unmount();
      }),
    rerender: (next: React.ReactElement) =>
      act(() => {
        root.render(next);
      }),
  };
}

/** Let the microtask the hand-back is deferred into run. */
async function settle() {
  await act(async () => {
    await Promise.resolve();
  });
}

describe("a superseding pane hands the addressed one back", () => {
  beforeEach(() => {
    useProfile.setState({ isOpen: false, target: null, focus: null });
    window.history.replaceState({ allhausOverlay: true }, "", "/mira-h");
  });

  it("puts the suspended pane back when the last pane goes", async () => {
    // The profile is open on an errand, and something opens over it — any
    // Glasshouse, which is the point: this one is not the composer.
    const focus = { postId: "p-abc", view: "posts" as const };
    useProfile.getState().openNative("mira-h", { focus });
    useProfile.getState().dismiss();
    expect(useProfile.getState().isOpen).toBe(false);
    expect(useProfile.getState().focus).toEqual(focus);

    const pane = mount(
      <Glasshouse onClose={() => {}} maxWidth={640}>
        <div>anything at all</div>
      </Glasshouse>,
    );
    await settle();
    // While it is up the address belongs to it; nothing is handed back.
    expect(useProfile.getState().isOpen).toBe(false);

    pane.unmount();
    await settle();

    // Back on screen, and carrying the errand it was suspended with.
    expect(useProfile.getState().isOpen).toBe(true);
    expect(useProfile.getState().focus).toEqual(focus);
  });

  it("a HANDOFF is not a close — a pane replaced in the same commit hands nothing back", async () => {
    // React runs every cleanup in a commit before any create, so a handoff
    // releases the registry slot and refills it within one flush. Firing the
    // hand-back synchronously on release would reopen the addressed pane on
    // top of the pane that is arriving — two panes, and the one-at-a-time
    // invariant broken by the thing meant to repair it.
    useProfile.getState().openNative("mira-h");
    useProfile.getState().dismiss();

    const pane = mount(
      <Glasshouse key="a" onClose={() => {}} maxWidth={640}>
        <div>first</div>
      </Glasshouse>,
    );
    await settle();
    pane.rerender(
      <Glasshouse key="b" onClose={() => {}} maxWidth={640}>
        <div>second</div>
      </Glasshouse>,
    );
    await settle();

    expect(useProfile.getState().isOpen).toBe(false);
  });

  it("leaves an address nobody claimed alone", async () => {
    // No overlay marker: this is somewhere the reader actually navigated to,
    // and opening a pane over it would be inventing one.
    window.history.replaceState({}, "", "/mira-h");
    const pane = mount(
      <Glasshouse onClose={() => {}} maxWidth={640}>
        <div>anything</div>
      </Glasshouse>,
    );
    await settle();
    pane.unmount();
    await settle();
    expect(useProfile.getState().isOpen).toBe(false);
  });
});
