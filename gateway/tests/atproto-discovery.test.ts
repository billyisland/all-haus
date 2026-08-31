import { describe, it, expect, vi, beforeEach } from "vitest";

// Mock the SSRF-hardened HTTP client so searchActors can be tested without a
// real network call. The discovery fallback (UNIVERSAL-FEED-ADR §V.5.8, branch
// 1) is built on app.bsky.actor.searchActors via this client.
const safeFetch = vi.fn();
vi.mock("@platform-pub/shared/lib/http-client.js", () => ({
  safeFetch: (...args: unknown[]) => safeFetch(...args),
}));
vi.mock("@platform-pub/shared/lib/logger.js", () => ({
  default: { warn: vi.fn(), info: vi.fn(), error: vi.fn() },
}));

const { searchActors, getFollows } = await import(
  "../src/lib/atproto-resolve.js"
);

function ok(body: unknown) {
  return { ok: true, text: JSON.stringify(body) };
}

describe("searchActors (discovery fallback)", () => {
  beforeEach(() => safeFetch.mockReset());

  it("returns validated candidate profiles", async () => {
    safeFetch.mockResolvedValueOnce(
      ok({
        actors: [
          {
            did: "did:plc:guardian1",
            handle: "guardian.bsky.social",
            displayName: "The Guardian",
            description: "News",
            avatar: "https://cdn/av.jpg",
          },
        ],
      }),
    );
    const out = await searchActors("guardian");
    expect(out).toEqual([
      {
        did: "did:plc:guardian1",
        handle: "guardian.bsky.social",
        displayName: "The Guardian",
        description: "News",
        avatar: "https://cdn/av.jpg",
      },
    ]);
  });

  it("hits the searchActors endpoint with the encoded query and a clamped limit", async () => {
    safeFetch.mockResolvedValueOnce(ok({ actors: [] }));
    await searchActors("the guardian", 5);
    const url = safeFetch.mock.calls[0][0] as string;
    expect(url).toContain("app.bsky.actor.searchActors");
    expect(url).toContain("q=the%20guardian");
    expect(url).toContain("limit=5");
  });

  it("skips actors with a missing or malformed DID", async () => {
    safeFetch.mockResolvedValueOnce(
      ok({
        actors: [
          { handle: "no-did.bsky.social" },
          { did: "not-a-did", handle: "bad.bsky.social" },
          { did: "did:plc:good", handle: "good.bsky.social" },
        ],
      }),
    );
    const out = await searchActors("x");
    expect(out).toHaveLength(1);
    expect(out[0].did).toBe("did:plc:good");
  });

  it("returns [] for an empty query without fetching", async () => {
    expect(await searchActors("   ")).toEqual([]);
    expect(safeFetch).not.toHaveBeenCalled();
  });

  it("returns [] on a non-ok response", async () => {
    safeFetch.mockResolvedValueOnce({ ok: false, text: "" });
    expect(await searchActors("x")).toEqual([]);
  });

  it("returns [] when the payload has no actors array", async () => {
    safeFetch.mockResolvedValueOnce(ok({ cursor: "abc" }));
    expect(await searchActors("x")).toEqual([]);
  });

  it("swallows fetch errors and returns []", async () => {
    safeFetch.mockRejectedValueOnce(new Error("network"));
    expect(await searchActors("x")).toEqual([]);
  });
});

describe("getFollows pager ceiling", () => {
  beforeEach(() => safeFetch.mockReset());

  it("bounds a non-advancing pager: empty pages with a fresh cursor terminate as an incomplete read", async () => {
    // Progress is measured in VALID parsed follows, so an AppView regression
    // emitting empty pages with a cursor forever would otherwise loop hot.
    safeFetch.mockImplementation(() =>
      Promise.resolve(ok({ follows: [], cursor: "stuck" })),
    );
    const cap = 100;
    const out = await getFollows("did:plc:someone", cap);
    expect(out?.follows).toHaveLength(0);
    expect(out?.complete).toBe(false); // ceiling hit = truncated, suppresses sync removals
    expect(safeFetch.mock.calls.length).toBeLessThanOrEqual(
      Math.ceil(cap / 100) + 7,
    );
  });
});
