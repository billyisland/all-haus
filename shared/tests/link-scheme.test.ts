import { describe, it, expect } from "vitest";
import { httpUrlOrNull } from "../src/lib/sanitize.js";
import { escapeHtml } from "../src/lib/text.js";

// =============================================================================
// The scheme rule for a URL stored as a bare string.
//
// `sanitizeContent`'s `allowedSchemes` covers a URL inside markup; a link
// preview's target and a Nostr profile's `website` never pass through it, so
// until 2026-09-09 nothing applied the rule to them at all and a
// `javascript:` value from a remote post reached the client's `href`
// (MIRROR-AUDIT-2026-09-08 §2.3/§2.4). Refused at persistence here, and
// guarded again at render by `web/src/lib/external-links.ts::safeHttpUrl`.
// =============================================================================

describe("httpUrlOrNull", () => {
  it.each([
    ["https", "https://example.com/x?a=1#b"],
    ["http", "http://example.com"],
  ])("passes an %s URL through unchanged", (_label, url) => {
    expect(httpUrlOrNull(url)).toBe(url);
  });

  it("trims before deciding — leading whitespace is how a scheme sneaks past", () => {
    expect(httpUrlOrNull("  https://example.com  ")).toBe("https://example.com");
    expect(httpUrlOrNull(" \tjavascript:alert(1)")).toBeNull();
  });

  it.each([
    ["javascript:", "javascript:alert(1)"],
    ["mixed-case javascript:", "JaVaScRiPt:alert(1)"],
    ["data:", "data:text/html;base64,PHNjcmlwdD4="],
    ["vbscript:", "vbscript:msgbox(1)"],
    ["at://", "at://did:plc:abc/app.bsky.feed.post/xyz"],
    ["a relative path", "/x"],
    ["a bare word", "not a url"],
    ["the empty string", ""],
  ])("refuses %s", (_label, url) => {
    expect(httpUrlOrNull(url)).toBeNull();
  });

  it.each([
    ["null", null],
    ["undefined", undefined],
  ])("refuses %s", (_label, url) => {
    expect(httpUrlOrNull(url)).toBeNull();
  });
});

// escapeHtml gained `'` on 2026-09-09 so it is correct in a single-quoted
// attribute too — a helper that is right only for the contexts its current
// callers happen to use is one somebody widens without re-reading it.
describe("escapeHtml", () => {
  it("escapes all five HTML metacharacters", () => {
    expect(escapeHtml(`& < > " '`)).toBe("&amp; &lt; &gt; &quot; &#39;");
  });

  it("escapes the ampersand FIRST, so an escape is not double-escaped", () => {
    expect(escapeHtml("<b>")).toBe("&lt;b&gt;");
    expect(escapeHtml("&lt;")).toBe("&amp;lt;");
  });

  it("defuses the display-name payload the unsubscribe page interpolated", () => {
    const out = escapeHtml(`<svg onload='alert(1)'>`);
    expect(out).not.toContain("<svg");
    expect(out).not.toContain("'");
  });
});
