import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

// =============================================================================
// EXTERNAL-AUTHOR-HISTORY-ADR §3.1/§3.7 — the profile-view hydration trigger
// gates: operator kill switch, protocol support, and the per-author 10-minute
// TTL guard (a hot profile hydrates once, not per viewer). Network + DB are
// mocked; the integration surface is covered in author-posts-hydration.test.ts.
// =============================================================================

vi.mock("@platform-pub/shared/db/client.js", () => ({
  pool: {
    query: vi.fn(async () => ({
      rows: [{ id: "shadow-src-1", relay_urls: [] }],
      rowCount: 1,
    })),
  },
  withTransaction: vi.fn(),
}));
vi.mock("@platform-pub/shared/lib/logger.js", () => ({
  default: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));
vi.mock("../src/lib/nostr-relay.js", () => ({
  fetchNostrEvents: vi.fn(async () => []),
}));
// Only the socket-opening export is stubbed; relayCandidates is pure and its
// real behaviour (hints before fallbacks, capped) is what the assertions read.
vi.mock("@platform-pub/shared/lib/nostr-relay-req.js", async (importOriginal) => ({
  ...(await importOriginal<
    typeof import("@platform-pub/shared/lib/nostr-relay-req.js")
  >()),
  fetchNostrWriteRelays: vi.fn(async () => []),
}));
vi.mock("@platform-pub/shared/lib/http-client.js", () => ({
  safeFetch: vi.fn(async () => ({ ok: false, status: 404, text: "" })),
}));

const { safeFetch } = await import("@platform-pub/shared/lib/http-client.js");
const { fetchNostrEvents } = await import("../src/lib/nostr-relay.js");

const {
  authorTimelineHydrationEnabled,
  willHydrateAuthorTimeline,
  hydrateAuthorTimeline,
  resetAuthorTimelineGuard,
} = await import("../src/lib/author-timeline-hydration.js");

const AUTHOR = "11111111-0000-4000-8000-000000000001";
const PUBKEY = "a".repeat(64);

describe("author timeline hydration gates", () => {
  beforeEach(() => {
    resetAuthorTimelineGuard();
    delete process.env.AUTHOR_TIMELINE_HYDRATION_ENABLED;
  });
  afterEach(() => {
    delete process.env.AUTHOR_TIMELINE_HYDRATION_ENABLED;
  });

  it("kill switch defaults ON; '0' and 'false' disable", () => {
    expect(authorTimelineHydrationEnabled()).toBe(true);
    process.env.AUTHOR_TIMELINE_HYDRATION_ENABLED = "1";
    expect(authorTimelineHydrationEnabled()).toBe(true);
    process.env.AUTHOR_TIMELINE_HYDRATION_ENABLED = "0";
    expect(authorTimelineHydrationEnabled()).toBe(false);
    process.env.AUTHOR_TIMELINE_HYDRATION_ENABLED = "false";
    expect(authorTimelineHydrationEnabled()).toBe(false);
  });

  it("kill switch off ⇒ willHydrate false", () => {
    process.env.AUTHOR_TIMELINE_HYDRATION_ENABLED = "0";
    expect(willHydrateAuthorTimeline(AUTHOR, "nostr_external")).toBe(false);
  });

  it("only supported protocols hydrate (nostr first; rss/email never)", () => {
    expect(willHydrateAuthorTimeline(AUTHOR, "nostr_external")).toBe(true);
    expect(willHydrateAuthorTimeline(AUTHOR, "rss")).toBe(false);
    expect(willHydrateAuthorTimeline(AUTHOR, "email")).toBe(false);
  });

  it("TTL guard: a hydrate stamps the author; a second view within the window doesn't re-kick", async () => {
    expect(willHydrateAuthorTimeline(AUTHOR, "nostr_external")).toBe(true);
    await hydrateAuthorTimeline({
      authorId: AUTHOR,
      protocol: "nostr_external",
      followUri: PUBKEY,
      stableHandle: PUBKEY,
    });
    expect(willHydrateAuthorTimeline(AUTHOR, "nostr_external")).toBe(false);
    // …and the guard is per-author, not global.
    expect(
      willHydrateAuthorTimeline(
        "22222222-0000-4000-8000-000000000002",
        "nostr_external",
      ),
    ).toBe(true);
    resetAuthorTimelineGuard();
    expect(willHydrateAuthorTimeline(AUTHOR, "nostr_external")).toBe(true);
  });

  it("kill switch off ⇒ hydrate is a no-op and never stamps the guard", async () => {
    process.env.AUTHOR_TIMELINE_HYDRATION_ENABLED = "0";
    await hydrateAuthorTimeline({
      authorId: AUTHOR,
      protocol: "nostr_external",
      followUri: PUBKEY,
      stableHandle: PUBKEY,
    });
    delete process.env.AUTHOR_TIMELINE_HYDRATION_ENABLED;
    expect(willHydrateAuthorTimeline(AUTHOR, "nostr_external")).toBe(true);
  });

  // §0k.2 — a FAILED run must not consume the 10-minute TTL. Before the fix a
  // transient error left the guard stamped, freezing that author's timeline
  // hydration for the full window; and the atproto/AP fetchers silently
  // returned on 429/5xx (safeFetch returns, not throws, on those), so the
  // freeze never even logged as a failure.
  it("a thrown failure clears the guard so the next view retries (nostr)", async () => {
    vi.mocked(fetchNostrEvents).mockRejectedValueOnce(new Error("relay down"));
    await hydrateAuthorTimeline({
      authorId: AUTHOR,
      protocol: "nostr_external",
      followUri: PUBKEY,
      stableHandle: PUBKEY,
    });
    expect(willHydrateAuthorTimeline(AUTHOR, "nostr_external")).toBe(true);
  });

  it("a transient 5xx on the atproto timeline fetch clears the guard", async () => {
    vi.mocked(safeFetch).mockResolvedValueOnce({
      ok: false,
      status: 503,
      text: "",
    } as never);
    await hydrateAuthorTimeline({
      authorId: AUTHOR,
      protocol: "atproto",
      followUri: "did:plc:abc123",
      stableHandle: "author.example",
    });
    expect(willHydrateAuthorTimeline(AUTHOR, "atproto")).toBe(true);
  });

  it("a definitive 4xx is a clean settle — the guard stays stamped", async () => {
    // The default safeFetch mock answers 404 (deleted/blocked account):
    // nothing to hydrate, and re-fetching per view would buy nothing.
    await hydrateAuthorTimeline({
      authorId: AUTHOR,
      protocol: "atproto",
      followUri: "did:plc:abc123",
      stableHandle: "author.example",
    });
    expect(willHydrateAuthorTimeline(AUTHOR, "atproto")).toBe(false);
  });
});
