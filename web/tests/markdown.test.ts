import { describe, it, expect } from "vitest";
import { renderMarkdown } from "../src/lib/markdown";

describe("renderMarkdown", () => {
  it("converts headings", async () => {
    const result = await renderMarkdown("# Title");
    expect(result).toContain("<h1>Title</h1>");
  });

  it("converts bold and italic", async () => {
    expect(await renderMarkdown("**bold**")).toContain("<strong>bold</strong>");
    expect(await renderMarkdown("*italic*")).toContain("<em>italic</em>");
  });

  it("converts inline code", async () => {
    expect(await renderMarkdown("use `console.log`")).toContain(
      "<code>console.log</code>",
    );
  });

  it("strips script tags — XSS prevention", async () => {
    const result = await renderMarkdown("<script>alert(1)</script>");
    expect(result).not.toContain("<script");
  });

  it("strips javascript: protocol links — XSS prevention", async () => {
    const result = await renderMarkdown("[click](javascript:alert(1))");
    expect(result).not.toContain("javascript:");
  });
});

describe("embed enhancement via renderMarkdown", () => {
  it("replaces standalone YouTube watch URLs with iframes", async () => {
    const result = await renderMarkdown(
      "https://www.youtube.com/watch?v=dQw4w9WgXcQ",
    );
    expect(result).toContain("<iframe");
    expect(result).toContain("youtube.com/embed/dQw4w9WgXcQ");
  });

  it("replaces standalone youtu.be short URLs with iframes", async () => {
    const result = await renderMarkdown("https://youtu.be/dQw4w9WgXcQ");
    expect(result).toContain("<iframe");
    expect(result).toContain("youtube.com/embed/dQw4w9WgXcQ");
  });

  it("does not replace non-embeddable URLs", async () => {
    const result = await renderMarkdown("https://example.com");
    expect(result).not.toContain("<iframe");
  });
});
