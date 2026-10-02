import { unified } from "unified";
import remarkParse from "remark-parse";
import remarkGfm from "remark-gfm";
import remarkRehype from "remark-rehype";
import rehypeSanitize, { defaultSchema } from "rehype-sanitize";
import rehypeStringify from "rehype-stringify";
import { externalizeHtml } from "./external-links";
import { articleEmbed } from "./media-embed";

// =============================================================================
// NIP-23 Markdown Renderer
//
// Converts NIP-23 long-form markdown content to safe HTML for rendering.
//
// Pipeline: markdown → remark AST → rehype AST → sanitized HTML
//
// Supports:
//   - Standard markdown (headings, bold, italic, links, images, lists, etc.)
//   - GFM extensions (tables, strikethrough, task lists, autolinks)
//   - Nostr-specific: nostr: URI links (nostr:npub1..., nostr:note1..., etc.)
//
// Security:
//   - rehype-sanitize strips all dangerous HTML (scripts, iframes, etc.)
//   - Only safe elements and attributes are allowed through
//   - Image sources are allowed from Blossom servers and common CDNs
//
// This runs client-side. The unified pipeline is ~15KB gzipped.
// For server-side rendering, the same pipeline works in Node.js.
// =============================================================================

/**
 * The schemes an `href` may carry in a rendered article body.
 *
 * ONE HOME, and it is the renderer's: the sanitizer below is the real gate —
 * an href on any other scheme is stripped here, whatever produced it — and the
 * ARTICLE EDITOR's link extension reads this same list so a link the writer can
 * make is a link the reader can follow. A second hand-written list in the
 * editor would disagree silently, and the symptom would be a link that vanishes
 * on publish.
 *
 * hast-util-sanitize's own default is `http · https · irc · ircs · mailto ·
 * xmpp`; `nostr` is ours (NIP-21 URIs in long-form bodies).
 */
export const HREF_PROTOCOLS: readonly string[] = [
  ...(defaultSchema.protocols?.href ?? []),
  "nostr",
];

// Custom sanitize schema — extends the default to allow:
//   - img src from Blossom and common image hosts
//   - class attributes on code blocks (for syntax highlighting)
//   - nostr: protocol links
const sanitizeSchema = {
  ...defaultSchema,
  // `figure`/`figcaption` are in NEITHER hast-util-sanitize's default schema nor
  // anything upstream of it, so before this they were dropped on the way out —
  // which is the shape `rehypeImageCaptions` below now produces, and a
  // sanitiser that deletes it makes the whole pass a silent no-op. The two are
  // one capability, the same pair as the embed allowlist and its `frame-src`
  // twin (root `CLAUDE.md`).
  tagNames: [...(defaultSchema.tagNames ?? []), "figure", "figcaption"],
  attributes: {
    ...defaultSchema.attributes,
    code: [...(defaultSchema.attributes?.code ?? []), "className"],
    img: ["src", "alt", "title", "width", "height", "loading"],
    a: ["href", "title", "rel", "target"],
  },
  protocols: {
    ...defaultSchema.protocols,
    href: [...HREF_PROTOCOLS],
    src: ["http", "https"],
  },
};

// =============================================================================
// A CAPTION IS THE IMAGE'S TITLE, and this is where it becomes one.
//
// Markdown has no caption construct, so a writer's caption used to be an
// ordinary paragraph under the picture — the external reader's symptom with no
// signal to detect, since the author was never given a way to record the
// intent. The carrier is CommonMark's image title, `![alt](src "caption")`:
// already an attribute of the editor's node, already serialised, already parsed
// back here, and in a client that renders markdown alone it degrades to a
// tooltip rather than vanishing (which is why this and not embedded HTML —
// `Markdown.configure({ html: false })` and `allowDangerousHtml: false` mean a
// raw <figure> in a body renders as NOTHING, measured).
//
// Two narrowings carry the whole rule. **Only a LONE image** — a paragraph
// whose one child is the picture — becomes a figure; an image inside a sentence
// keeps its title as the tooltip it is, because a caption is a block-level
// claim about a block-level picture. And **the title is MOVED, never copied**:
// left in place it renders as a tooltip saying the same words the caption
// already shows.
//
// ALT IS NOT A CAPTION. Alt describes the picture to somebody who cannot see
// it; a caption is read by everybody. An untitled image is left exactly as it
// was rather than having its alt promoted — that would put screen-reader text
// on the page and leave the screen reader hearing it twice.
// =============================================================================

interface HastNode {
  type: string;
  tagName?: string;
  value?: string;
  properties?: Record<string, unknown>;
  children?: HastNode[];
}

function isBlank(node: HastNode): boolean {
  return node.type === "text" && !(node.value ?? "").trim();
}

function rehypeImageCaptions() {
  return (tree: HastNode) => {
    const walk = (node: HastNode) => {
      if (!node.children) return;
      node.children = node.children.map((child) => {
        walk(child);
        if (child.type !== "element" || child.tagName !== "p") return child;
        const content = (child.children ?? []).filter((c) => !isBlank(c));
        if (content.length !== 1) return child;
        // The picture may be wrapped in a link — `[![alt](src "cap")](page)`,
        // which is how most archives store a click-through to the full size.
        // The figure then holds the anchor, so the link survives the promotion.
        let img = content[0];
        let wrapper: HastNode | null = null;
        if (img.type === "element" && img.tagName === "a") {
          const inner = (img.children ?? []).filter((c) => !isBlank(c));
          if (inner.length === 1 && inner[0].type === "element" && inner[0].tagName === "img") {
            wrapper = img;
            img = inner[0];
          }
        }
        if (img.type !== "element" || img.tagName !== "img") return child;
        const title = img.properties?.title;
        if (typeof title !== "string" || !title.trim()) return child;
        const { title: _moved, ...rest } = img.properties ?? {};
        const picture: HastNode = { ...img, properties: rest };
        return {
          type: "element",
          tagName: "figure",
          properties: {},
          children: [
            wrapper ? { ...wrapper, children: [picture] } : picture,
            {
              type: "element",
              tagName: "figcaption",
              properties: {},
              children: [{ type: "text", value: title }],
            },
          ],
        };
      });
    };
    walk(tree);
  };
}

let processor: any = null;

function getProcessor() {
  if (!processor) {
    processor = unified()
      .use(remarkParse)
      .use(remarkGfm)
      .use(remarkRehype, { allowDangerousHtml: false })
      // Before the sanitiser, never after: it runs on hast the sanitiser then
      // gates, so a figure this produces is checked like anything else rather
      // than injected past the one thing that reads the tree for safety.
      .use(rehypeImageCaptions)
      .use(rehypeSanitize, sanitizeSchema)
      .use(rehypeStringify);
  }
  return processor;
}

/**
 * Convert NIP-23 markdown to sanitized HTML.
 *
 * Returns a string of HTML safe for dangerouslySetInnerHTML.
 * All untrusted content is sanitized — XSS-safe.
 * Embeddable URLs on their own line are wrapped in responsive containers.
 */
export async function renderMarkdown(markdown: string): Promise<string> {
  const proc = getProcessor();
  const file = await proc.process(markdown);
  let html = String(file);

  // Post-process: detect embeddable URLs and wrap in responsive containers
  html = enhanceEmbedUrls(html);

  // ...then send every off-site link to a new tab. Last, so the embed patterns
  // above still match the anchors remark produced rather than rewritten ones.
  html = externalizeHtml(html);

  return html;
}

// =============================================================================
// Embed Enhancement
// =============================================================================

// Every src `articleEmbed` can return, and nothing else — an iframe whose src
// is not under one of these is stripped below. Each prefix's host must also be
// in nginx.conf's `frame-src` (both blocks), or the browser refuses the frame
// with no error anywhere; `media-embed.test.ts` reads both and pins the match.
export const TRUSTED_IFRAME_PREFIXES = [
  "https://www.youtube-nocookie.com/embed/",
  "https://player.vimeo.com/video/",
  "https://open.spotify.com/embed/",
];

function embedHtml(url: string): string | null {
  const e = articleEmbed(url);
  if (!e) return null;
  const src = e.src.replace(/"/g, "&quot;");
  if (e.kind === "audio") {
    return `<div class="embed-container" style="max-width:100%;margin:1em 0"><iframe src="${src}" style="width:100%;height:${e.height ?? 152}px;border:0" allow="encrypted-media" loading="lazy"></iframe></div>`;
  }
  return `<div class="embed-container" style="position:relative;padding-bottom:56.25%;height:0;overflow:hidden;max-width:100%;border-radius:8px;margin:1em 0"><iframe src="${src}" style="position:absolute;top:0;left:0;width:100%;height:100%;border:0" allow="fullscreen; picture-in-picture" allowfullscreen loading="lazy"></iframe></div>`;
}

function enhanceEmbedUrls(html: string): string {
  // Find paragraphs that contain only a URL
  html = html.replace(
    /<p><a href="(https?:\/\/[^"]+)"[^>]*>\1<\/a><\/p>/g,
    (match, url) => {
      // The href is the serialised attribute, so a `&` in a query string
      // arrives as `&amp;` — decode it before the URL is parsed.
      return embedHtml(url.replace(/&amp;/g, "&")) ?? match;
    },
  );

  // Strip any iframe whose src isn't in the trusted prefix list
  return html.replace(
    /<iframe\b[^>]*?src="([^"]*)"[^>]*>.*?<\/iframe>/gi,
    (match, src) => {
      return TRUSTED_IFRAME_PREFIXES.some((p) => src.startsWith(p))
        ? match
        : "";
    },
  );
}
