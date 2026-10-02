// @vitest-environment jsdom
import { describe, it, expect, beforeAll, afterEach } from "vitest";
import React, { act, useRef } from "react";
import { createRoot, type Root } from "react-dom/client";
import { useBodyImageLightbox } from "../src/hooks/useBodyImageLightbox";
import { useLightbox } from "../src/stores/lightbox";

// Walkthrough A6: a picture in an article body opens the lightbox — by click
// AND by keyboard — except the one inside a link (the link's) and a click that
// ends a live selection (QuoteSelector's). Driven through the real hook on real
// injected HTML, since the whole difficulty is that the body is a string.

beforeAll(() => {
  (globalThis as Record<string, unknown>).IS_REACT_ACT_ENVIRONMENT = true;
});

let root: Root | null = null;
let host: HTMLDivElement | null = null;

afterEach(() => {
  act(() => root?.unmount());
  host?.remove();
  root = null;
  host = null;
  useLightbox.getState().close();
  window.getSelection()?.removeAllRanges();
});

const HTML =
  '<p>Words</p><figure><img src="https://m.test/a.webp" alt="A harbour"><figcaption>Cap</figcaption></figure>' +
  '<p><a href="https://elsewhere.test"><img src="https://m.test/linked.webp" alt=""></a></p>' +
  '<p><img src="https://m.test/b.webp" alt=""></p>';

function Body({ html }: { html: string }) {
  const ref = useRef<HTMLDivElement>(null);
  useBodyImageLightbox(ref, html);
  return <div ref={ref} dangerouslySetInnerHTML={{ __html: html }} />;
}

function mount(html = HTML) {
  host = document.createElement("div");
  document.body.appendChild(host);
  root = createRoot(host);
  act(() => root!.render(<Body html={html} />));
  return Array.from(host.querySelectorAll("img"));
}

describe("useBodyImageLightbox", () => {
  it("marks every unlinked picture focusable, as a button, named only where it has no alt", () => {
    const [captioned, linked, bare] = mount();
    expect(captioned.getAttribute("tabindex")).toBe("0");
    expect(captioned.getAttribute("role")).toBe("button");
    // An aria-label would REPLACE the real description.
    expect(captioned.hasAttribute("aria-label")).toBe(false);
    expect(bare.getAttribute("aria-label")).toBe("View picture");
    expect(linked.hasAttribute("data-enlargeable")).toBe(false);
    expect(linked.hasAttribute("tabindex")).toBe(false);
  });

  it("opens on click, with the picture's own alt", () => {
    const [captioned] = mount();
    act(() => captioned.dispatchEvent(new MouseEvent("click", { bubbles: true })));
    expect(useLightbox.getState()).toMatchObject({
      isOpen: true,
      src: "https://m.test/a.webp",
      alt: "A harbour",
    });
  });

  it.each(["Enter", " "])("opens on %j from the keyboard, and takes the key", (key) => {
    const [, , bare] = mount();
    const ev = new KeyboardEvent("keydown", { key, bubbles: true, cancelable: true });
    act(() => bare.dispatchEvent(ev));
    expect(useLightbox.getState().src).toBe("https://m.test/b.webp");
    expect(ev.defaultPrevented).toBe(true);
  });

  it("leaves a picture inside a link to the link", () => {
    const [, linked] = mount();
    act(() => linked.dispatchEvent(new MouseEvent("click", { bubbles: true })));
    expect(useLightbox.getState().isOpen).toBe(false);
  });

  it("leaves a click that ends a live selection to the selection", () => {
    const [captioned] = mount();
    const range = document.createRange();
    range.selectNodeContents(host!.querySelector("p")!);
    window.getSelection()!.addRange(range);
    act(() => captioned.dispatchEvent(new MouseEvent("click", { bubbles: true })));
    expect(useLightbox.getState().isOpen).toBe(false);
  });

  it("re-marks the pictures when the HTML changes (the unlock swaps the body in)", () => {
    mount("<p>No pictures yet</p>");
    act(() => root!.render(<Body html='<p><img src="https://m.test/c.webp" alt=""></p>' />));
    const img = host!.querySelector("img")!;
    expect(img.getAttribute("role")).toBe("button");
  });
});
