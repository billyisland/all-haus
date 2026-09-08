import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import {
  EMBED_IFRAME_HOSTS,
  sanitizeArticleContent,
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

// =============================================================================
// sanitizeArticleContent — the /extract reader's allowlist, which since
// 2026-09-02 carries players. Every case below is a way the widening could be a
// hole rather than a feature, plus the two pairings it depends on.
// =============================================================================

describe("sanitizeArticleContent — players", () => {
  it("keeps an allowlisted iframe with its embed attributes", () => {
    const result = sanitizeArticleContent(
      '<iframe src="https://www.youtube.com/embed/abc" width="560" allowfullscreen></iframe>',
    );
    expect(result).toContain('src="https://www.youtube.com/embed/abc"');
    expect(result).toContain("allowfullscreen");
  });

  it("keeps <video> and <source>, and drops autoplay and handlers", () => {
    const result = sanitizeArticleContent(
      '<video controls autoplay onerror="alert(1)"><source src="https://x.test/v.mp4" type="video/mp4"></video>',
    );
    expect(result).toContain("<video");
    expect(result).toContain('src="https://x.test/v.mp4"');
    expect(result).toContain("controls");
    expect(result).not.toContain("autoplay");
    expect(result).not.toContain("onerror");
  });

  // An off-list src is deleted BY sanitize-html, which without exclusiveFilter
  // leaves a srcless <iframe> — an empty framed box in the prose. Assert the
  // whole element is gone, not merely that the URL is: dropping the filter
  // keeps every "not.toContain(url)" green.
  it.each([
    ["an off-list host", "https://evil.test/x"],
    ["a lookalike host", "https://www.youtube.com.evil.test/embed/x"],
    ["a protocol-relative src", "//www.youtube.com/embed/x"],
    ["a javascript: src", "javascript:alert(1)"],
    ["a relative src", "/embed/x"],
  ])("drops the whole iframe for %s", (_label, src) => {
    const result = sanitizeArticleContent(`<p>a</p><iframe src="${src}"></iframe><p>b</p>`);
    expect(result).toBe("<p>a</p><p>b</p>");
  });

  // The widening is this allowlist's alone. A feed card renders post.body.html
  // through sanitizeContent at card size, and what may appear there is a
  // card-chassis decision — moving the player tags up into the social list
  // turns this red.
  it("leaves the social allowlist stripping players", () => {
    const html =
      '<p>a</p><iframe src="https://www.youtube.com/embed/abc"></iframe><video src="https://x.test/v.mp4"></video>';
    expect(sanitizeContent(html)).toBe("<p>a</p>");
  });
});

describe("EMBED_IFRAME_HOSTS ⊆ nginx frame-src", () => {
  // The two lists are a PAIR: the sanitiser passing an iframe the browser then
  // refuses renders an empty box, and there is no error anywhere to say so.
  // Both nginx blocks carry the directive, and both must carry every host.
  const nginx = readFileSync(
    new URL("../../../nginx.conf", import.meta.url),
    "utf8",
  );
  const directives = [...nginx.matchAll(/frame-src ([^";]+)/g)].map((m) => m[1]);

  it("finds a frame-src directive in each of the two server blocks", () => {
    expect(directives).toHaveLength(2);
  });

  it.each(EMBED_IFRAME_HOSTS)("permits %s in every frame-src", (host) => {
    for (const d of directives) expect(d).toContain(`https://${host}`);
  });
});
