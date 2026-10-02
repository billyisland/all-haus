import { describe, it, expect } from "vitest";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { NOTE_CHAR_LIMIT, joinTextAndImages, noteEventParts } from "../src/lib/note-compose";

// =============================================================================
// A note's ceiling must be the number `POST /notes` refuses above.
//
// Two copies exist because the workspaces share no module path: the gateway's
// `NOTE_CHAR_LIMIT` in `routes/notes.ts` and the web's in `lib/note-compose.ts`
// (lifted out of `useNoteComposer` for the plain-HTML register, MODERNHAUS-ADR
// §D2.7.5). Below the server's it is a feature quietly withdrawn; above it the
// signed event reaches the relay and the index refuses it, orphaning the event.
//
// Reads the gateway source rather than importing it, and asserts it FOUND the
// constant: a rename would otherwise make this pass by testing nothing.
// =============================================================================

const GATEWAY = join(__dirname, "../../gateway/src/routes/notes.ts");
const WEB_SRC = join(__dirname, "../src");

function sourceFiles(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) return sourceFiles(path);
    return /\.tsx?$/.test(name) ? [path] : [];
  });
}

describe("note char limit parity with the gateway", () => {
  it("is the number the route's zod schema enforces", () => {
    const src = readFileSync(GATEWAY, "utf8");
    const m = src.match(/NOTE_CHAR_LIMIT\s*=\s*(\d+)/);
    expect(m, "gateway NOTE_CHAR_LIMIT not found — was it renamed?").toBeTruthy();
    expect(Number(m![1])).toBe(NOTE_CHAR_LIMIT);
    // A limit declared beside a hard-coded `.max(1000)` is a comment, not a bound.
    expect(
      /content:\s*z\.string\(\)\.min\(1\)\.max\(NOTE_CHAR_LIMIT\)/.test(src),
      "the /notes body schema must bound content by NOTE_CHAR_LIMIT",
    ).toBe(true);
  });

  it("is declared once on this side", () => {
    const files = sourceFiles(WEB_SRC);
    expect(files.length).toBeGreaterThan(50);
    const declaring = files.filter((f) =>
      /\b(?:const|let|var)\s+NOTE_CHAR_LIMIT\b/.test(readFileSync(f, "utf8")),
    );
    expect(declaring.map((f) => f.slice(WEB_SRC.length))).toEqual(["/lib/note-compose.ts"]);
  });
});

describe("the note as data", () => {
  it("joins pictures after the words, one per line", () => {
    expect(joinTextAndImages("  hello  ", ["https://m/a.webp", "https://m/b.webp"])).toBe(
      "hello\nhttps://m/a.webp\nhttps://m/b.webp",
    );
    // A picture-only note is a note.
    expect(joinTextAndImages("   ", ["https://m/a.webp"])).toBe("https://m/a.webp");
  });

  it("a native quote carries the q tag and the snapshot; an external one appends its URL", () => {
    const native = noteEventParts("mine", { eventId: "ev", eventKind: 1, authorPubkey: "pk", previewContent: "theirs" });
    expect(native.tags).toEqual([["q", "ev", "", "pk"]]);
    expect(native.indexBody("id1")).toMatchObject({
      nostrEventId: "id1",
      content: "mine",
      isQuoteComment: true,
      quotedEventId: "ev",
      quotedExcerpt: "theirs",
    });
    const ext = noteEventParts("mine", {
      eventId: "",
      eventKind: 1,
      authorPubkey: "",
      isExternal: true,
      quotedPostId: "p",
      quotedUrl: "https://x/1",
    });
    expect(ext.tags).toEqual([]);
    expect(ext.content).toBe("mine\n\nhttps://x/1");
    expect(ext.indexBody("id2")).toMatchObject({ content: "mine\n\nhttps://x/1", quotedPostId: "p" });
  });
});
