import { describe, it, expect } from "vitest";
import { renderMarkdown } from "./markdown";

// The pure rewrite is covered by external-links.test.ts. What this pins is the
// WIRING — that renderMarkdown still runs it, and still runs it after the embed
// pass, whose pattern matches on the anchors remark produced.
describe("renderMarkdown — outbound links", () => {
  it("sends an off-site link to a new tab", async () => {
    const html = await renderMarkdown("See [the piece](https://example.com/x).");
    expect(html).toContain('target="_blank"');
    expect(html).toContain('rel="noopener noreferrer"');
  });

  it("leaves an internal link in place", async () => {
    const html = await renderMarkdown("See [Alice](/alice).");
    expect(html).not.toContain("target=");
  });

  it("externalises a GFM autolink too", async () => {
    const html = await renderMarkdown("Bare https://example.com/x in prose.");
    expect(html).toContain('target="_blank"');
  });

  it("still turns a bare YouTube URL into an embed, not a new-tab link", async () => {
    const html = await renderMarkdown("https://www.youtube.com/watch?v=abc123");
    expect(html).toContain("youtube-nocookie.com/embed/abc123");
    expect(html).not.toContain('target="_blank"');
  });
});

describe("renderMarkdown — a caption is the image's title", () => {
  // Three places, and widening one alone renders nothing: the editor has to
  // CARRY the title (editor-markdown-roundtrip), this promotes it, and the
  // sanitize schema has to let <figure>/<figcaption> out. hast-util-sanitize's
  // default allows neither, so before this the shape was deleted on the way out
  // — silently, and indistinguishable from a body that carried no captions.

  it("promotes a lone titled image to a figure with a caption", async () => {
    const html = await renderMarkdown('![A lime bike](https://a.haus/x.webp "Photograph: S Shepheard/Alamy")\n\nBody.')
    expect(html).toContain("<figure>")
    expect(html).toContain("<figcaption>Photograph: S Shepheard/Alamy</figcaption>")
    expect(html).toContain('alt="A lime bike"')
    // MOVED, never copied — left in place it renders as a tooltip saying the
    // same words the caption already shows.
    expect(html).not.toContain('title="Photograph')
  })

  it("leaves an UNTITLED image exactly as it was", async () => {
    // The control that says the pass is narrow. Promoting an untitled image by
    // borrowing its alt would put screen-reader text on the page and leave the
    // screen reader hearing it twice.
    const html = await renderMarkdown("![A lime bike](https://a.haus/x.webp)\n\nBody.")
    expect(html).not.toContain("<figure>")
    expect(html).toContain('<p><img src="https://a.haus/x.webp" alt="A lime bike"></p>')
  })

  it("leaves an INLINE titled image as a tooltip", async () => {
    // A caption is a block-level claim about a block-level picture. An image
    // inside a sentence is not one, and turning it into a figure would break
    // the sentence in half.
    const html = await renderMarkdown('A sentence with ![a pic](https://a.haus/x.webp "tooltip") in it.')
    expect(html).not.toContain("<figure>")
    expect(html).toContain('title="tooltip"')
  })

  it("carries the caption when the picture is a link", async () => {
    // `[![alt](src "cap")](page)` — how most archives store a click-through to
    // the full size, so the importer needs it. The anchor survives inside the
    // figure rather than being unwrapped.
    const html = await renderMarkdown('[![pic](https://a.haus/x.webp "cap")](https://example.com)')
    expect(html).toContain("<figure>")
    expect(html).toContain('href="https://example.com"')
    expect(html).toContain("<figcaption>cap</figcaption>")
  })

  it("does not promote a paragraph that holds a picture AND prose", async () => {
    const html = await renderMarkdown('![pic](https://a.haus/x.webp "cap") and then some words.')
    expect(html).not.toContain("<figure>")
  })

  it("escapes a caption — it is text, and it arrives from a published body", async () => {
    const html = await renderMarkdown('![alt](https://a.haus/x.webp "<script>alert(1)</script>")')
    expect(html).toContain("<figcaption>")
    expect(html).not.toContain("<script>")
  })

  it("keeps figure and figcaption through the sanitiser", async () => {
    // The third place. If either tag leaves the schema this whole pass becomes
    // an expensive no-op and the failure looks exactly like an article with no
    // captions in it.
    const html = await renderMarkdown('![alt](https://a.haus/x.webp "Cap.")')
    expect(html).toMatch(/<figure><img[^>]*><figcaption>Cap\.<\/figcaption><\/figure>/)
  })
})
