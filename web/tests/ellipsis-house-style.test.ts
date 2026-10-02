import { describe, it, expect } from "vitest";
import { readdirSync, readFileSync, statSync } from "node:fs";
import path from "node:path";

// =============================================================================
// One ellipsis in the house, and it is `…` (U+2026) — a grep, not a memory.
//
// Two spellings shipped side by side: 107 sites on `…`, 56 on three ASCII
// periods. They are not merely inconsistent, they LOOK different, and the
// difference is loudest exactly where the house voice is tightest: `.label-ui`
// sets 0.06em tracking, which spaces three periods into ". . ." while the single
// glyph stays one tracked unit. A pull-to-refresh reading "REFRESHING . . ."
// above a vessel reading "LOADING…" was one waiting state spelled two ways,
// stacked.
//
// So: `…`, everywhere a member can read it — in-flight verbs (Saving…), the
// bare placeholder standing in for a value in flight (…), input placeholders
// (Reply…), and truncation suffixes (`truncateText`). The backend already
// agrees, so this is the web catching up rather than a new convention.
//
// The spread operator is excluded STRUCTURALLY, not by exemption: `...` followed
// by an identifier, `(`, `{` or `[` is JavaScript and never copy. That keeps
// `${[...relTokens].join(" ")}` inside a template literal legal without a line
// in a list somebody would have to maintain.
//
// AND COPY IS NOT ONLY A STRING LITERAL. The first version of this scanned
// literals alone, which is exactly half of where a member reads a word: JSX
// TEXT — `<p>Loading...</p>`, or a bare line of text between two tags — is
// invisible to it. Seven sites survived a green suite that way, including two
// the ellipsis ship itself rewrote and left with three periods. So the line is
// scanned TWICE: once for its string literals, then again with those literals
// blanked, which leaves JSX text, and with what follows a `//` or `/*` in that
// residue cut away. Blanking the strings first is what makes the comment cut
// safe — otherwise `https://…` inside a URL reads as the start of one.
//
// A comment cannot fail. This can.
// =============================================================================

const ROOT = path.resolve(__dirname, "..", "src");

// A string literal — double, single or backtick — with escapes honoured so a
// quote inside one does not end it early.
const STRING_RE = /("(?:[^"\\\n]|\\.)*"|'(?:[^'\\\n]|\\.)*'|`(?:[^`\\\n]|\\.)*`)/g;
// Three periods NOT followed by the start of an identifier or an opening
// bracket — i.e. copy, not a spread.
const ASCII_ELLIPSIS_RE = /\.\.\.(?![A-Za-z_$({[])/;

function sourceFiles(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir)) {
    const full = path.join(dir, entry);
    if (statSync(full).isDirectory()) out.push(...sourceFiles(full));
    else if (/\.tsx?$/.test(entry)) out.push(full);
  }
  return out;
}

describe("the house ellipsis is …", () => {
  const files = sourceFiles(ROOT);

  it("finds the tree it is meant to be scanning", () => {
    // A moved directory would make the assertion below pass by scanning
    // nothing — the reassuring silence this family of checks exists to end.
    expect(files.length).toBeGreaterThan(100);
  });

  it("has the house ellipsis actually in use", () => {
    // The scan above proves no ASCII form survives; on its own that is also
    // what an empty tree looks like. This says the replacement is really there.
    const withHouseForm = files.filter((f) => readFileSync(f, "utf8").includes("…"));
    expect(withHouseForm.length).toBeGreaterThan(40);
  });

  it("spells every ellipsis in user-visible copy as …", () => {
    const ascii: string[] = [];
    for (const file of files) {
      const lines = readFileSync(file, "utf8").split("\n");
      lines.forEach((line, i) => {
        if (!line.includes("...")) return;
        const trimmed = line.trimStart();
        // A line comment is prose about the code, not copy in it.
        if (trimmed.startsWith("//") || trimmed.startsWith("*") || trimmed.startsWith("/*"))
          return;
        for (const m of line.matchAll(STRING_RE)) {
          if (!ASCII_ELLIPSIS_RE.test(m[0])) continue;
          ascii.push(`${path.relative(ROOT, file)}:${i + 1} — ${m[0].trim()}`);
        }
        // Pass two: what is left once the literals are gone is JSX text and
        // code. Cut the trailing comment (safe now that a URL's `//` went with
        // its string) and the spread is still excluded by shape.
        const residue = line
          .replace(STRING_RE, '""')
          .split("//")[0]
          .split("/*")[0];
        if (ASCII_ELLIPSIS_RE.test(residue)) {
          ascii.push(`${path.relative(ROOT, file)}:${i + 1} — ${line.trim()}`);
        }
      });
    }
    // Every entry is a string literal spelling an ellipsis with three periods.
    // Replace it with `…`; there is no exemption, because a spread is already
    // excluded by shape above.
    expect(ascii).toEqual([]);
  });

  // ---------------------------------------------------------------------------
  // AND NO COPY IS DOUBLY-ENCODED. Same file because it is the same failure one
  // layer down: a punctuation mark the house has one spelling for, rendered as
  // something else.
  //
  // `—` written into a UTF-8 file by a tool that thought it was Latin-1 becomes
  // the bytes `â€"`, which renders on the live page as `â€"` and greps as
  // nothing anybody would search for. One shipped on the admin overview's
  // reader-credits banner and survived tsc, the root lint, `next build`, a
  // screenshot and a careful read — it was found by looking at the rendered
  // page, which is the only thing that shows it.
  //
  // The scan is over the SOURCE BYTES rather than the decoded string: the
  // sequence is valid UTF-8 (that is the whole problem), so it reads back as
  // ordinary characters and only the byte pattern names it.
  // ---------------------------------------------------------------------------
  it("has no doubly-encoded punctuation in any source file", () => {
    // The mojibake forms of — – ' ' " " … : U+00C3 U+00A2 U+00C2 + the low byte.
    const MOJIBAKE = /\u00c3\u00a2\u00c2[\u0080-\u00bf]/;
    const hits: string[] = [];
    for (const file of files) {
      const raw = readFileSync(file, "latin1");
      raw.split("\n").forEach((line, i) => {
        if (MOJIBAKE.test(line)) {
          hits.push(`${path.relative(ROOT, file)}:${i + 1}`);
        }
      });
    }
    expect(hits).toEqual([]);
  });
});
