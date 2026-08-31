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
    expect(html).toContain("youtube.com/embed/abc123");
    expect(html).not.toContain('target="_blank"');
  });
});
