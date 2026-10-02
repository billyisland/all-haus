import { describe, it, expect, vi, beforeEach } from "vitest";

// =============================================================================
// MIRROR-AUDIT §2.9 (S9) — an ActivityPub object may only be authoritative for
// ids on the host it was fetched from.
//
// These drive the REAL `fetchActor` / `fetchOutbox` against a mocked
// `safeFetch`, because the fix is entirely about which url the comparison is
// made against and a test of the helper alone agrees with itself about that.
// The redirect case is the one that says the authority is `res.url` and not
// the uri we asked for; the missing-id case is the one that says the refusal
// replaced a FALLBACK, which a status-shaped assertion would pass either way.
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

const { fetchActor, fetchOutbox } = await import("./activitypub.js");

const PUBLIC = "https://www.w3.org/ns/activitystreams#Public";

function actorDoc(id: string, outbox: string) {
  return {
    id,
    type: "Person",
    name: "Alice",
    preferredUsername: "alice",
    outbox,
  };
}

function createOf(noteId: string, published: string) {
  return {
    id: `${noteId}/activity`,
    type: "Create",
    to: [PUBLIC],
    published,
    object: {
      id: noteId,
      type: "Note",
      to: [PUBLIC],
      content: "<p>hello</p>",
      published,
    },
  };
}

beforeEach(() => responses.clear());

describe("fetchActor — the actor id must be authoritative", () => {
  it("accepts an id on the origin that actually served the document", async () => {
    responses.set("https://good.social/users/alice", {
      body: actorDoc(
        "https://good.social/users/alice",
        "https://good.social/users/alice/outbox",
      ),
    });
    const actor = await fetchActor("https://good.social/users/alice");
    expect(actor.id).toBe("https://good.social/users/alice");
    expect(actor.host).toBe("good.social");
  });

  it("accepts an id on the POST-REDIRECT origin, not the one we asked for", async () => {
    // A legitimately redirecting instance: we ask for the apex, the document
    // is served from www and names itself there. Comparing against the
    // requested uri would refuse an ordinary fediverse deployment.
    responses.set("https://example.social/users/alice", {
      url: "https://www.example.social/users/alice",
      body: actorDoc(
        "https://www.example.social/users/alice",
        "https://www.example.social/users/alice/outbox",
      ),
    });
    const actor = await fetchActor("https://example.social/users/alice");
    expect(actor.id).toBe("https://www.example.social/users/alice");
  });

  it("refuses an id claiming another host", async () => {
    responses.set("https://hostile.example/users/x", {
      body: actorDoc(
        "https://mastodon.social/users/victim",
        "https://hostile.example/users/x/outbox",
      ),
    });
    await expect(
      fetchActor("https://hostile.example/users/x"),
    ).rejects.toThrow(/not authoritative/i);
  });

  it("refuses a document with no id rather than substituting the requested uri", async () => {
    // The old code read `actor.id ?? actorUri`, which made a document that
    // claimed nothing indistinguishable from one that claimed correctly.
    responses.set("https://hostile.example/users/x", {
      body: {
        type: "Person",
        preferredUsername: "x",
        outbox: "https://hostile.example/users/x/outbox",
      },
    });
    await expect(
      fetchActor("https://hostile.example/users/x"),
    ).rejects.toThrow(/not authoritative/i);
  });

  it("refuses a non-http id scheme", async () => {
    responses.set("https://hostile.example/users/x", {
      body: actorDoc(
        "javascript:alert(1)",
        "https://hostile.example/users/x/outbox",
      ),
    });
    await expect(
      fetchActor("https://hostile.example/users/x"),
    ).rejects.toThrow(/not authoritative/i);
  });
});

describe("fetchOutbox — a note id must be authoritative for its actor", () => {
  const actor = {
    reader: "outbox" as const,
    apiAccountId: null,
    id: "https://hostile.example/users/x",
    name: "X",
    preferredUsername: "x",
    summary: null,
    icon: null,
    outbox: "https://hostile.example/users/x/outbox",
    url: null,
    host: "hostile.example",
  };

  it("drops a Create claiming another instance's status id and keeps the sibling", async () => {
    const now = new Date().toISOString();
    responses.set(actor.outbox, {
      body: { first: "https://hostile.example/users/x/outbox?page=true" },
    });
    responses.set(
      "https://hostile.example/users/x/outbox?page=true&limit=20",
      {
        body: {
          orderedItems: [
            // The squat: a genuine mastodon.social status id, which inserted
            // first DO NOTHING-suppresses the real post for ever.
            createOf("https://mastodon.social/users/victim/statuses/1", now),
            createOf("https://hostile.example/users/x/statuses/2", now),
          ],
        },
      },
    );

    const result = await fetchOutbox(actor, {
      outboxUrl: actor.outbox,
      cursor: null,
      cutoffMs: Date.now() - 86_400_000,
      maxPages: 1,
      itemsPerPage: 20,
      maxItems: 50,
    });

    expect(result.items.map((i) => i.sourceItemUri)).toEqual([
      "https://hostile.example/users/x/statuses/2",
    ]);
  });
});
