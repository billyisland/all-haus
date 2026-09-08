import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { embedFrameSrc } from "./media-embed";

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
describe("every emitted host is permitted by nginx frame-src", () => {
  const nginx = readFileSync(
    new URL("../../../nginx.conf", import.meta.url),
    "utf8",
  );
  const directives = [...nginx.matchAll(/frame-src ([^";]+)/g)].map((m) => m[1]);

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
