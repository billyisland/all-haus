import { unified } from "unified";
import remarkParse from "remark-parse";
import remarkGfm from "remark-gfm";
import remarkRehype from "remark-rehype";
import rehypeSanitize, { defaultSchema } from "rehype-sanitize";
import rehypeStringify from "rehype-stringify";
import { externalizeHtml } from "./external-links";

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

// Custom sanitize schema — extends the default to allow:
//   - img src from Blossom and common image hosts
//   - class attributes on code blocks (for syntax highlighting)
//   - nostr: protocol links
const sanitizeSchema = {
  ...defaultSchema,
  attributes: {
    ...defaultSchema.attributes,
    code: [...(defaultSchema.attributes?.code ?? []), "className"],
    img: ["src", "alt", "title", "width", "height", "loading"],
    a: ["href", "title", "rel", "target"],
  },
  protocols: {
    ...defaultSchema.protocols,
    href: [...(defaultSchema.protocols?.href ?? []), "nostr"],
    src: ["http", "https"],
  },
};

let processor: any = null;

function getProcessor() {
  if (!processor) {
    processor = unified()
      .use(remarkParse)
      .use(remarkGfm)
      .use(remarkRehype, { allowDangerousHtml: false })
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

const TRUSTED_IFRAME_PREFIXES = ["https://www.youtube.com/embed/"];

const EMBED_PATTERNS: Array<{
  pattern: RegExp;
  getEmbed: (m: RegExpMatchArray) => string;
}> = [
  {
    pattern: /https?:\/\/(www\.)?youtube\.com\/watch\?v=([a-zA-Z0-9_-]+)/,
    getEmbed: (m) =>
      `<div class="embed-container" style="position:relative;padding-bottom:56.25%;height:0;overflow:hidden;max-width:100%;border-radius:8px;margin:1em 0"><iframe src="https://www.youtube.com/embed/${m[2]}" style="position:absolute;top:0;left:0;width:100%;height:100%" frameborder="0" allowfullscreen loading="lazy"></iframe></div>`,
  },
  {
    pattern: /https?:\/\/youtu\.be\/([a-zA-Z0-9_-]+)/,
    getEmbed: (m) =>
      `<div class="embed-container" style="position:relative;padding-bottom:56.25%;height:0;overflow:hidden;max-width:100%;border-radius:8px;margin:1em 0"><iframe src="https://www.youtube.com/embed/${m[1]}" style="position:absolute;top:0;left:0;width:100%;height:100%" frameborder="0" allowfullscreen loading="lazy"></iframe></div>`,
  },
];

function enhanceEmbedUrls(html: string): string {
  // Find paragraphs that contain only a URL
  html = html.replace(
    /<p><a href="(https?:\/\/[^"]+)"[^>]*>\1<\/a><\/p>/g,
    (match, url) => {
      for (const { pattern, getEmbed } of EMBED_PATTERNS) {
        const m = url.match(pattern);
        if (m) {
          return getEmbed(m);
        }
      }
      return match;
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
