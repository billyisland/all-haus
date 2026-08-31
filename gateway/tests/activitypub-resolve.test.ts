import { describe, it, expect, vi } from "vitest";
import {
  extractFromMastodonUrl,
  extractFromThreadiverseUrl,
  isAcctShape,
} from "../src/lib/activitypub-resolve.js";

// Everything exercised here is pure — the network legs (webfinger, actor
// fetch) are covered via source-liveness.test.ts, which superseded
// resolveApSourceUri's block when addSource moved onto verifySourceLiveness
// (2026-07-09 audit F1).
vi.mock("@platform-pub/shared/lib/logger.js", () => ({
  default: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

describe("extractFromMastodonUrl", () => {
  it("extracts acct from /@user path", () => {
    const result = extractFromMastodonUrl(
      new URL("https://mastodon.social/@alice"),
    );
    expect(result).toEqual({ acct: "alice@mastodon.social" });
  });

  it("extracts acct from /@user@remote path", () => {
    const result = extractFromMastodonUrl(
      new URL("https://mastodon.social/@alice@other.host"),
    );
    expect(result).toEqual({ acct: "alice@other.host" });
  });

  it("extracts actorUri from /users/name path", () => {
    const result = extractFromMastodonUrl(
      new URL("https://mastodon.social/users/alice"),
    );
    expect(result).toEqual({
      actorUri: "https://mastodon.social/users/alice",
    });
  });

  it("returns null for unknown paths", () => {
    expect(
      extractFromMastodonUrl(new URL("https://mastodon.social/about")),
    ).toBeNull();
  });
});

describe("extractFromThreadiverseUrl", () => {
  it("extracts acct from Lemmy /c/community path", () => {
    const result = extractFromThreadiverseUrl(
      new URL("https://lemmy.world/c/technology"),
    );
    expect(result).toEqual({ acct: "technology@lemmy.world" });
  });

  it("extracts acct from Lemmy /u/user path", () => {
    const result = extractFromThreadiverseUrl(
      new URL("https://lemmy.ml/u/admin"),
    );
    expect(result).toEqual({ acct: "admin@lemmy.ml" });
  });

  it("extracts acct from Mbin /m/magazine path", () => {
    const result = extractFromThreadiverseUrl(
      new URL("https://fedia.io/m/linux"),
    );
    expect(result).toEqual({ acct: "linux@fedia.io" });
  });

  it("handles trailing slash", () => {
    const result = extractFromThreadiverseUrl(
      new URL("https://lemmy.world/c/technology/"),
    );
    expect(result).toEqual({ acct: "technology@lemmy.world" });
  });

  it("returns null for Lemmy post paths", () => {
    expect(
      extractFromThreadiverseUrl(new URL("https://lemmy.world/post/12345")),
    ).toBeNull();
  });

  it("returns null for non-threadiverse paths", () => {
    expect(
      extractFromThreadiverseUrl(new URL("https://example.com/about")),
    ).toBeNull();
  });

  it("returns null for Mastodon-style paths", () => {
    expect(
      extractFromThreadiverseUrl(new URL("https://mastodon.social/@alice")),
    ).toBeNull();
  });
});

describe("isAcctShape", () => {
  it("accepts user@domain", () => {
    expect(isAcctShape("alice@mastodon.social")).toBe(true);
  });

  it("rejects a leading @ (callers strip it first)", () => {
    expect(isAcctShape("@alice@mastodon.social")).toBe(false);
  });

  it("rejects free text and bare domains", () => {
    expect(isAcctShape("just a name")).toBe(false);
    expect(isAcctShape("mastodon.social")).toBe(false);
  });
});
