import { describe, it, expect } from "vitest";
import { isExternalHref, externalizeHtml } from "./external-links";

describe("isExternalHref", () => {
  it("treats http(s) links to other hosts as external", () => {
    expect(isExternalHref("https://bsky.app/profile/x")).toBe(true);
    expect(isExternalHref("http://example.com")).toBe(true);
    expect(isExternalHref("//example.com/path")).toBe(true);
    expect(isExternalHref("  https://example.com  ")).toBe(true);
    expect(isExternalHref("https://EXAMPLE.com")).toBe(true);
  });

  it("treats our own hosts as internal", () => {
    expect(isExternalHref("https://all.haus/alice")).toBe(false);
    expect(isExternalHref("https://www.all.haus/alice")).toBe(false);
    expect(isExternalHref("http://localhost:3010/reader")).toBe(false);
    expect(isExternalHref("https://ALL.HAUS/alice")).toBe(false);
  });

  it("treats relative, hash and empty hrefs as internal", () => {
    expect(isExternalHref("/article/my-piece")).toBe(false);
    expect(isExternalHref("#citation-4")).toBe(false);
    expect(isExternalHref("")).toBe(false);
    expect(isExternalHref("   ")).toBe(false);
  });

  it("leaves handoff schemes alone — a new tab there is blank or useless", () => {
    expect(isExternalHref("mailto:someone@example.com")).toBe(false);
    expect(isExternalHref("tel:+441234567890")).toBe(false);
    expect(isExternalHref("nostr:npub1abc")).toBe(false);
    expect(isExternalHref("javascript:alert(1)")).toBe(false);
  });
});

describe("externalizeHtml", () => {
  it("adds target and rel to an off-site anchor", () => {
    expect(externalizeHtml('<p><a href="https://example.com">x</a></p>')).toBe(
      '<p><a href="https://example.com" target="_blank" rel="noopener noreferrer">x</a></p>',
    );
  });

  it("leaves internal anchors byte-identical", () => {
    const html = '<p><a href="/alice">alice</a> and <a href="#note-1">[1]</a></p>';
    expect(externalizeHtml(html)).toBe(html);
    const noAnchors = "<p>plain prose</p>";
    expect(externalizeHtml(noAnchors)).toBe(noAnchors);
  });

  it("MERGES an existing rel rather than replacing it", () => {
    // The backend sanitiser stamps nofollow on syndicated content; losing it
    // would turn every external post's links into endorsements.
    const out = externalizeHtml(
      '<a href="https://example.com" rel="nofollow">x</a>',
    );
    expect(out).toContain('target="_blank"');
    expect(out).toMatch(/rel="[^"]*nofollow[^"]*"/);
    expect(out).toMatch(/rel="[^"]*noopener[^"]*"/);
    expect(out).toMatch(/rel="[^"]*noreferrer[^"]*"/);
    // ...and does not leave two rel attributes behind.
    expect(out.match(/rel=/g)).toHaveLength(1);
  });

  it("replaces an existing target instead of doubling it", () => {
    const out = externalizeHtml('<a href="https://example.com" target="_self">x</a>');
    expect(out.match(/target=/g)).toHaveLength(1);
    expect(out).toContain('target="_blank"');
  });

  it("preserves other attributes and the anchor's inner HTML", () => {
    const out = externalizeHtml(
      '<a class="u" href="https://example.com" title="t">deep <em>x</em></a>',
    );
    expect(out).toContain('class="u"');
    expect(out).toContain('title="t"');
    expect(out).toContain("deep <em>x</em></a>");
  });

  it("reads a host through escaped entities in the href", () => {
    const out = externalizeHtml('<a href="https://example.com/?a=1&amp;b=2">x</a>');
    expect(out).toContain('target="_blank"');
    // The href itself is untouched — still escaped.
    expect(out).toContain("a=1&amp;b=2");
  });

  it("handles several anchors of mixed provenance in one string", () => {
    const out = externalizeHtml(
      '<p><a href="https://example.com">out</a> <a href="/x">in</a> <a href="https://all.haus/y">home</a></p>',
    );
    expect(out.match(/target="_blank"/g)).toHaveLength(1);
  });

  it("does not mistake a '>' inside a quoted attribute for the tag end", () => {
    const out = externalizeHtml('<a title="a > b" href="https://example.com">x</a>');
    expect(out).toContain('target="_blank"');
    expect(out).toContain('title="a > b"');
  });
});
