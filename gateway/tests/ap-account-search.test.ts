import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

// =============================================================================
// ActivityPub account search provider (RESOLVER-DISCOVERY-ADR §5.2 — Phase 2).
//
// Mastodon instance search behind the ApAccountSearchProvider interface:
// acct canonicalisation (domainless local accts get the instance host),
// cross-instance dedupe, per-instance fail-soft, the 5-min memo, env parsing.
// safeFetch is mocked — no live I/O.
// =============================================================================

const mockSafeFetch = vi.fn();

vi.mock("@platform-pub/shared/lib/http-client.js", () => ({
  safeFetch: (...a: any[]) => mockSafeFetch(...a),
  pinnedWebSocketOptions: vi.fn(),
}));

vi.mock("@platform-pub/shared/lib/logger.js", () => ({
  default: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

const { searchApAccounts, clearApAccountSearchMemo } = await import(
  "../src/lib/ap-account-search.js"
);

function okSearch(accounts: any[]) {
  return {
    ok: true,
    status: 200,
    text: JSON.stringify({ accounts }),
    headers: { get: () => null },
  };
}

const ALICE = {
  acct: "alice", // domainless — local to the queried instance
  display_name: "Alice",
  avatar: "https://cdn.example/alice.png",
  note: "<p>Writes about <b>gardens</b>.</p>",
  uri: "https://mastodon.social/users/alice",
  url: "https://mastodon.social/@alice",
};
const BOB_REMOTE = {
  acct: "bob@other.instance",
  display_name: "Bob",
  note: "",
};

const savedEnv = process.env.MASTODON_DISCOVERY_INSTANCES;

beforeEach(() => {
  vi.clearAllMocks();
  clearApAccountSearchMemo();
  delete process.env.MASTODON_DISCOVERY_INSTANCES;
  mockSafeFetch.mockResolvedValue(okSearch([]));
});

afterEach(() => {
  if (savedEnv === undefined) delete process.env.MASTODON_DISCOVERY_INSTANCES;
  else process.env.MASTODON_DISCOVERY_INSTANCES = savedEnv;
});

describe("acct canonicalisation", () => {
  it("appends the instance host to a domainless local acct", async () => {
    mockSafeFetch.mockResolvedValue(okSearch([ALICE]));

    const out = await searchApAccounts("alice", 5);

    expect(out).toHaveLength(1);
    expect(out[0].acct).toBe("alice@mastodon.social");
  });

  it("keeps a domain-qualified acct as-is", async () => {
    mockSafeFetch.mockResolvedValue(okSearch([BOB_REMOTE]));

    const out = await searchApAccounts("bob", 5);

    expect(out[0].acct).toBe("bob@other.instance");
  });

  it("maps display name, avatar, plain-texted note, and the actor URI", async () => {
    mockSafeFetch.mockResolvedValue(okSearch([ALICE]));

    const [c] = await searchApAccounts("alice", 5);

    expect(c.displayName).toBe("Alice");
    expect(c.avatar).toBe("https://cdn.example/alice.png");
    expect(c.note).toBe("Writes about gardens.");
    // Account.uri (the actor identifier) wins over the profile URL — it's the
    // dedupe key against known-world stable_handle actor URIs.
    expect(c.url).toBe("https://mastodon.social/users/alice");
  });

  it("skips malformed account entries without an acct", async () => {
    mockSafeFetch.mockResolvedValue(
      okSearch([{ display_name: "No acct" }, null, ALICE]),
    );

    const out = await searchApAccounts("alice", 5);

    expect(out).toHaveLength(1);
    expect(out[0].acct).toBe("alice@mastodon.social");
  });
});

describe("instances + dedupe", () => {
  it("queries every configured instance and dedupes by lowercased canonical acct", async () => {
    process.env.MASTODON_DISCOVERY_INSTANCES = "mastodon.social, fosstodon.org";
    mockSafeFetch.mockImplementation(async (url: string) => {
      if (url.startsWith("https://mastodon.social/"))
        return okSearch([ALICE, BOB_REMOTE]);
      // fosstodon knows alice as a remote account — same identity, different casing.
      return okSearch([{ acct: "Alice@mastodon.social", display_name: "alice (remote)" }]);
    });

    const out = await searchApAccounts("alice", 5);

    expect(mockSafeFetch).toHaveBeenCalledTimes(2);
    const accts = out.map((c) => c.acct.toLowerCase());
    expect(accts).toEqual(["alice@mastodon.social", "bob@other.instance"]);
    // First-listed instance's metadata wins.
    expect(out[0].displayName).toBe("Alice");
  });

  it("defaults to mastodon.social when the env is unset", async () => {
    mockSafeFetch.mockResolvedValue(okSearch([]));

    await searchApAccounts("someone", 5);

    expect(mockSafeFetch).toHaveBeenCalledTimes(1);
    expect(String(mockSafeFetch.mock.calls[0][0])).toContain(
      "https://mastodon.social/api/v2/search?",
    );
  });

  it("caps the merged result at the requested limit", async () => {
    mockSafeFetch.mockResolvedValue(
      okSearch(
        Array.from({ length: 8 }, (_, i) => ({ acct: `user${i}@a.example` })),
      ),
    );

    const out = await searchApAccounts("user", 5);

    expect(out).toHaveLength(5);
  });
});

describe("fail-soft + gating", () => {
  it("one failing instance degrades to the other's results", async () => {
    process.env.MASTODON_DISCOVERY_INSTANCES = "down.example,mastodon.social";
    mockSafeFetch.mockImplementation(async (url: string) => {
      if (url.startsWith("https://down.example/"))
        throw new Error("connect ECONNREFUSED");
      return okSearch([ALICE]);
    });

    const out = await searchApAccounts("alice", 5);

    expect(out).toHaveLength(1);
    expect(out[0].acct).toBe("alice@mastodon.social");
  });

  it("a 429 fails soft to no candidates", async () => {
    mockSafeFetch.mockResolvedValue({
      ok: false,
      status: 429,
      text: "",
      headers: { get: () => null },
    });

    const out = await searchApAccounts("alice", 5);

    expect(out).toEqual([]);
  });

  it("queries shorter than 3 chars never hit the network", async () => {
    const out = await searchApAccounts("ab", 5);

    expect(out).toEqual([]);
    expect(mockSafeFetch).not.toHaveBeenCalled();
  });
});

describe("memo", () => {
  it("a repeated query within the TTL is served from the memo", async () => {
    mockSafeFetch.mockResolvedValue(okSearch([ALICE]));

    const first = await searchApAccounts("alice", 5);
    const second = await searchApAccounts("alice", 5);

    expect(mockSafeFetch).toHaveBeenCalledTimes(1);
    expect(second).toEqual(first);
  });

  it("memo keys are case-insensitive on the query", async () => {
    mockSafeFetch.mockResolvedValue(okSearch([ALICE]));

    await searchApAccounts("Alice", 5);
    await searchApAccounts("alice", 5);

    expect(mockSafeFetch).toHaveBeenCalledTimes(1);
  });

  it("an errored instance is memoed too — no immediate retry", async () => {
    mockSafeFetch.mockRejectedValue(new Error("boom"));

    await searchApAccounts("alice", 5);
    await searchApAccounts("alice", 5);

    expect(mockSafeFetch).toHaveBeenCalledTimes(1);
  });
});
