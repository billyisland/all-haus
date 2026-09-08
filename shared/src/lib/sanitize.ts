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
