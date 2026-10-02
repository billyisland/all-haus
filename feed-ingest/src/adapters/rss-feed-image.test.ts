import { describe, it, expect, vi, beforeEach } from "vitest";

// =============================================================================
// A FEED'S OWN PICTURE IS READ BY THE POLL, AND REFUSED WHERE IT IS STORED
// (CA-H2, 2026-09-30).
//
// The source's avatar used to be written by a daily `source_metadata_refresh`
// task that selected the 200 least-recently-updated sources of EVERY protocol
// and acted only on RSS — while the RSS poll stamps `updated_at` on every
// fetch, so RSS rows sorted last and the task never reached one. It also
// stored `feed.image.url` raw. The adapter now reports the image and the poll
// writes it, through `httpUrlOrNull`: it is rendered as an <img> src, so a
// `javascript:` or `data:` value from the wire must never be stored.
// =============================================================================

const safeFetch = vi.fn();
vi.mock("@platform-pub/shared/lib/http-client.js", () => ({
  safeFetch: (...a: unknown[]) => safeFetch(...a),
}));
vi.mock("@platform-pub/shared/lib/logger.js", () => ({
  default: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

const { fetchRssFeed } = await import("./rss.js");

function respond(body: string, contentType: string) {
  safeFetch.mockResolvedValueOnce({
    ok: true,
    status: 200,
    text: body,
    url: "https://feed.example/rss",
    headers: new Headers({ "content-type": contentType }),
  });
}

function rss(channelExtra: string) {
  return `<?xml version="1.0"?>
<rss version="2.0" xmlns:itunes="http://www.itunes.com/dtds/podcast-1.0.dtd">
  <channel>
    <title>A feed</title>
    <link>https://feed.example/</link>
    <description>About it</description>
    ${channelExtra}
    <item><guid>1</guid><title>One</title><link>https://feed.example/1</link></item>
  </channel>
</rss>`;
}

beforeEach(() => safeFetch.mockReset());

describe("fetchRssFeed › feedImageUrl", () => {
  it("reads the channel <image><url>", async () => {
    respond(
      rss("<image><url>https://feed.example/logo.png</url><title>A feed</title><link>https://feed.example/</link></image>"),
      "application/rss+xml",
    );
    const r = await fetchRssFeed({ feedUrl: "https://feed.example/rss" });
    expect(r.feedImageUrl).toBe("https://feed.example/logo.png");
  });

  it("falls back to the podcast's itunes:image", async () => {
    respond(rss('<itunes:image href="https://feed.example/cover.jpg"/>'), "application/rss+xml");
    const r = await fetchRssFeed({ feedUrl: "https://feed.example/rss" });
    expect(r.feedImageUrl).toBe("https://feed.example/cover.jpg");
  });

  it("refuses a non-http(s) image rather than storing it", async () => {
    respond(
      rss("<image><url>javascript:alert(1)</url><title>A feed</title><link>https://feed.example/</link></image>"),
      "application/rss+xml",
    );
    const r = await fetchRssFeed({ feedUrl: "https://feed.example/rss" });
    expect(r.feedImageUrl).toBeUndefined();
  });

  it("reports none when the feed declares none", async () => {
    respond(rss(""), "application/rss+xml");
    const r = await fetchRssFeed({ feedUrl: "https://feed.example/rss" });
    expect(r.feedImageUrl).toBeUndefined();
    expect(r.feedTitle).toBe("A feed");
  });

  it("reads a JSON Feed's icon, else its favicon", async () => {
    const feed = (extra: object) =>
      JSON.stringify({
        version: "https://jsonfeed.org/version/1.1",
        title: "J",
        items: [{ id: "1", url: "https://feed.example/1", content_text: "x" }],
        ...extra,
      });
    respond(feed({ icon: "https://feed.example/icon.png", favicon: "https://feed.example/f.ico" }), "application/feed+json");
    expect((await fetchRssFeed({ feedUrl: "https://feed.example/j" })).feedImageUrl).toBe(
      "https://feed.example/icon.png",
    );
    respond(feed({ favicon: "https://feed.example/f.ico" }), "application/feed+json");
    expect((await fetchRssFeed({ feedUrl: "https://feed.example/j" })).feedImageUrl).toBe(
      "https://feed.example/f.ico",
    );
  });
});
