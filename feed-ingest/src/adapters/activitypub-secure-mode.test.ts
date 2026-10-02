import { describe, it, expect, vi, beforeEach } from "vitest";

// =============================================================================
// AUTHORIZED_FETCH — reading an instance that refuses unsigned ActivityPub
//
// These drive the REAL `fetchActor` / `fetchMastodonTimeline` against a mocked
// `safeFetch`, because what is under test is entirely about WHICH url is asked
// for after a refusal and what is done with the answer — a test of a helper in
// isolation would agree with itself about both.
//
// The mock answers from the URL it is handed (status included), so a route
// that asks the wrong endpoint gets `unexpected fetch` rather than a fixture.
// =============================================================================

interface Reply {
  /** A transport fault: the fetch THROWS this rather than answering. */
  throws?: Error;
  status?: number;
  body?: unknown;
  url?: string;
}

const responses = new Map<string, Reply>();
const asked: string[] = [];

vi.mock("@platform-pub/shared/lib/http-client.js", () => ({
  safeFetch: vi.fn(async (url: string) => {
    asked.push(url);
    const hit = responses.get(url);
    if (!hit) throw new Error(`unexpected fetch: ${url}`);
    if (hit.throws) throw hit.throws;
    const status = hit.status ?? 200;
    return {
      ok: status >= 200 && status < 300,
      status,
      headers: new Headers(),
      text: JSON.stringify(hit.body ?? {}),
      url: hit.url ?? url,
    };
  }),
}));

vi.mock("@platform-pub/shared/lib/logger.js", () => ({
  default: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

const { fetchActor, fetchMastodonTimeline } = await import("./activitypub.js");

const ACTOR = "https://secure.example/users/alice";
const LOOKUP =
  "https://secure.example/api/v1/accounts/lookup?acct=alice%40secure.example";

function account(over: Record<string, unknown> = {}) {
  return {
    id: "42",
    acct: "alice",
    uri: ACTOR,
    url: "https://secure.example/@alice",
    display_name: "Alice",
    note: "<p>bio</p>",
    avatar: "https://secure.example/a.png",
    following_count: 3,
    followers_count: 9,
    statuses_count: 100,
    ...over,
  };
}

function status(over: Record<string, unknown> = {}) {
  return {
    id: "1000",
    uri: `${ACTOR}/statuses/1000`,
    url: "https://secure.example/@alice/1000",
    created_at: new Date().toISOString(),
    in_reply_to_id: null,
    visibility: "public",
    language: "en",
    content: "<p>hello</p>",
    spoiler_text: "",
    sensitive: false,
    account: account(),
    media_attachments: [],
    reblog: null,
    ...over,
  };
}

const statusesUrl = (maxId?: string) =>
  `https://secure.example/api/v1/accounts/42/statuses?limit=20` +
  (maxId ? `&max_id=${maxId}` : "");

beforeEach(() => {
  responses.clear();
  asked.length = 0;
});

describe("fetchActor — a 401 is not the end of the road", () => {
  it("falls back to the client API and says which reader to use", async () => {
    responses.set(ACTOR, { status: 401, body: { error: "Request not signed" } });
    responses.set(LOOKUP, { body: account() });

    const actor = await fetchActor(ACTOR);

    expect(actor.reader).toBe("mastodon_api");
    expect(actor.apiAccountId).toBe("42");
    expect(actor.outbox).toBeNull();
    // The author fields the ingest rule resolves through the SOURCE.
    expect(actor.id).toBe(ACTOR);
    expect(actor.name).toBe("Alice");
    expect(actor.preferredUsername).toBe("alice");
    expect(actor.host).toBe("secure.example");
    // Bio arrives as text, not the html the client API serves.
    expect(actor.summary).toBe("bio");
  });

  it("does NOT fall back on a 404 — that is a fact about the account", async () => {
    responses.set(ACTOR, { status: 404 });
    // No lookup response registered: reaching for one throws `unexpected
    // fetch`, so this pins that the second door is not opened rather than
    // merely that the result was an error either way.
    await expect(fetchActor(ACTOR)).rejects.toThrow(/HTTP 404/);
    expect(asked).toEqual([ACTOR]);
  });

  it("refuses an account uri claiming another host (§2.9 is not relaxed)", async () => {
    responses.set(ACTOR, { status: 401 });
    responses.set(LOOKUP, {
      body: account({ uri: "https://victim.example/users/bob" }),
    });
    // The fallback must not become a second door for a claim the front door
    // would have refused.
    await expect(fetchActor(ACTOR)).rejects.toThrow(/HTTP 401/);
  });

  it("keeps the uri we asked for when the instance serves none", async () => {
    responses.set(ACTOR, { status: 401 });
    responses.set(LOOKUP, { body: account({ uri: undefined }) });
    const actor = await fetchActor(ACTOR);
    // Ours, not the document's — so nothing is taken on the instance's word.
    expect(actor.id).toBe(ACTOR);
  });

  it("falls back on a transport THROW too — a timeout is not a verdict on the account", async () => {
    // The gateway's reader always did this; ingest let the throw spend the
    // source's error budget (§0ab (ii)).
    responses.set(ACTOR, { throws: new Error("timeout") });
    responses.set(LOOKUP, { body: account() });

    const actor = await fetchActor(ACTOR);

    expect(actor.reader).toBe("mastodon_api");
    expect(actor.id).toBe(ACTOR);
    expect(asked).toEqual([ACTOR, LOOKUP]);
  });

  it("re-throws the ORIGINAL transport error when the client API cannot stand in", async () => {
    const original = new Error("connect ECONNREFUSED");
    responses.set(ACTOR, { throws: original });
    responses.set(LOOKUP, { status: 404 });

    // By identity: the ingest task classifies the error it is handed, and a
    // fallback failure must not replace the failure it was trying to cover.
    await expect(fetchActor(ACTOR)).rejects.toBe(original);
    expect(asked).toEqual([ACTOR, LOOKUP]);
  });

  it("re-throws the original when the fallback's own fetch throws too", async () => {
    // Pinned end to end: the client-API helper answers null on a throw, which
    // is what lets `fetchActor` call it bare.
    const original = new Error("socket hang up");
    responses.set(ACTOR, { throws: original });
    responses.set(LOOKUP, { throws: new Error("fallback down too") });

    await expect(fetchActor(ACTOR)).rejects.toBe(original);
  });

  it("prefers ActivityPub when the instance answers it", async () => {
    responses.set(ACTOR, {
      body: {
        id: ACTOR,
        type: "Person",
        name: "Alice",
        preferredUsername: "alice",
        outbox: `${ACTOR}/outbox`,
      },
    });
    const actor = await fetchActor(ACTOR);
    expect(actor.reader).toBe("outbox");
    expect(actor.outbox).toBe(`${ACTOR}/outbox`);
    expect(asked).toEqual([ACTOR]);
  });
});

describe("fetchMastodonTimeline", () => {
  const actor = {
    reader: "mastodon_api" as const,
    apiAccountId: "42",
    id: ACTOR,
    name: "Alice",
    preferredUsername: "alice",
    summary: null,
    icon: "https://secure.example/a.png",
    outbox: null,
    url: null,
    host: "secure.example",
  };

  const opts = {
    cursor: null,
    cutoffMs: Date.now() - 86_400_000,
    maxPages: 1,
    itemsPerPage: 20,
    maxItems: 50,
  };

  it("maps a status into the outbox path's id-space and author fields", async () => {
    responses.set(statusesUrl(), { body: [status()] });

    const { items } = await fetchMastodonTimeline(actor, opts);

    expect(items).toHaveLength(1);
    // `Status.uri` IS the federated id — the same value the outbox writes, so
    // a source that switches reader dedups against itself rather than minting
    // a second post_id for a status already ingested.
    expect(items[0].sourceItemUri).toBe(`${ACTOR}/statuses/1000`);
    expect(items[0].webUrl).toBe("https://secure.example/@alice/1000");
    // Author resolved through the SOURCE, byte-identical to normaliseNote —
    // an ingester whose two readers disagree makes the nightly author-name
    // pass flap for ever.
    expect(items[0].authorName).toBe("Alice");
    expect(items[0].authorHandle).toBe("alice@secure.example");
    expect(items[0].authorUri).toBe(ACTOR);
    expect(items[0].contentText).toBe("hello");
  });

  it("records a boost as a repost edge, never as a post", async () => {
    responses.set(statusesUrl(), {
      body: [
        status({
          id: "2000",
          uri: `${ACTOR}/statuses/2000`,
          reblog: status({
            id: "77",
            uri: "https://other.example/users/bob/statuses/77",
          }),
        }),
      ],
    });

    const { items, reposts } = await fetchMastodonTimeline(actor, opts);

    expect(items).toHaveLength(0);
    expect(reposts).toHaveLength(1);
    expect(reposts[0].targetHandle).toBe(
      "https://other.example/users/bob/statuses/77",
    );
    expect(reposts[0].actorHandle).toBe(ACTOR);
  });

  it("resolves a reply's parent uri, which the client API only gives as a local id", async () => {
    responses.set(statusesUrl(), {
      body: [status({ id: "3000", uri: `${ACTOR}/statuses/3000`, in_reply_to_id: "999" })],
    });
    responses.set("https://secure.example/api/v1/statuses/999", {
      body: status({ id: "999", uri: "https://other.example/users/bob/statuses/999" }),
    });

    const { items } = await fetchMastodonTimeline(actor, opts);

    expect(items).toHaveLength(1);
    expect(items[0].sourceReplyUri).toBe(
      "https://other.example/users/bob/statuses/999",
    );
    expect(items[0].interactionData.replyTo).toBe(
      "https://other.example/users/bob/statuses/999",
    );
  });

  it("SKIPS a reply whose parent cannot be resolved rather than filing it as a root", async () => {
    responses.set(statusesUrl(), {
      body: [
        status({ id: "3000", uri: `${ACTOR}/statuses/3000`, in_reply_to_id: "999" }),
        status({ id: "3001", uri: `${ACTOR}/statuses/3001` }),
      ],
    });
    responses.set("https://secure.example/api/v1/statuses/999", { status: 404 });

    const { items } = await fetchMastodonTimeline(actor, opts);

    // A reply inserted with a null parent is not a smaller feed, it is a wrong
    // one: it renders as somebody starting the conversation they were
    // answering. The sibling still arrives — the loop does not abort.
    expect(items.map((i) => i.sourceItemUri)).toEqual([`${ACTOR}/statuses/3001`]);
  });

  it("skips a status claiming an id on another host", async () => {
    responses.set(statusesUrl(), {
      body: [
        status({ id: "4000", uri: "https://victim.example/users/x/statuses/4000" }),
        status({ id: "4001", uri: `${ACTOR}/statuses/4001` }),
      ],
    });

    const { items } = await fetchMastodonTimeline(actor, opts);

    expect(items.map((i) => i.sourceItemUri)).toEqual([`${ACTOR}/statuses/4001`]);
  });

  it("drops non-public statuses, matching the outbox reader's audience filter", async () => {
    responses.set(statusesUrl(), {
      body: [
        status({ id: "5000", uri: `${ACTOR}/statuses/5000`, visibility: "private" }),
        status({ id: "5001", uri: `${ACTOR}/statuses/5001`, visibility: "unlisted" }),
      ],
    });

    const { items } = await fetchMastodonTimeline(actor, opts);

    // `unlisted` carries Public in cc, so the outbox reader admits it too.
    expect(items.map((i) => i.sourceItemUri)).toEqual([`${ACTOR}/statuses/5001`]);
  });

  it("stops at the cursor and reports the newest accepted id as the new one", async () => {
    responses.set(statusesUrl(), {
      body: [
        status({ id: "6002", uri: `${ACTOR}/statuses/6002` }),
        status({ id: "6001", uri: `${ACTOR}/statuses/6001` }),
        status({ id: "6000", uri: `${ACTOR}/statuses/6000` }),
      ],
    });

    const { items, newCursor } = await fetchMastodonTimeline(actor, {
      ...opts,
      cursor: `${ACTOR}/statuses/6001`,
    });

    expect(items.map((i) => i.sourceItemUri)).toEqual([`${ACTOR}/statuses/6002`]);
    expect(newCursor).toBe(`${ACTOR}/statuses/6002`);
  });

  it("throws on an unreadable page rather than advancing the cursor past unseen posts", async () => {
    responses.set(statusesUrl(), { status: 503 });
    await expect(fetchMastodonTimeline(actor, opts)).rejects.toThrow(
      /could not be read/,
    );
  });
});
