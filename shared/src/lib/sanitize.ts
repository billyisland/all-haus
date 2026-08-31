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
};

export function sanitizeArticleContent(html: string): string {
  return sanitizeHtml(html, ARTICLE_SANITIZE_OPTIONS);
}

export function stripHtml(html: string): string {
  return sanitizeHtml(html, { allowedTags: [], allowedAttributes: {} }).trim();
}
