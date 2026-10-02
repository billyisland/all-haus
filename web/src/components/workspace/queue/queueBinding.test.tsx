// @vitest-environment jsdom
import { describe, it, expect, beforeAll, afterAll, afterEach } from "vitest";
import React, { act, useRef } from "react";
import { flushSync } from "react-dom";
import { createRoot, type Root } from "react-dom/client";
import { motionValue, type MotionValue } from "framer-motion";
import { QueueMotionContext, useQueueBinding, type QueueBinding } from "./queueBinding";

// WORKSPACE-QUEUE-ADR §VII.6. A step's commit resets `u` to 0 and swaps every
// entry's place in ONE task (`u.jump(0)`, then a `flushSync`), and that is
// jump-free only if a bound style follows `u` IN THE SAME CALL STACK and a
// re-render re-binds before anything could paint. Framer's own `motion.*` and
// `useTransform` both batch to the next frame; this suite is what says the
// binding does not.
//
// MUTATION LOG (each applied to queueBinding.ts, the suite re-run, reverted):
//   1. `apply` deferred through `requestAnimationFrame` ⇒ "writes in the same
//      call stack as the change" fails.                            DETECTED
//   2. the effect given `[]` deps (bound once) ⇒ "a re-render re-binds to the
//      new function" fails.                                        DETECTED
//   3. `apply(u.get())` dropped from the bind ⇒ "a re-render re-binds" fails
//      (the new place is not written until `u` next moves).         DETECTED
//   4. the unchanged-value skip removed from `apply` ⇒ "writes a value only
//      when it changes" fails (four writes where one belongs).     DETECTED

let root: Root;
let host: HTMLDivElement;
beforeAll(() => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
});
afterAll(() => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = false;
});
afterEach(() => {
  act(() => root.unmount());
  host.remove();
});

function Bound({ at }: { at?: QueueBinding }) {
  const ref = useRef<HTMLDivElement>(null);
  useQueueBinding(ref, "width", at);
  return <div ref={ref} data-testid="b" />;
}

function mount(u: MotionValue<number> | null, at?: QueueBinding) {
  host = document.createElement("div");
  document.body.appendChild(host);
  root = createRoot(host);
  const render = (next?: QueueBinding) =>
    root.render(
      <QueueMotionContext.Provider value={u}>
        <Bound at={next} />
      </QueueMotionContext.Provider>,
    );
  act(() => render(at));
  const el = host.querySelector<HTMLElement>('[data-testid="b"]')!;
  return { el, render };
}

describe("useQueueBinding", () => {
  it("writes the bound value at mount", () => {
    const u = motionValue(0.5);
    const { el } = mount(u, (v) => 100 + 100 * v);
    expect(el.style.width).toBe("150px");
  });

  it("writes in the same call stack as the change", () => {
    const u = motionValue(0);
    const { el } = mount(u, (v) => 100 + 100 * v);
    u.set(0.25);
    expect(el.style.width).toBe("125px");
    u.jump(1);
    expect(el.style.width).toBe("200px");
  });

  it("a re-render re-binds to the new function, before the task ends", () => {
    // The commit's shape: `u` back to 0, and the new places rendered
    // synchronously. After both, in the same task, the style is the NEW
    // place at 0 — the old place at 0 never survives to be painted.
    const u = motionValue(1);
    const { el, render } = mount(u, (v) => 256 + (640 - 256) * v);
    expect(el.style.width).toBe("640px");
    u.jump(0);
    flushSync(() => render(() => 640));
    expect(el.style.width).toBe("640px");
    u.set(0.5);
    expect(el.style.width).toBe("640px");
  });

  it("writes a value only when it changes", () => {
    // An entry two steps from focal holds one width over the whole of `u`;
    // with fifteen of them, re-writing it every wheel event is waste.
    const u = motionValue(0);
    const { el } = mount(u, (v) => (v < 0.5 ? 192 : 256));
    const writes: string[] = [];
    const style = el.style;
    Object.defineProperty(style, "width", {
      configurable: true,
      get: () => writes[writes.length - 1] ?? "",
      set: (v: string) => void writes.push(v),
    });
    u.set(0.1);
    u.set(0.2);
    u.set(0.6);
    u.set(0.9);
    expect(writes).toEqual(["256px"]);
    u.set(0.3);
    expect(writes).toEqual(["256px", "192px"]);
  });

  it("does nothing outside the queue, or with nothing to bind", () => {
    const { el } = mount(null, () => 300);
    expect(el.style.width).toBe("");
    act(() => root.unmount());
    host.remove();
    const u = motionValue(0);
    const second = mount(u, undefined);
    u.set(0.5);
    expect(second.el.style.width).toBe("");
  });
});
