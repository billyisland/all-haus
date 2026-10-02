// =============================================================================
// embedFrameSrc — a provider watch URL → its player-iframe src. One home.
//
// Why this exists at all: a video RSS item does not carry a video FILE. A
// YouTube channel feed's <media:content medium="video"> is
// `https://www.youtube.com/v/<id>?version=3` — a page, not an MP4 — so handing
// it to <video src> can only fail to the poster, which is what a "video" RSS
// item looked like in the reader pane. The provider's own player is the only
// thing that plays it, and that is an iframe.
//
// Scope: the READER pane's media block only. A feed card renders no iframe —
// what may appear on a card is a card-chassis decision (web/CLAUDE.md), and a
// column of autoplaying provider frames is not one anybody has taken.
//
// The hosts below must stay a SUBSET of two other lists, or a returned src
// renders as an empty box (or nothing at all):
//   • EMBED_IFRAME_HOSTS in shared/src/lib/sanitize.ts — the /extract allowlist;
//   • `frame-src` in nginx.conf (BOTH blocks) — the browser's own refusal.
// This file is not a third copy of that allowlist: it converts a URL, and only
// for providers whose embed form we actually know. Adding a provider here means
// checking it is in both of those.
//
// Returns null for anything unrecognised — the caller then falls back to the
// native <video> player, which is right for a real file (Mastodon/RSS MP4).
// =============================================================================

function youtubeId(u: URL): string | null {
  const host = u.hostname.replace(/^www\./, "");
  if (host === "youtu.be") return u.pathname.slice(1).split("/")[0] || null;
  if (host !== "youtube.com" && host !== "youtube-nocookie.com") return null;
  // /watch?v=ID · /v/ID · /embed/ID · /shorts/ID · /live/ID
  if (u.pathname === "/watch") return u.searchParams.get("v");
  const m = /^\/(?:v|embed|shorts|live)\/([^/?#]+)/.exec(u.pathname);
  return m ? m[1] : null;
}

function vimeoId(u: URL): string | null {
  const host = u.hostname.replace(/^www\./, "");
  if (host === "player.vimeo.com") {
    const m = /^\/video\/(\d+)/.exec(u.pathname);
    return m ? m[1] : null;
  }
  if (host !== "vimeo.com") return null;
  const m = /^\/(\d+)/.exec(u.pathname);
  return m ? m[1] : null;
}

/** The provider player URL for `url`, or null if it isn't one we embed. */
export function embedFrameSrc(url: string): string | null {
  let u: URL;
  try {
    u = new URL(url);
  } catch {
    return null;
  }
  if (u.protocol !== "http:" && u.protocol !== "https:") return null;

  const yt = youtubeId(u);
  // youtube-nocookie: the reader is a reading surface, not a tracking one, and
  // the embed works identically. Same host list either way.
  if (yt) return `https://www.youtube-nocookie.com/embed/${encodeURIComponent(yt)}`;

  const vm = vimeoId(u);
  if (vm) return `https://player.vimeo.com/video/${encodeURIComponent(vm)}`;

  return null;
}

// =============================================================================
// articleEmbed — what a bare provider URL on its own line becomes in a BODY
// (the native article renderer, `renderMarkdown`). The video half is `embedFrameSrc` above; Spotify is the one
// provider an article takes that a feed's media block never carries, so it
// lives here rather than there.
//
// `isEmbeddableUrl` (lib/media.ts) is DEFINED as "this returns non-null", so
// the editor's embed button, its paste rule, the markdown ruler that re-forms
// an embed on reload and the composers' previews can never again claim a
// provider the renderer does not render (walkthrough A4: the prompt promised
// four, the renderer drew one, and the other three published as bare links).
// Every src below must be in `TRUSTED_IFRAME_PREFIXES` (lib/markdown.ts) and in
// nginx.conf's `frame-src`, both blocks — pinned by media-embed.test.ts.
// =============================================================================

const SPOTIFY_TYPES = new Set(["track", "album", "playlist", "episode", "show", "artist"]);

function spotifyEmbed(u: URL): { type: string; id: string } | null {
  if (u.hostname !== "open.spotify.com") return null;
  // /track/ID · /intl-de/track/ID · /embed/track/ID
  const m = /^\/(?:intl-[a-z-]+\/)?(?:embed\/)?([a-z]+)\/([A-Za-z0-9]+)\/?$/.exec(u.pathname);
  if (!m || !SPOTIFY_TYPES.has(m[1])) return null;
  return { type: m[1], id: m[2] };
}

export interface ArticleEmbed {
  src: string;
  /** `video` sizes 16:9; `audio` is the provider's fixed-height player. */
  kind: "video" | "audio";
  /** Pixel height for an `audio` embed. */
  height?: number;
}

export function articleEmbed(url: string): ArticleEmbed | null {
  let u: URL;
  try {
    u = new URL(url);
  } catch {
    return null;
  }
  if (u.protocol !== "http:" && u.protocol !== "https:") return null;

  const video = embedFrameSrc(url);
  if (video) return { src: video, kind: "video" };

  const sp = spotifyEmbed(u);
  if (sp) {
    // Spotify's own compact heights: a single item is the 152 strip, a
    // collection the 352 list.
    const single = sp.type === "track" || sp.type === "episode";
    return {
      src: `https://open.spotify.com/embed/${sp.type}/${encodeURIComponent(sp.id)}`,
      kind: "audio",
      height: single ? 152 : 352,
    };
  }
  return null;
}
