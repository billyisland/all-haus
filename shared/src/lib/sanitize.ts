import sanitizeHtml from "sanitize-html";

const SANITIZE_OPTIONS: sanitizeHtml.IOptions = {
  allowedTags: [
    "p",
    "br",
    "a",
    "em",
    "strong",
    "code",
    "pre",
    "blockquote",
    "ul",
    "ol",
    "li",
    "img",
  ],
  allowedAttributes: {
    a: ["href", "rel"],
    img: ["src", "alt"],
  },
  transformTags: {
    a: sanitizeHtml.simpleTransform("a", { rel: "nofollow" }),
  },
  allowedSchemes: ["http", "https"],
  allowProtocolRelative: false,
};

// =============================================================================
// The same scheme rule as `allowedSchemes` above, for a URL that is stored as a
// bare STRING rather than inside markup — a link-preview target, a profile's
// `website`. Those never pass through sanitize-html, so nothing was applying
// the rule to them: a `javascript:` value from an ingested embed reached the
// client and React 18 renders it (it only warns that a FUTURE version will
// block it).
//
// Refuse at the point of persistence AND guard at the point of render
// (`web/src/lib/safeHttpUrl`): ingest-side alone leaves every historical row
// hostile, render-side alone leaves the value in the database for the next
// consumer. `null` rather than a placeholder, so the caller drops the field
// instead of storing a link that goes nowhere.
// =============================================================================

export function httpUrlOrNull(
  url: string | null | undefined,
): string | null {
  if (!url) return null;
  const trimmed = url.trim();
  if (!trimmed) return null;
  let parsed: URL;
  try {
    parsed = new URL(trimmed);
  } catch {
    return null;
  }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") return null;
  return trimmed;
}

export function sanitizeContent(html: string): string {
  return sanitizeHtml(html, SANITIZE_OPTIONS);
}

// Long-form variant for extracted/rendered ARTICLE bodies (e.g. the /extract
// reader). Readability output carries document structure — headings, figures,
// tables, code blocks — that the social-post allowlist above would strip, so we
// permit those structural tags while keeping the same security posture: no
// scripts, no event handlers, no style/class injection, only http/https schemes.
//
// PLAYERS (2026-09-02). An article's video is a first-class part of it, and the
// two allowlists above/below are why a video in a reader body has never once
// rendered: the social list strips the tag at RSS ingest, and this list stripped
// it again on the way out of /extract. So this variant — and ONLY this one —
// permits `video`/`audio`/`source` (a self-hosted file, which `media-src https:`
// already allows) and `iframe` restricted to EMBED_IFRAME_HOSTS below.
//
// The social allowlist deliberately did NOT move with it. A feed card renders
// `post.body.html` at card size in a column beside other cards; what may appear
// there is a card-chassis decision (web/CLAUDE.md), not a sanitiser one.
//
// Three things make the iframe widening narrow rather than a hole:
//   • the host list is exact hostnames, not domains — no subdomain wildcard;
//   • `allowedSchemesAppliedToAttributes` already covers `src`, so a
//     `javascript:` or protocol-relative src is dropped before the host check;
//   • a src that fails either check is DELETED BY sanitize-html, which leaves a
//     srcless `<iframe></iframe>` behind — an empty framed box in the prose.
//     `exclusiveFilter` drops those, so a refused embed renders as nothing
//     rather than as a hole the reader can see.
// Prod must also permit these hosts in `frame-src` (nginx.conf, both blocks);
// the two lists are a pair, and widening one alone renders nothing.
export const EMBED_IFRAME_HOSTS = [
  "www.youtube.com",
  "youtube.com",
  "www.youtube-nocookie.com",
  "youtube-nocookie.com",
  "player.vimeo.com",
  "open.spotify.com",
  "w.soundcloud.com",
];
const ARTICLE_SANITIZE_OPTIONS: sanitizeHtml.IOptions = {
  allowedTags: [
    "p",
    "br",
    "a",
    "em",
    "strong",
    "b",
    "i",
    "u",
    "s",
    "code",
    "pre",
    "blockquote",
    "ul",
    "ol",
    "li",
    "dl",
    "dt",
    "dd",
    "h1",
    "h2",
    "h3",
    "h4",
    "h5",
    "h6",
    "img",
    "picture",
    "source",
    "video",
    "audio",
    "iframe",
    "figure",
    "figcaption",
    "span",
    "sub",
    "sup",
    "mark",
    "small",
    "abbr",
    "time",
    "table",
    "thead",
    "tbody",
    "tfoot",
    "tr",
    "th",
    "td",
    "caption",
    "colgroup",
    "col",
  ],
  allowedAttributes: {
    a: ["href", "rel", "title"],
    img: ["src", "alt", "title"],
    // Players. No `autoplay` — a reader pane that starts talking on open is the
    // one behaviour nobody asked for; `controls` is what the reader gets.
    video: [
      "src",
      "poster",
      "controls",
      "preload",
      "playsinline",
      "muted",
      "loop",
      "width",
      "height",
    ],
    audio: ["src", "controls", "preload", "loop"],
    source: ["src", "srcset", "type", "media", "sizes"],
    iframe: [
      "src",
      "width",
      "height",
      "title",
      "allow",
      "allowfullscreen",
      "loading",
      "referrerpolicy",
    ],
    th: ["colspan", "rowspan", "scope"],
    td: ["colspan", "rowspan"],
    col: ["span"],
    colgroup: ["span"],
    abbr: ["title"],
    time: ["datetime"],
  },
  transformTags: {
    a: sanitizeHtml.simpleTransform("a", { rel: "nofollow noopener noreferrer" }),
  },
  allowedSchemes: ["http", "https"],
  allowProtocolRelative: false,
  allowedIframeHostnames: EMBED_IFRAME_HOSTS,
  allowIframeRelativeUrls: false,
  // A refused embed is nothing, never an empty box: sanitize-html answers a
  // disallowed src by deleting the ATTRIBUTE, so without this an off-list
  // provider leaves a srcless <iframe> the reader sees as a gap in the prose.
  exclusiveFilter: (frame) => frame.tag === "iframe" && !frame.attribs.src,
};

export function sanitizeArticleContent(html: string): string {
  return sanitizeHtml(html, ARTICLE_SANITIZE_OPTIONS);
}

export function stripHtml(html: string): string {
  return sanitizeHtml(html, { allowedTags: [], allowedAttributes: {} }).trim();
}

// =============================================================================
// Does this text contain a link? (L6.2, decision A1; D1 §5)
//
// Direct messages are TEXT ONLY. A DM is the one surface on the platform where
// a stranger can put something in front of a member with nobody else in the
// room — no feed, no report queue, no other reader who might notice — and a
// link is what makes that worth doing at scale. So the body is refused where
// it is WRITTEN, and the composer no longer offers uploads or appends URLs.
//
// WHAT IT CATCHES, AND WHY NOT MORE. An explicit scheme (`https://`,
// `mailto:`, `javascript:`, anything that looks like one) and a `www.` token.
// It deliberately does NOT try to catch a bare `example.com`, because the
// pattern that does also refuses "node.js", "vs. UI", a file name and a price
// in some locales — and a message refused for containing a full stop is a
// worse failure than the one this is guarding against.
//
// THAT LOOSENESS IS ONLY SAFE BECAUSE OF THE OTHER HALF OF THE BUILD. The DM
// thread renders plain text and nothing else: `MediaContent` is not mounted
// there any more, so nothing linkifies, nothing embeds and nothing fetches. A
// bare domain in a DM is inert characters the recipient would have to retype.
// If a renderer is ever put back on that surface, THIS FUNCTION IS NO LONGER
// SUFFICIENT and the two have to be rethought together.
//
// The refusal is one the sender is TOLD about in plain words, because a
// message that silently fails to send is a message the sender believes was
// delivered.
//
// What this rests on: `docs/adr/LEGAL-BRAKES.md`.
// =============================================================================

/**
 * Three shapes: ANY scheme followed by `//` (RFC 3986's own scheme grammar, so
 * a scheme nobody has invented yet is caught); a NAMED schemeless scheme; and
 * a `www.`-prefixed host.
 *
 * THE SECOND BRANCH IS A LIST AND NOT A PATTERN, and that is the whole of the
 * tuning. `[a-z][a-z0-9+.-]*:` — the general scheme shape without the slashes
 * — matches `Note:something`, `Q:answer` and `ref:12`, which are ordinary
 * things to type and which a member would then be told contained a link. The
 * cost of naming the six is that a seventh schemeless scheme gets through; on
 * a surface that renders plain text and linkifies nothing, what gets through
 * is characters the recipient would have to retype.
 */
const URL_IN_TEXT_RE =
  /(?:\b[a-z][a-z0-9+.-]*:\/\/)|(?:\b(?:mailto|data|javascript|vbscript|file|tel|sms):[^\s])|(?:\bwww\.[a-z0-9-])/i

export function containsUrl(text: string): boolean {
  return URL_IN_TEXT_RE.test(text)
}

/** What a sender whose message was refused is told. */
export const DM_NO_LINKS_MESSAGE =
  'Direct messages are text only — take the link out and send it again.'
