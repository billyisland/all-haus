import { describe, it, expect } from "vitest";
import {
  sanitizeContent,
  stripHtml,
} from "@platform-pub/shared/lib/sanitize.js";

describe("sanitizeContent", () => {
  describe("allowed tags pass through", () => {
    it("preserves paragraphs, emphasis, strong, code", () => {
      const html =
        "<p>Hello <em>world</em> <strong>bold</strong> <code>x</code></p>";
      expect(sanitizeContent(html)).toBe(html);
    });
    it("preserves lists", () => {
      const html = "<ul><li>one</li><li>two</li></ul>";
      expect(sanitizeContent(html)).toBe(html);
    });
    it("preserves blockquote", () => {
      const html = "<blockquote>quote</blockquote>";
      expect(sanitizeContent(html)).toBe(html);
    });
    it("preserves images with src and alt", () => {
      const result = sanitizeContent(
        '<img src="https://img.example.com/a.jpg" alt="photo">',
      );
      expect(result).toContain('src="https://img.example.com/a.jpg"');
      expect(result).toContain('alt="photo"');
    });
    it("preserves br tags", () => {
      expect(sanitizeContent("line1<br>line2")).toContain("<br");
    });
  });

  describe("dangerous tags stripped", () => {
    it("strips script tags", () => {
      expect(sanitizeContent('<script>alert("xss")</script>')).not.toContain(
        "<script",
      );
    });
    it("strips iframe", () => {
      expect(
        sanitizeContent('<iframe src="https://evil.com"></iframe>'),
      ).not.toContain("<iframe");
    });
    it("strips style tags", () => {
      expect(
        sanitizeContent("<style>body{display:none}</style>"),
      ).not.toContain("<style");
    });
    it("strips form and input", () => {
      expect(sanitizeContent('<form><input type="text"></form>')).not.toContain(
        "<form",
      );
    });
    it("strips object/embed", () => {
      expect(
        sanitizeContent('<object data="x"></object><embed src="y">'),
      ).not.toContain("<object");
    });
  });

  describe("dangerous attributes stripped", () => {
    it("strips onclick from any tag", () => {
      expect(sanitizeContent('<p onclick="alert(1)">hi</p>')).not.toContain(
        "onclick",
      );
    });
    it("strips onerror from img", () => {
      expect(sanitizeContent('<img src="x" onerror="alert(1)">')).not.toContain(
        "onerror",
      );
    });
    it("strips style attribute", () => {
      expect(
        sanitizeContent('<p style="background:url(evil)">hi</p>'),
      ).not.toContain("style");
    });
  });

  describe("link sanitisation", () => {
    it("adds rel=nofollow to links", () => {
      const result = sanitizeContent('<a href="https://example.com">link</a>');
      expect(result).toContain('rel="nofollow"');
    });
    it("preserves https href", () => {
      const result = sanitizeContent('<a href="https://example.com">link</a>');
      expect(result).toContain('href="https://example.com"');
    });
    it("strips javascript: scheme", () => {
      const result = sanitizeContent('<a href="javascript:alert(1)">link</a>');
      expect(result).not.toContain("javascript:");
    });
    it("strips data: scheme in img src", () => {
      const result = sanitizeContent(
        '<img src="data:text/html,<script>alert(1)</script>">',
      );
      expect(result).not.toContain("data:");
    });
  });
});

describe("stripHtml", () => {
  it("removes all tags and returns text", () => {
    expect(stripHtml("<p>Hello <strong>world</strong></p>")).toBe(
      "Hello world",
    );
  });
  it("trims whitespace", () => {
    expect(stripHtml("  <p>text</p>  ")).toBe("text");
  });
  it("returns empty string for empty input", () => {
    expect(stripHtml("")).toBe("");
  });
});
