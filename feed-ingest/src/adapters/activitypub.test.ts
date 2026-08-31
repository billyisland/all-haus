import { describe, it, expect } from "vitest";
import { extractQuoteUri } from "./activitypub.js";

describe("extractQuoteUri", () => {
  it("returns null when no quote field is present", () => {
    expect(extractQuoteUri({ content: "hi" })).toBeNull();
  });

  it("reads FEP-044f `quote` as a bare URI string", () => {
    expect(
      extractQuoteUri({ quote: "https://example.social/users/a/statuses/1" }),
    ).toBe("https://example.social/users/a/statuses/1");
  });

  it("reads Fedibird `quoteUrl`", () => {
    expect(extractQuoteUri({ quoteUrl: "https://x.social/@a/2" })).toBe(
      "https://x.social/@a/2",
    );
  });

  it("reads Misskey `_misskey_quote`", () => {
    expect(
      extractQuoteUri({ _misskey_quote: "https://m.example/notes/3" }),
    ).toBe("https://m.example/notes/3");
  });

  it("reads a quote object via its `id`", () => {
    expect(
      extractQuoteUri({ quote: { id: "https://example.social/objects/4" } }),
    ).toBe("https://example.social/objects/4");
  });

  it("reads a quote object via its `href`", () => {
    expect(
      extractQuoteUri({
        quoteUri: { href: "https://example.social/objects/5" },
      }),
    ).toBe("https://example.social/objects/5");
  });

  it("prefers `quote` over the other aliases", () => {
    expect(
      extractQuoteUri({
        quote: "https://a/1",
        quoteUrl: "https://b/2",
        _misskey_quote: "https://c/3",
      }),
    ).toBe("https://a/1");
  });

  it("ignores empty strings", () => {
    expect(extractQuoteUri({ quote: "   " })).toBeNull();
  });
});
