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
