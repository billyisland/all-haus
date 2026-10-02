// =============================================================================
// note-seed — turning a NOTE into the seed of an ARTICLE.
//
// The two compose surfaces are plain textareas and a published note renders
// `whitespace-pre-wrap` (components/post/PostBody.tsx): every newline the writer
// typed is a line break they can SEE. The article editor is markdown
// (`Markdown.configure({ html: false })`, `breaks: false`), where a single
// newline is a SPACE — so handing the raw textarea string across the escalation
// welds the writer's lines into one paragraph. Everything below exists to make
// the body that arrives in the editor mean what the note box was showing.
//
// Two conversions, and they are separate facts:
//   - line breaks     → `noteTextToMarkdown`
//   - attached images → appended as block images
// =============================================================================

import { isEmbeddableUrl } from "./media";

/** An attachment carried from the note composer. Mirrors `MediaAttachment`
 *  (hooks/useMediaAttachments) narrowed to what the seed needs. */
export interface NoteSeedAttachment {
  url: string;
  type: "image" | "embed";
}

// A line that OPENS a markdown block. The hard-break marker must not be
// appended to the line before one, nor to one of these itself: a trailing `\`
// on the last line of a paragraph is a literal backslash in CommonMark, so it
// would print as a stray glyph exactly where a block begins.
const BLOCK_START =
  /^\s{0,3}(#{1,6}\s|[-*+]\s|\d+[.)]\s|>|```|~~~|(-{3,}|_{3,}|\*{3,})\s*$)/;

/**
 * A line that is NOTHING BUT AN EMBEDDABLE URL — the shape `EmbedNode`'s ruler
 * re-forms into an embed, and the shape the note box was already SHOWING as an
 * embed card.
 *
 * The ruler's test is strict for good reason: it claims a paragraph whose
 * ENTIRE inline content is the URL. A hard-break marker welds the URL's line
 * to its neighbours into one paragraph, so `"Look at this\n<url>\nso good"`
 * arrived in the editor as a single paragraph with no embed in it — and, with
 * autolink off, not even a link. Only a URL the writer had already isolated
 * with blank lines survived, which made the rule "the seed carries what the
 * note box was SHOWING" false for the ordinary shape.
 *
 * So a URL-only line becomes its own PARAGRAPH before the hard-break pass
 * runs. That is not a special case bolted on: it is the same claim the rest of
 * this file makes — the article has to mean what the note meant — applied to
 * the one element whose markdown form is a whole block or nothing.
 */
function isEmbedLine(line: string): boolean {
  const text = line.trim();
  return text !== "" && !/\s/.test(text) && isEmbeddableUrl(text);
}

// Fence open/close. Inside a fence every line is literal and nothing is touched.
const FENCE = /^\s{0,3}(```|~~~)/;

/**
 * Plain note text → markdown that renders the same line breaks.
 *
 * A BLANK line already means a paragraph break in both, so it passes through
 * untouched. A single newline between two ordinary lines becomes a CommonMark
 * hard break (a trailing `\`), which is what `whitespace-pre-wrap` was showing
 * the writer. Markdown the writer actually typed is left alone: a line that
 * opens a block — and the line before it — take no marker, and fenced code is
 * copied verbatim.
 */
export function noteTextToMarkdown(body: string): string {
  const lines = body.split("\n");
  let inFence = false;
  const out: string[] = [];

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (FENCE.test(line)) {
      inFence = !inFence;
      out.push(line);
      continue;
    }
    if (inFence) {
      out.push(line);
      continue;
    }

    const next = i + 1 < lines.length ? lines[i + 1] : null;

    // AN EMBED LINE IS A BLOCK, so it is isolated rather than hard-broken.
    // Blank lines either side where there is a neighbour — which is exactly
    // what the ruler needs and exactly what the note was already rendering.
    if (isEmbedLine(line)) {
      if (out.length > 0 && out[out.length - 1].trim() !== "") out.push("");
      out.push(line.trim());
      if (next !== null && next.trim() !== "") out.push("");
      continue;
    }

    const joinsNext =
      next !== null &&
      line.trim() !== "" &&
      next.trim() !== "" &&
      !isEmbedLine(next) &&
      !BLOCK_START.test(line) &&
      !BLOCK_START.test(next) &&
      // Already a hard break (a trailing `\` or the two-space form): leave the
      // writer's own marker alone rather than doubling it.
      !/\\$/.test(line) &&
      !/ {2}$/.test(line);

    out.push(joinsNext ? `${line}\\` : line);
  }

  return out.join("\n");
}

/**
 * Attached images, appended as block markdown so `ImageWithCaption` picks them
 * up. A note renders its pictures after its text, so that is where they go.
 *
 * Embeds are NOT appended: `detectEmbeds` derives them FROM the typed text, so
 * every embed URL is already in the body, where `EmbedNode`'s ruler re-forms it
 * on parse. Appending would publish the link twice.
 *
 * "Where the ruler re-forms it" is true because `noteTextToMarkdown` puts a
 * URL-only line in a paragraph of its own (see `isEmbedLine`). It was NOT true
 * when this comment was written: the hard-break pass welded that line to its
 * neighbours, and an embed survived only where the writer had already
 * isolated it with blank lines.
 */
export function appendNoteImages(
  markdown: string,
  attachments: NoteSeedAttachment[],
): string {
  const images = attachments.filter((a) => a.type === "image");
  if (images.length === 0) return markdown;
  const block = images.map((a) => `![](${a.url})`).join("\n\n");
  const base = markdown.replace(/\s+$/, "");
  return base === "" ? block : `${base}\n\n${block}`;
}
