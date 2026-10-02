import { describe, it, expect } from "vitest";
import { existsSync, readFileSync } from "node:fs";
import { embedFrameSrc, articleEmbed } from "./media-embed";
import { TRUSTED_IFRAME_PREFIXES, renderMarkdown } from "./markdown";
import { isEmbeddableUrl } from "./media";

describe("embedFrameSrc", () => {
  it.each([
    ["watch URL", "https://www.youtube.com/watch?v=dQw4w9WgXcQ&t=3"],
    ["RSS media:content form", "https://www.youtube.com/v/dQw4w9WgXcQ?version=3"],
    ["short link", "https://youtu.be/dQw4w9WgXcQ"],
    ["shorts", "https://www.youtube.com/shorts/dQw4w9WgXcQ"],
    ["an existing embed", "https://www.youtube.com/embed/dQw4w9WgXcQ"],
    ["no www", "https://youtube.com/watch?v=dQw4w9WgXcQ"],
  ])("resolves a YouTube %s to the nocookie player", (_label, url) => {
    expect(embedFrameSrc(url)).toBe(
      "https://www.youtube-nocookie.com/embed/dQw4w9WgXcQ",
    );
  });

  it.each([
    ["a page URL", "https://vimeo.com/123456"],
    ["a player URL", "https://player.vimeo.com/video/123456"],
  ])("resolves Vimeo %s to the player", (_label, url) => {
    expect(embedFrameSrc(url)).toBe("https://player.vimeo.com/video/123456");
  });

  // Null is the FALLBACK signal, not an error: the caller then hands the URL to
  // <video>, which is right for a real file and wrong for a page. A provider we
  // do not know must take the file path, never a guessed embed.
  it.each([
    ["a real media file", "https://example.test/clip.mp4"],
    ["an HLS manifest", "https://video.bsky.app/x/playlist.m3u8"],
    ["a lookalike host", "https://www.youtube.com.evil.test/watch?v=x"],
    ["a YouTube URL with no id", "https://www.youtube.com/watch?list=PL1"],
    ["a non-http scheme", "javascript:alert(1)"],
    ["an unparseable value", "not a url"],
  ])("returns null for %s", (_label, url) => {
    expect(embedFrameSrc(url)).toBeNull();
  });
});

// The reader renders this iframe itself, so the sanitiser is not in its path
// and `frame-src` is the ONLY thing that can refuse it — silently, with no
// error anywhere and an empty box where the video was. Both server blocks
// carry the directive; both must carry every host this can emit.
// Absent on the public mirror (nginx.conf is the production topology and is not
// in public-manifest.txt), where an unguarded read fails the suite at
// COLLECTION rather than here. Skipped when absent, never weakened — and in
// this tree it is always present, so nothing skips.
const NGINX_CONF = new URL("../../../nginx.conf", import.meta.url);
const nginxConf = existsSync(NGINX_CONF)
  ? readFileSync(NGINX_CONF, "utf8")
  : null;

describe.skipIf(nginxConf === null)("every emitted host is permitted by nginx frame-src", () => {
  const directives = [...(nginxConf ?? "").matchAll(/frame-src ([^";]+)/g)].map(
    (m) => m[1],
  );

  const emitted = [
    "https://www.youtube.com/watch?v=abc",
    "https://vimeo.com/123456",
  ]
    .map((u) => embedFrameSrc(u))
    .map((src) => new URL(src as string).origin);

  it("finds a frame-src directive in each of the two server blocks", () => {
    expect(directives).toHaveLength(2);
  });

  it.each(emitted)("permits %s in every frame-src", (origin) => {
    for (const d of directives) expect(d).toContain(origin);
  });
});

// ─── articleEmbed — the BODY renderers (walkthrough A4) ─────────────────────

describe("articleEmbed", () => {
  it.each([
    ["a track", "https://open.spotify.com/track/4uLU6hMCjMI75M1A2tKUQC?si=x", "track", 152],
    ["an episode", "https://open.spotify.com/episode/abc123", "episode", 152],
    ["an album", "https://open.spotify.com/album/1DFixLWuPkv3KT3TnV35m3", "album", 352],
    ["a playlist", "https://open.spotify.com/playlist/37i9dQZF1DXcBWIGoYBM5M", "playlist", 352],
    ["a localised path", "https://open.spotify.com/intl-de/album/1DFixLWuPkv3KT3TnV35m3", "album", 352],
  ])("resolves Spotify %s to its embed player", (_l, url, type, height) => {
    const e = articleEmbed(url);
    expect(e?.kind).toBe("audio");
    expect(e?.height).toBe(height);
    expect(e?.src).toMatch(new RegExp(`^https://open\\.spotify\\.com/embed/${type}/`));
  });

  it("takes video from embedFrameSrc", () => {
    expect(articleEmbed("https://vimeo.com/123456")).toEqual({
      src: "https://player.vimeo.com/video/123456",
      kind: "video",
    });
  });

  it.each([
    ["Twitter", "https://twitter.com/user/status/123"],
    ["X", "https://x.com/user/status/123"],
    ["a Spotify page that is not an item", "https://open.spotify.com/search/foo"],
    ["a Spotify lookalike", "https://open.spotify.com.evil.test/track/abc"],
  ])("refuses %s", (_l, url) => {
    expect(articleEmbed(url)).toBeNull();
    // …and so nothing upstream may claim it as an embed either.
    expect(isEmbeddableUrl(url)).toBe(false);
  });

  it("every src it can emit is under a trusted iframe prefix", () => {
    for (const url of [
      "https://youtu.be/abc",
      "https://vimeo.com/1",
      "https://open.spotify.com/track/abc",
      "https://open.spotify.com/album/abc",
    ]) {
      const src = articleEmbed(url)!.src;
      expect(TRUSTED_IFRAME_PREFIXES.some((p) => src.startsWith(p)), src).toBe(true);
    }
  });
});

describe.skipIf(nginxConf === null)("every trusted iframe prefix is permitted by nginx frame-src", () => {
  const directives = [...(nginxConf ?? "").matchAll(/frame-src ([^";]+)/g)].map((m) => m[1]);
  it("finds both directives", () => expect(directives).toHaveLength(2));
  it.each(TRUSTED_IFRAME_PREFIXES.map((p) => new URL(p).origin))("permits %s", (origin) => {
    for (const d of directives) expect(d).toContain(origin);
  });
});

describe("renderMarkdown — a bare provider URL on its own line", () => {
  it.each([
    ["YouTube (nocookie)", "https://www.youtube.com/watch?v=abc&t=3", "https://www.youtube-nocookie.com/embed/abc"],
    ["Vimeo", "https://vimeo.com/123456", "https://player.vimeo.com/video/123456"],
    ["Spotify", "https://open.spotify.com/album/xyz", "https://open.spotify.com/embed/album/xyz"],
  ])("renders %s as its player", async (_l, url, src) => {
    const html = await renderMarkdown(`Before\n\n${url}\n\nAfter`);
    expect(html).toContain(`<iframe src="${src}"`);
  });

  it("leaves a tweet as a link", async () => {
    const html = await renderMarkdown("https://x.com/user/status/123");
    expect(html).not.toContain("<iframe");
    expect(html).toContain('href="https://x.com/user/status/123"');
  });

  it("strips an iframe it did not make", async () => {
    // Belt and braces: the sanitiser already refuses raw HTML, so this is the
    // strip pass's own guard over anything that ever gets past it.
    const html = await renderMarkdown('<iframe src="https://evil.test/x"></iframe>');
    expect(html).not.toContain("<iframe");
  });
});
