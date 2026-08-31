import { describe, it, expect, vi } from "vitest";

// These task modules import the shared pool / logger at top level; the pure
// helpers under test don't touch them, but stub the modules so importing the
// task doesn't reach for a real DB connection.
vi.mock("@platform-pub/shared/db/client.js", () => ({ pool: {} }));
vi.mock("@platform-pub/shared/lib/logger.js", () => ({
  default: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

const { cardToLinkMedia, mergeLinkMedia } =
  await import("./external-engagement-refresh.js");
const { extractBlueskyViewMedia, mastodonCardToMedia } =
  await import("./external-parent-prefetch.js");

describe("cardToLinkMedia", () => {
  it("returns null when there is no card", () => {
    expect(cardToLinkMedia(null)).toBeNull();
    expect(cardToLinkMedia(undefined)).toBeNull();
    expect(cardToLinkMedia({})).toBeNull();
  });

  it("normalises a link card into a {type:'link'} media entry", () => {
    expect(
      cardToLinkMedia({
        url: "https://example.com/post",
        title: "A headline",
        description: "A standfirst",
        image: "https://example.com/thumb.jpg",
        type: "link",
      }),
    ).toEqual({
      type: "link",
      url: "https://example.com/post",
      title: "A headline",
      description: "A standfirst",
      thumbnail: "https://example.com/thumb.jpg",
    });
  });

  it("ignores photo/video cards (already covered by media_attachments)", () => {
    expect(cardToLinkMedia({ url: "https://x/y", type: "video" })).toBeNull();
  });
});

describe("mergeLinkMedia", () => {
  it("appends a fresh link, preserving image/video media", () => {
    const existing = [{ type: "image" as const, url: "https://img/1.jpg" }];
    const link = { type: "link" as const, url: "https://example.com/a" };
    expect(mergeLinkMedia(existing, link)).toEqual([...existing, link]);
  });

  it("replaces a stale link with the fresh one", () => {
    const existing = [
      { type: "image" as const, url: "https://img/1.jpg" },
      { type: "link" as const, url: "https://old/link" },
    ];
    const link = { type: "link" as const, url: "https://new/link" };
    expect(mergeLinkMedia(existing, link)).toEqual([
      { type: "image", url: "https://img/1.jpg" },
      link,
    ]);
  });

  it("returns null when nothing changes (no card, no existing link)", () => {
    const existing = [{ type: "image" as const, url: "https://img/1.jpg" }];
    expect(mergeLinkMedia(existing, null)).toBeNull();
  });

  it("drops a stale link when the fresh card is gone", () => {
    const existing = [
      { type: "image" as const, url: "https://img/1.jpg" },
      { type: "link" as const, url: "https://old/link" },
    ];
    expect(mergeLinkMedia(existing, null)).toEqual([
      { type: "image", url: "https://img/1.jpg" },
    ]);
  });
});

describe("mastodonCardToMedia", () => {
  it("normalises a link card; ignores non-link cards", () => {
    expect(mastodonCardToMedia({ url: "https://e/p", type: "link" })).toEqual({
      type: "link",
      url: "https://e/p",
      thumbnail: undefined,
      title: undefined,
      description: undefined,
    });
    expect(
      mastodonCardToMedia({ url: "https://e/p", type: "photo" }),
    ).toBeNull();
    expect(mastodonCardToMedia(null)).toBeNull();
  });
});

describe("extractBlueskyViewMedia", () => {
  it("extracts images from an images#view embed", () => {
    const media = extractBlueskyViewMedia({
      $type: "app.bsky.embed.images#view",
      images: [
        {
          fullsize: "https://cdn/full.jpg",
          thumb: "https://cdn/thumb.jpg",
          alt: "alt",
        },
      ],
    });
    expect(media).toEqual([
      {
        type: "image",
        url: "https://cdn/full.jpg",
        thumbnail: "https://cdn/thumb.jpg",
        alt: "alt",
      },
    ]);
  });

  it("extracts a link card from an external#view embed", () => {
    const media = extractBlueskyViewMedia({
      $type: "app.bsky.embed.external#view",
      external: {
        uri: "https://example.com/a",
        title: "T",
        description: "D",
        thumb: "https://cdn/t.jpg",
      },
    });
    expect(media).toEqual([
      {
        type: "link",
        url: "https://example.com/a",
        thumbnail: "https://cdn/t.jpg",
        title: "T",
        description: "D",
      },
    ]);
  });

  it("extracts video from a video#view embed", () => {
    const media = extractBlueskyViewMedia({
      $type: "app.bsky.embed.video#view",
      playlist: "https://video/p.m3u8",
      thumbnail: "https://video/t.jpg",
    });
    expect(media).toEqual([
      {
        type: "video",
        url: "https://video/p.m3u8",
        thumbnail: "https://video/t.jpg",
      },
    ]);
  });

  it("reads the media side of recordWithMedia#view (no quote-of-quote recursion)", () => {
    const media = extractBlueskyViewMedia({
      $type: "app.bsky.embed.recordWithMedia#view",
      record: { record: { uri: "at://nested/quote" } },
      media: {
        $type: "app.bsky.embed.images#view",
        images: [{ fullsize: "https://cdn/full.jpg" }],
      },
    });
    expect(media).toEqual([
      {
        type: "image",
        url: "https://cdn/full.jpg",
        thumbnail: undefined,
        alt: undefined,
      },
    ]);
  });

  it("returns [] for a record#view embed (pure quote, no media)", () => {
    expect(
      extractBlueskyViewMedia({
        $type: "app.bsky.embed.record#view",
        record: {},
      }),
    ).toEqual([]);
  });

  it("returns [] for undefined / unknown embeds", () => {
    expect(extractBlueskyViewMedia(undefined)).toEqual([]);
    expect(extractBlueskyViewMedia({ $type: "weird" })).toEqual([]);
  });
});
