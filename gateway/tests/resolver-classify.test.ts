import { describe, it, expect } from "vitest";
import { classifyInput } from "../src/lib/resolver.js";

describe("classifyInput", () => {
  describe("url", () => {
    it("classifies https URLs", () => {
      expect(classifyInput("https://example.com")).toBe("url");
    });
    it("classifies http URLs", () => {
      expect(classifyInput("http://example.com/feed.xml")).toBe("url");
    });
    it("classifies URLs with paths and query strings", () => {
      expect(classifyInput("https://blog.example.com/rss?format=atom")).toBe(
        "url",
      );
    });
  });

  describe("npub", () => {
    it("classifies npub1 prefix", () => {
      expect(
        classifyInput(
          "npub1qqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqq3t5a2m",
        ),
      ).toBe("npub");
    });
    it("classifies npub with leading/trailing whitespace", () => {
      expect(classifyInput("  npub1abc  ")).toBe("npub");
    });
  });

  describe("nprofile", () => {
    it("classifies nprofile1 prefix", () => {
      expect(
        classifyInput(
          "nprofile1qqsrhuxx8l9ex335q7he0f09aej04zpazpl0ne2cgukyawd24mayt8gpp4mhxue69uhhytnc9e3k7mgpz4mhxue69uhkg6nzv9ejuumpv34k2u",
        ),
      ).toBe("nprofile");
    });
  });

  describe("hex_pubkey", () => {
    it("classifies 64-char lowercase hex", () => {
      expect(
        classifyInput(
          "abcdef0123456789abcdef0123456789abcdef0123456789abcdef0123456789",
        ),
      ).toBe("hex_pubkey");
    });
    it("classifies 64-char uppercase hex", () => {
      expect(
        classifyInput(
          "ABCDEF0123456789ABCDEF0123456789ABCDEF0123456789ABCDEF0123456789",
        ),
      ).toBe("hex_pubkey");
    });
    it("classifies 64-char mixed case hex", () => {
      expect(
        classifyInput(
          "AbCdEf0123456789abcdef0123456789ABCDEF0123456789abcdef0123456789",
        ),
      ).toBe("hex_pubkey");
    });
    it("rejects 63-char hex as free_text", () => {
      expect(
        classifyInput(
          "abcdef0123456789abcdef0123456789abcdef0123456789abcdef012345678",
        ),
      ).not.toBe("hex_pubkey");
    });
    it("rejects 65-char hex", () => {
      expect(
        classifyInput(
          "abcdef0123456789abcdef0123456789abcdef0123456789abcdef01234567890",
        ),
      ).not.toBe("hex_pubkey");
    });
  });

  describe("did", () => {
    it("classifies did:plc:", () => {
      expect(classifyInput("did:plc:ewvi7nxzyoun6zhxrhs64oiz")).toBe("did");
    });
    it("classifies did:web:", () => {
      expect(classifyInput("did:web:example.com")).toBe("did");
    });
    it("does not match did:key: or other methods", () => {
      expect(classifyInput("did:key:z6Mkfoo")).not.toBe("did");
    });
  });

  describe("fediverse_handle", () => {
    it("classifies @user@instance.tld", () => {
      expect(classifyInput("@alice@mastodon.social")).toBe("fediverse_handle");
    });
    it("classifies @user@sub.instance.tld", () => {
      expect(classifyInput("@bob@social.example.co.uk")).toBe(
        "fediverse_handle",
      );
    });
    it("classifies handles with dots and plus in username", () => {
      expect(classifyInput("@alice.bob+tag@mastodon.social")).toBe(
        "fediverse_handle",
      );
    });
  });

  describe("ambiguous_at", () => {
    it("classifies user@domain.tld (no leading @)", () => {
      expect(classifyInput("alice@mastodon.social")).toBe("ambiguous_at");
    });
    it("classifies email-like input", () => {
      expect(classifyInput("user@example.com")).toBe("ambiguous_at");
    });
  });

  describe("bluesky_handle", () => {
    it("classifies handle.bsky.social", () => {
      expect(classifyInput("alice.bsky.social")).toBe("bluesky_handle");
    });
    it("classifies handle.bsky.team", () => {
      expect(classifyInput("bob.bsky.team")).toBe("bluesky_handle");
    });
    it("classifies with leading @", () => {
      expect(classifyInput("@alice.bsky.social")).toBe("bluesky_handle");
    });
    it("is case-insensitive", () => {
      expect(classifyInput("Alice.Bsky.Social")).toBe("bluesky_handle");
    });
    it("does not match custom-domain Bluesky handles", () => {
      expect(classifyInput("alice.example.com")).not.toBe("bluesky_handle");
    });
  });

  describe("dotted_host", () => {
    it("classifies bare hostname", () => {
      expect(classifyInput("blog.example.com")).toBe("dotted_host");
    });
    it("classifies two-part domain", () => {
      expect(classifyInput("example.com")).toBe("dotted_host");
    });
    it("does not match single word (no dot)", () => {
      expect(classifyInput("localhost")).not.toBe("dotted_host");
    });
  });

  describe("platform_username", () => {
    it("classifies alphanumeric word ≥2 chars", () => {
      expect(classifyInput("alice")).toBe("platform_username");
    });
    it("classifies with underscore", () => {
      expect(classifyInput("alice_bob")).toBe("platform_username");
    });
    it("classifies @username (strips prefix)", () => {
      expect(classifyInput("@alice")).toBe("platform_username");
    });
    it("rejects single-char username", () => {
      expect(classifyInput("a")).not.toBe("platform_username");
    });
    it("rejects @x (single char after strip)", () => {
      expect(classifyInput("@x")).not.toBe("platform_username");
    });
  });

  describe("free_text", () => {
    it("classifies empty string after trim", () => {
      // Note: resolve() catches empty before classifyInput, but the function itself
      expect(classifyInput("")).toBe("free_text");
    });
    it("classifies single character", () => {
      expect(classifyInput("a")).toBe("free_text");
    });
    it("classifies multi-word search", () => {
      expect(classifyInput("some random search")).toBe("free_text");
    });
  });

  describe("priority order", () => {
    it("fediverse_handle wins over ambiguous_at (leading @ + domain)", () => {
      expect(classifyInput("@user@example.com")).toBe("fediverse_handle");
    });
    it("ambiguous_at wins over bluesky_handle for non-bsky domains", () => {
      expect(classifyInput("user@example.com")).toBe("ambiguous_at");
    });
    it("url wins over everything for http-prefixed input", () => {
      expect(classifyInput("https://npub1abc.com")).toBe("url");
    });
    it("npub wins over hex_pubkey (npub1 prefix checked first)", () => {
      // npub1 is checked before hex_64 regex
      expect(classifyInput("npub1" + "0".repeat(59))).toBe("npub");
    });
  });
});
