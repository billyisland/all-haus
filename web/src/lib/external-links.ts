// =============================================================================
// Outbound links open in a new tab — one rule, one home.
//
// A link that leaves all.haus opens in a new tab; a link that stays never does.
// The predicate is `isExternalHref`; `externalizeHtml` applies it to an HTML
// string on its way into `dangerouslySetInnerHTML`. Bespoke JSX anchors that
// point off-site set target/rel themselves (they know statically that they do).
//
// The site-host list is a LITERAL, deliberately, and not read from `APP_URL` or
// `window.location`: `renderMarkdown` runs on the server for the SSR'd public
// pages and again on the client for the overlay bodies, and a host resolved
// from the environment differs between the two (a non-`NEXT_PUBLIC_` env var is
// simply undefined in the browser bundle), so the same anchor would render with
// `target` on one pass and without it on the other — a hydration mismatch on an
// attribute, which React repairs silently and nothing reports. A literal set
// resolves identically in both passes.
//
// Only http(s) is externalised. `mailto:`, `tel:` and `nostr:` leave the site
// too, but they hand off to an OS handler rather than opening a page, so a new
// tab is either useless or a blank one left behind. A relative href, a bare
// `#anchor` and an unparseable value are internal by construction (`new URL`
// throws on all three without a base).
// =============================================================================

const SITE_HOSTS = new Set([
  "all.haus",
  "www.all.haus",
  "localhost",
  "127.0.0.1",
]);

export function isExternalHref(href: string): boolean {
  const trimmed = href.trim();
  if (!trimmed) return false;
  // Protocol-relative (`//example.com/x`) is absolute in a browser; give it a
  // scheme so `new URL` reads its host rather than throwing.
  const candidate = trimmed.startsWith("//") ? `https:${trimmed}` : trimmed;
  let url: URL;
  try {
    url = new URL(candidate);
  } catch {
    return false; // relative, hash-only, or malformed — all internal.
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") return false;
  return !SITE_HOSTS.has(url.hostname.toLowerCase());
}

// The tag interior allows `>` inside a quoted attribute value — the three
// alternatives are disjoint on their first character, so this stays linear.
const ANCHOR_OPEN = /<a\b((?:[^>"']|"[^"]*"|'[^']*')*)>/gi;
const HREF_ATTR = /\bhref\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'>]+))/i;
const REL_ATTR = /\brel\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'>]+))/i;
const TARGET_ATTR = /\s*\btarget\s*=\s*(?:"[^"]*"|'[^']*'|[^\s"'>]+)/gi;

/**
 * Give every off-site anchor in an HTML string `target="_blank"` and a rel that
 * carries `noopener noreferrer`. Same-site and non-http(s) anchors are returned
 * byte-identical.
 *
 * Safe as a regex because every string this is handed is already sanitiser
 * output — `shared/src/lib/sanitize.ts` for backend-served content, rehype's
 * `rehype-sanitize` for markdown — so there is no unbalanced or scripted markup
 * left for a tag-shaped pattern to mis-read.
 *
 * An existing `rel` is MERGED, not replaced: the backend sanitiser stamps
 * `nofollow` on external content and dropping it here would quietly turn every
 * syndicated post's links into endorsements.
 */
export function externalizeHtml(html: string): string {
  if (!html || html.indexOf("<a") === -1) return html;
  return html.replace(ANCHOR_OPEN, (tag, attrs: string) => {
    const hrefMatch = attrs.match(HREF_ATTR);
    if (!hrefMatch) return tag;
    const href = hrefMatch[1] ?? hrefMatch[2] ?? hrefMatch[3] ?? "";
    if (!isExternalHref(decodeEntities(href))) return tag;

    const relMatch = attrs.match(REL_ATTR);
    const relTokens = new Set(
      (relMatch ? (relMatch[1] ?? relMatch[2] ?? relMatch[3] ?? "") : "")
        .split(/\s+/)
        .filter(Boolean),
    );
    relTokens.add("noopener");
    relTokens.add("noreferrer");

    let next = attrs.replace(TARGET_ATTR, "");
    if (relMatch) next = next.replace(REL_ATTR, "").trimEnd();
    next = next.trimEnd();
    return `<a${next} target="_blank" rel="${[...relTokens].join(" ")}">`;
  });
}

// Attribute values arrive escaped (`&amp;` in a query string). Only the four
// entities a sanitiser produces need undoing, and only enough for `new URL` to
// read a host off the value.
function decodeEntities(value: string): string {
  return value
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#(?:x3[9a]|39);/gi, "'")
    .replace(/&amp;/g, "&");
}
