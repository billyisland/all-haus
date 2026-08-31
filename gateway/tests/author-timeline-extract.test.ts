import { describe, it, expect } from "vitest";
import {
  extractAtprotoTimelineNodes,
  extractMastodonTimelineNodes,
  actorHandleFromUri,
} from "../src/lib/author-timeline-hydration.js";

// =============================================================================
// EXTERNAL-AUTHOR-HISTORY-ADR §3.5 phase 2 / §7 Phase 4 — the pure
// per-protocol timeline normalisers behind hydrateAuthorTimeline. The critical
// property both share: author_uri is pinned to the profile's stable_handle
// VERBATIM, because the feed_items identity trigger mints external_authors
// from external_items.author_uri for atproto/activitypub — an origin-shaped
// author_uri would file the timeline under a different author id and the
// profile would stay empty.
// =============================================================================

const DID = "did:plc:author123";
const STABLE = "did:plc:author123"; // the profile's stable_handle

describe("extractAtprotoTimelineNodes", () => {
  const post = (over: Record<string, unknown> = {}, rkey = "r1") => ({
    post: {
      uri: `at://${DID}/app.bsky.feed.post/${rkey}`,
      cid: `cid-${rkey}`,
      author: { did: DID, handle: "author.bsky.social", displayName: "Author" },
      record: {
        $type: "app.bsky.feed.post",
        text: "hello",
        createdAt: "2026-06-01T10:00:00.000Z",
      },
      likeCount: 3,
      replyCount: 1,
      repostCount: 2,
      ...over,
    },
  });

  it("maps a post and pins author_uri to the stable handle", () => {
    const nodes = extractAtprotoTimelineNodes([post()], DID, STABLE);
    expect(nodes).toHaveLength(1);
    expect(nodes[0]).toMatchObject({
      sourceItemUri: `at://${DID}/app.bsky.feed.post/r1`,
      authorUri: STABLE, // pinned — NOT a bsky.app profile URL
      authorHandle: "author.bsky.social",
      authorName: "Author",
      contentText: "hello",
      likeCount: 3,
      replyCount: 1,
      repostCount: 2,
    });
    expect(nodes[0].interactionData).toEqual({
      uri: `at://${DID}/app.bsky.feed.post/r1`,
      cid: "cid-r1",
    });
    expect(nodes[0].publishedAt.toISOString()).toBe(
      "2026-06-01T10:00:00.000Z",
    );
  });

  it("skips reposts (reason), foreign DIDs, non-post records, and dedupes", () => {
    const repost = {
      ...post({}, "r2"),
      reason: { $type: "app.bsky.feed.defs#reasonRepost" },
    };
    const foreign = post(
      { author: { did: "did:plc:other", handle: "other.bsky.social" } },
      "r3",
    );
    const nonPost = post({ record: { $type: "app.bsky.feed.like" } }, "r4");
    const dupe = post({}, "r1");
    const nodes = extractAtprotoTimelineNodes(
      [post(), repost, foreign, nonPost, dupe],
      DID,
      STABLE,
    );
    expect(nodes).toHaveLength(1);
  });

  it("carries the reply linkage when present", () => {
    const reply = post(
      { record: { text: "re", reply: { parent: { uri: "at://x/p/parent" } } } },
      "r5",
    );
    const nodes = extractAtprotoTimelineNodes([reply], DID, STABLE);
    expect(nodes[0].sourceReplyUri).toBe("at://x/p/parent");
  });
});

describe("extractMastodonTimelineNodes", () => {
  const ACTOR = "https://mastodon.example/users/author";
  const status = (over: Record<string, unknown> = {}, id = "1") => ({
    id,
    uri: `https://mastodon.example/users/author/statuses/${id}`,
    url: `https://mastodon.example/@author/${id}`,
    content: "<p>toot <b>body</b></p>",
    created_at: "2026-06-01T11:00:00.000Z",
    in_reply_to_id: null,
    account: {
      acct: "author@mastodon.example",
      display_name: "AP Author",
      url: "https://mastodon.example/@author",
    },
    favourites_count: 4,
    replies_count: 1,
    reblogs_count: 2,
    ...over,
  });

  it("maps a status, keys on the federated uri, pins author_uri to the stable handle", () => {
    const nodes = extractMastodonTimelineNodes([status()], ACTOR);
    expect(nodes).toHaveLength(1);
    expect(nodes[0]).toMatchObject({
      sourceItemUri: "https://mastodon.example/users/author/statuses/1",
      authorUri: ACTOR, // pinned — NOT account.url (the web-profile shape)
      authorHandle: "author@mastodon.example",
      authorName: "AP Author",
      contentText: "toot body",
      likeCount: 4,
    });
    expect(nodes[0].contentHtml).toContain("toot");
  });

  it("skips replies and reblogs, and dedupes by uri", () => {
    const reply = status({ in_reply_to_id: "99" }, "2");
    const reblog = status({ reblog: { id: "x" } }, "3");
    const dupe = status({}, "1");
    const nodes = extractMastodonTimelineNodes(
      [status(), reply, reblog, dupe],
      ACTOR,
    );
    expect(nodes).toHaveLength(1);
  });

  it("maps media attachments", () => {
    const withMedia = status(
      {
        media_attachments: [
          { type: "image", url: "https://m.example/i.jpg", preview_url: "https://m.example/t.jpg", description: "alt" },
          { type: "audio", url: "https://m.example/a.mp3" },
        ],
      },
      "4",
    );
    const nodes = extractMastodonTimelineNodes([withMedia], ACTOR);
    expect(nodes[0].media).toEqual([
      { type: "image", url: "https://m.example/i.jpg", thumbnail: "https://m.example/t.jpg", alt: "alt" },
      { type: "link", url: "https://m.example/a.mp3", thumbnail: undefined, alt: undefined },
    ]);
  });
});

describe("actorHandleFromUri", () => {
  it("extracts from /@name and /users/name shapes", () => {
    expect(actorHandleFromUri("https://m.example/@alice")).toBe("alice");
    expect(actorHandleFromUri("https://m.example/users/bob")).toBe("bob");
    expect(actorHandleFromUri("https://m.example/nothing")).toBeNull();
  });
});
