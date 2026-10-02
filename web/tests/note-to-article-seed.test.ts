// @vitest-environment jsdom
//
// The note→article handoff, tested THROUGH THE EDITOR wherever the claim is
// about markdown. `noteTextToMarkdown` produces a string, but the thing that
// matters is the DOCUMENT the editor builds from it — a normaliser that emits
// plausible-looking markdown the editor then parses into one welded paragraph
// would pass every string assertion and fail the feature. So the string-level
// tests pin the conversion and the editor-level ones pin what the writer sees,
// same shape as the round-trip suite.

import { describe, it, expect } from "vitest";
import { Editor } from "@tiptap/core";
import { markdownExtensions } from "@/components/editor/extensions";
import {
  noteTextToMarkdown,
  appendNoteImages,
} from "@/lib/note-seed";
import { seedFromNote } from "@/stores/editorOverlay";

function docFrom(markdown: string) {
  const editor = new Editor({
    extensions: markdownExtensions(),
    content: markdown,
  });
  const json = editor.getJSON();
  editor.destroy();
  return json;
}

/** The top-level block types the editor built, in order. */
function blockTypes(markdown: string): string[] {
  return (docFrom(markdown).content ?? []).map((n) => n.type as string);
}

/** Every text run in the first paragraph, with hard breaks marked as "\n". */
function firstBlockRuns(markdown: string): string[] {
  const first = (docFrom(markdown).content ?? [])[0];
  return (first?.content ?? []).map((n) =>
    n.type === "hardBreak" ? "\n" : (n.text ?? ""),
  );
}

describe("noteTextToMarkdown — a note's line breaks survive", () => {
  it("keeps two single-newline lines as two lines, not one paragraph", () => {
    // The defect this exists for: markdown's `breaks: false` turns a single
    // newline into a SPACE, so the raw textarea string arrives welded.
    const raw = "First line\nSecond line";
    expect(firstBlockRuns(raw)).toEqual(["First line Second line"]);
    expect(firstBlockRuns(noteTextToMarkdown(raw))).toEqual([
      "First line",
      "\n",
      "Second line",
    ]);
  });

  it("leaves a blank-line paragraph break alone", () => {
    const out = noteTextToMarkdown("One\n\nTwo");
    expect(out).toBe("One\n\nTwo");
    expect(blockTypes(out)).toEqual(["paragraph", "paragraph"]);
  });

  it("does not mark the line before a block, which would print a stray backslash", () => {
    // A trailing `\` on a paragraph's LAST line is a literal backslash in
    // CommonMark, and a line that opens a list ends the paragraph above it.
    const out = noteTextToMarkdown("Shopping\n- milk\n- bread");
    expect(out).toBe("Shopping\n- milk\n- bread");
    expect(blockTypes(out)).toEqual(["paragraph", "bulletList"]);
    expect(firstBlockRuns(out)).toEqual(["Shopping"]);
  });

  it("leaves headings and quotes unmarked", () => {
    expect(noteTextToMarkdown("## Title\nbody")).toBe("## Title\nbody");
    expect(noteTextToMarkdown("> quoted\nafter")).toBe("> quoted\nafter");
  });

  it("copies fenced code verbatim", () => {
    const raw = "```\na\nb\n```\nafter";
    expect(noteTextToMarkdown(raw)).toBe(raw);
  });

  it("does not double a hard break the writer already typed", () => {
    expect(noteTextToMarkdown("a\\\nb")).toBe("a\\\nb");
    expect(noteTextToMarkdown("a  \nb")).toBe("a  \nb");
  });

  it("marks every break in a run of plain lines", () => {
    expect(firstBlockRuns(noteTextToMarkdown("a\nb\nc"))).toEqual([
      "a",
      "\n",
      "b",
      "\n",
      "c",
    ]);
  });
});

describe("an embed line survives the seed — through the real editor", () => {
  // THE RULE IS THAT THE SEED CARRIES WHAT THE NOTE BOX WAS SHOWING, and for
  // this shape it did not. A note renders a bare URL as an embed card
  // (`detectEmbeds` is text-wide), while `EmbedNode`'s ruler re-forms one only
  // from a paragraph whose ENTIRE inline content is the URL. The hard-break
  // pass welded the URL's line to its neighbours into one paragraph, so an
  // embed survived only where the writer had already isolated it with blank
  // lines — and the file's own comment claimed otherwise.
  //
  // It has to go through the EDITOR. The previous case ("does not re-append
  // embeds") is a string assertion and cannot see any of this: the markdown
  // contains the URL either way, and what differs is the document it parses
  // into.

  it("re-forms an embed between two ordinary lines", () => {
    const md = noteTextToMarkdown(
      "Look at this\nhttps://youtube.com/watch?v=x\nso good",
    );
    expect(blockTypes(md)).toEqual(["paragraph", "embed", "paragraph"]);
  });

  it("keeps the blank-separated shape working", () => {
    const md = noteTextToMarkdown(
      "Look at this\n\nhttps://youtube.com/watch?v=x\n\nso good",
    );
    expect(blockTypes(md)).toEqual(["paragraph", "embed", "paragraph"]);
  });

  it("carries an embed that opens or closes the note", () => {
    expect(blockTypes(noteTextToMarkdown("https://youtube.com/watch?v=x\nafter"))).toEqual(
      ["embed", "paragraph"],
    );
    expect(blockTypes(noteTextToMarkdown("before\nhttps://youtube.com/watch?v=x"))).toEqual(
      ["paragraph", "embed"],
    );
  });

  it("leaves a URL with words beside it alone", () => {
    // Only a line that is NOTHING BUT the URL is an embed — in the note box
    // too. A sentence containing one stays a sentence, hard break and all.
    const md = noteTextToMarkdown("see https://youtube.com/watch?v=x now\nnext");
    expect(blockTypes(md)).toEqual(["paragraph"]);
  });

  it("leaves a non-embeddable URL alone", () => {
    const md = noteTextToMarkdown("look\nhttps://example.com/page\nhere");
    expect(blockTypes(md)).toEqual(["paragraph"]);
  });
});

describe("appendNoteImages — an attached picture is not dropped", () => {
  it("appends each image as its own block, and the editor builds an image node", () => {
    const out = appendNoteImages("Body text", [
      { url: "https://media.example/a.webp", type: "image" },
    ]);
    expect(out).toBe("Body text\n\n![](https://media.example/a.webp)");
    expect(blockTypes(out)).toEqual(["paragraph", "image"]);
  });

  it("does not re-append embeds — they are already in the body text", () => {
    // `detectEmbeds` derives embed attachments FROM the typed text, so the URL
    // is in the body already; appending would publish the link twice.
    const body = "See https://youtube.com/watch?v=x";
    expect(
      appendNoteImages(body, [
        { url: "https://youtube.com/watch?v=x", type: "embed" },
      ]),
    ).toBe(body);
  });

  it("carries images out of an empty body without a leading blank", () => {
    expect(
      appendNoteImages("", [{ url: "https://media.example/a.webp", type: "image" }]),
    ).toBe("![](https://media.example/a.webp)");
  });

  it("keeps the order the writer attached them in", () => {
    const out = appendNoteImages("x", [
      { url: "https://m/1.webp", type: "image" },
      { url: "https://m/2.webp", type: "image" },
    ]);
    expect(out.indexOf("1.webp")).toBeLessThan(out.indexOf("2.webp"));
  });
});

describe("seedFromNote — the whole handoff", () => {
  it("promotes a heading-prefixed first line to the title", () => {
    const seed = seedFromNote("# The Title\nAnd the body");
    expect(seed.initialTitle).toBe("The Title");
    expect(seed.initialContent).toBe("And the body");
  });

  it("leaves the title empty when the note has no heading, and keeps the body whole", () => {
    const seed = seedFromNote("Just a note");
    expect(seed.initialTitle).toBe("");
    expect(seed.initialContent).toBe("Just a note");
  });

  it("carries line breaks AND pictures across in one pass", () => {
    const seed = seedFromNote("Line one\nLine two", [
      { url: "https://media.example/a.webp", type: "image" },
    ]);
    expect(blockTypes(seed.initialContent)).toEqual(["paragraph", "image"]);
    expect(firstBlockRuns(seed.initialContent)).toEqual([
      "Line one",
      "\n",
      "Line two",
    ]);
  });

  it("normalises the body UNDER a promoted heading too", () => {
    // The heading split hands `rest` on; if the normalisation ran on the raw
    // body instead, everything below a title would weld.
    const seed = seedFromNote("## T\nLine one\nLine two");
    expect(seed.initialTitle).toBe("T");
    expect(firstBlockRuns(seed.initialContent)).toEqual([
      "Line one",
      "\n",
      "Line two",
    ]);
  });
});
