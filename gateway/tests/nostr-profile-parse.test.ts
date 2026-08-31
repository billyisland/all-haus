import { describe, it, expect, vi } from "vitest";

// parseNostrProfileContent backs both single-profile enrichment and the NIP-50
// name search used by discovery fallback branch 2 (UNIVERSAL-FEED-ADR §V.5.8).
// It lives in nostr-search.ts (extracted from resolver.ts, RESOLVER-DISCOVERY-ADR
// Phase 0); mock the logger so the pure helper imports in isolation.
vi.mock("@platform-pub/shared/lib/logger.js", () => ({
  default: { warn: vi.fn(), info: vi.fn(), error: vi.fn() },
}));

const { parseNostrProfileContent } = await import("../src/lib/nostr-search.js");

describe("parseNostrProfileContent (nostr name search branch 2)", () => {
  it("prefers display_name over name", () => {
    const p = parseNostrProfileContent(
      JSON.stringify({ display_name: "The Guardian", name: "guardian" }),
    );
    expect(p?.displayName).toBe("The Guardian");
  });

  it("falls back to name when display_name is empty/absent", () => {
    expect(
      parseNostrProfileContent(JSON.stringify({ name: "guardian" }))?.displayName,
    ).toBe("guardian");
    expect(
      parseNostrProfileContent(
        JSON.stringify({ display_name: "", name: "guardian" }),
      )?.displayName,
    ).toBe("guardian");
  });

  it("extracts about and picture", () => {
    const p = parseNostrProfileContent(
      JSON.stringify({ about: "News", picture: "https://cdn/av.jpg" }),
    );
    expect(p?.about).toBe("News");
    expect(p?.picture).toBe("https://cdn/av.jpg");
  });

  it("ignores non-string fields", () => {
    const p = parseNostrProfileContent(
      JSON.stringify({ name: 42, about: { x: 1 }, picture: null }),
    );
    expect(p).toEqual({
      displayName: undefined,
      about: undefined,
      picture: undefined,
    });
  });

  it("returns null on malformed JSON", () => {
    expect(parseNostrProfileContent("{not json")).toBeNull();
  });
});
