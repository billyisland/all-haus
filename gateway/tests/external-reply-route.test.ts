import { describe, it, expect, vi, beforeEach } from "vitest";
import Fastify from "fastify";

// =============================================================================
// POST /external-items/:id/reply — what the reply says about itself
// (CROSS-NETWORK-ROUNDTRIP-ADR F7/A6 and F8/A7).
//
// A6: the Nostr copy of a reply to a Bluesky/Mastodon post went to our relay
// with NO tags — a context-free top-level note. The event the route SIGNS is
// captured at `signEvent`, because that is the only place the tags exist
// before they are on a relay.
//
// A7: a cross-post enqueue failure was swallowed into a bare 201, so the
// composer closed as if the reply had gone. The route now says `not_sent`.
//
// The pool mock answers from the SQL it is handed (testing rule 1): each
// statement is dispatched on its own table, and an unrecognised one fails the
// test rather than being answered with a fixture.
//
// Mutations: drop the `i`/`k`/`r` push → the two tag cases fail; hard-code
// `crossPost = "queued"` → the not-sent case fails.
// =============================================================================

const ACCOUNT = "00000000-0000-4000-8000-0000000000a1";
const ITEM = "00000000-0000-4000-8000-0000000000c3";
const LINKED = "00000000-0000-4000-8000-0000000000d4";

let item: Record<string, unknown>;
const unexpected: string[] = [];

function answer(sql: string) {
  if (/FROM external_items ei/.test(sql)) return { rows: [item] };
  if (/FROM network_presences/.test(sql))
    return { rows: [{ protocol: item.protocol, is_valid: true, lifecycle_state: "active" }] };
  if (/FROM accounts WHERE id/.test(sql))
    return { rows: [{ display_name: "Me", avatar_blossom_url: null, username: "me" }] };
  if (/INSERT INTO notes/.test(sql)) return { rows: [{ id: "note-1" }] };
  if (/INSERT INTO feed_items/.test(sql)) return { rows: [] };
  if (/relay_outbox/.test(sql)) return { rows: [{ id: "ro-1" }] };
  unexpected.push(sql.slice(0, 80));
  return { rows: [] };
}

vi.mock("@platform-pub/shared/db/client.js", () => ({
  pool: { query: async (sql: string) => answer(sql) },
  withTransaction: async (fn: (c: unknown) => Promise<unknown>) =>
    fn({ query: async (sql: string) => answer(sql) }),
}));
vi.mock("@platform-pub/shared/lib/relay-outbox.js", () => ({
  enqueueRelayPublish: vi.fn(async () => undefined),
}));
vi.mock("@platform-pub/shared/lib/logger.js", () => ({
  default: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));
const signEvent = vi.fn(async (_account: string, t: { tags: string[][] }) => ({
  id: "e".repeat(64),
  pubkey: "p".repeat(64),
  sig: "s".repeat(128),
  kind: 1,
  content: "",
  created_at: 0,
  tags: t.tags,
}));
vi.mock("../src/lib/key-custody-client.js", () => ({ signEvent }));
const enqueueCrossPost = vi.fn(async () => undefined);
vi.mock("../src/lib/outbound-enqueue.js", () => ({
  enqueueCrossPost,
  enqueueLike: vi.fn(),
  enqueueRepost: vi.fn(),
  enqueuePollVote: vi.fn(),
  enqueueNostrOutbound: vi.fn(),
}));
vi.mock("../src/middleware/auth.js", () => ({
  requireAuth: async (req: { session?: { sub: string } }) => {
    req.session = { sub: ACCOUNT };
  },
  optionalAuth: async () => {},
}));

const { registerInteractionRoutes, externalParentWebUrl } = await import(
  "../src/routes/external-items/interactions.js"
);

async function send() {
  const app = Fastify({ logger: false });
  await app.register(async (i) => registerInteractionRoutes(i));
  await app.ready();
  const res = await app.inject({
    method: "POST",
    url: `/external-items/${ITEM}/reply`,
    payload: { linkedAccountId: LINKED, content: "hello" },
  });
  await app.close();
  return res;
}

const baseItem = (over: Record<string, unknown>) => ({
  id: ITEM,
  source_id: "src",
  source_reply_uri: null,
  like_count: 0,
  reply_count: 0,
  repost_count: 0,
  interaction_data: {},
  canonical_url: null,
  relay_urls: null,
  ...over,
});

beforeEach(() => {
  signEvent.mockClear();
  enqueueCrossPost.mockReset();
  enqueueCrossPost.mockResolvedValue(undefined);
  unexpected.length = 0;
});

describe("the Nostr copy says what it answers (A6)", () => {
  it("a Bluesky parent: NIP-73 i/k and r, at the bsky.app URL", async () => {
    item = baseItem({
      protocol: "atproto",
      source_item_uri: "at://did:plc:bob/app.bsky.feed.post/3kabc",
    });

    const res = await send();

    expect(res.statusCode).toBe(201);
    const url = "https://bsky.app/profile/did:plc:bob/post/3kabc";
    expect(signEvent.mock.calls[0][1].tags).toEqual([["i", url], ["k", "web"], ["r", url]]);
    expect(unexpected).toEqual([]);
  });

  it("a Mastodon parent: its declared permalink wins over the AP id", async () => {
    item = baseItem({
      protocol: "activitypub",
      source_item_uri: "https://m.example/users/bob/statuses/1",
      canonical_url: "https://m.example/@bob/1",
    });

    await send();

    expect(signEvent.mock.calls[0][1].tags).toContainEqual(["i", "https://m.example/@bob/1"]);
  });
});

describe("a cross-post that was never queued is SAID (A7)", () => {
  it("answers crossPost: queued when the enqueue lands", async () => {
    item = baseItem({ protocol: "atproto", source_item_uri: "at://did:plc:bob/app.bsky.feed.post/1" });
    const res = await send();
    expect(res.json()).toMatchObject({ crossPost: "queued" });
  });

  it("answers 201 with crossPost: not_sent when it does not", async () => {
    item = baseItem({ protocol: "atproto", source_item_uri: "at://did:plc:bob/app.bsky.feed.post/1" });
    enqueueCrossPost.mockRejectedValueOnce(new Error("db gone"));

    const res = await send();

    // The note exists: 201 is still right. What changed is that it is not silent.
    expect(res.statusCode).toBe(201);
    expect(res.json()).toMatchObject({ crossPost: "not_sent" });
  });
});

describe("externalParentWebUrl", () => {
  it("a non-URL identity with no permalink is no URL", () => {
    expect(
      externalParentWebUrl({ protocol: "rss", source_item_uri: "urn:uuid:1", canonical_url: null }),
    ).toBeNull();
  });
  it("a non-http canonical is refused and the identity used instead", () => {
    expect(
      externalParentWebUrl({
        protocol: "activitypub",
        source_item_uri: "https://m.example/users/bob/statuses/1",
        canonical_url: "javascript:alert(1)",
      }),
    ).toBe("https://m.example/users/bob/statuses/1");
  });
});
