import { describe, it, expect, vi, beforeEach } from "vitest";

// =============================================================================
// MIRROR-AUDIT §2.9 (S9), gateway half — `fetchActorProfile` must not accept an
// actor id the serving host has no authority over, and must not substitute the
// requested uri when the document claims none.
//
// The refusal is a `null` return, which is also this function's ordinary "not
// resolvable" answer — so the tests that matter are the two that say WHICH
// value came back: the redirect case (accepted, on the post-redirect origin)
// and the impostor case (refused, where the old fallback would have returned
// the safe uri and a plausible profile with it).
// =============================================================================

const responses = new Map<string, { body: unknown; url?: string }>();

vi.mock("@platform-pub/shared/lib/http-client.js", () => ({
  safeFetch: vi.fn(async (url: string) => {
    const hit = responses.get(url);
    if (!hit) throw new Error(`unexpected fetch: ${url}`);
    return {
      ok: true,
      status: 200,
      headers: new Headers(),
      text: JSON.stringify(hit.body),
      url: hit.url ?? url,
    };
  }),
}));

vi.mock("@platform-pub/shared/lib/logger.js", () => ({
  default: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

const { fetchActorProfile } = await import("../src/lib/activitypub-resolve.js");

beforeEach(() => responses.clear());

describe("fetchActorProfile — actor id authority", () => {
  it("accepts an id on the origin that served it", async () => {
    responses.set("https://good.social/users/alice", {
      body: {
        id: "https://good.social/users/alice",
        preferredUsername: "alice",
        name: "Alice",
      },
    });
    const profile = await fetchActorProfile("https://good.social/users/alice");
    expect(profile?.actorUri).toBe("https://good.social/users/alice");
    expect(profile?.handle).toBe("alice@good.social");
  });

  it("accepts an id on the post-redirect origin", async () => {
    responses.set("https://example.social/users/alice", {
      url: "https://www.example.social/users/alice",
      body: {
        id: "https://www.example.social/users/alice",
        preferredUsername: "alice",
      },
    });
    const profile = await fetchActorProfile(
      "https://example.social/users/alice",
    );
    expect(profile?.actorUri).toBe("https://www.example.social/users/alice");
  });

  it("refuses an id claiming another host", async () => {
    responses.set("https://hostile.example/users/x", {
      body: {
        id: "https://mastodon.social/users/victim",
        preferredUsername: "victim",
        name: "Victim",
      },
    });
    expect(
      await fetchActorProfile("https://hostile.example/users/x"),
    ).toBeNull();
  });

  it("refuses a document with no id rather than falling back to the requested uri", async () => {
    responses.set("https://hostile.example/users/x", {
      body: { preferredUsername: "x", name: "X" },
    });
    expect(
      await fetchActorProfile("https://hostile.example/users/x"),
    ).toBeNull();
  });
});
