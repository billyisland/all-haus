import { describe, it, expect } from "vitest";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { REPLY_CHAR_LIMIT } from "../src/lib/replies";

// =============================================================================
// The in-situ reply box must refuse exactly what the gateway refuses.
//
// A limit the client enforces BELOW the server's is not a validation, it is a
// feature quietly withdrawn: the Glasshouse composer applied the NOTE's 1,000
// characters to a reply `POST /replies` would have taken to 2,000, and nothing
// anywhere said so — the button simply went dead half way. Above it is the
// other failure, a 400 arriving after the writer has finished.
//
// Reads the gateway source rather than importing it: there is no module path
// between the two workspaces, which is also why this test has to exist.
// =============================================================================

const GATEWAY = join(__dirname, "../../gateway/src/routes/replies.ts");
const WEB_SRC = join(__dirname, "../src");

function sourceFiles(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) return sourceFiles(path);
    return /\.tsx?$/.test(name) ? [path] : [];
  });
}

describe("reply char limit parity with the gateway", () => {
  it("is the number the route's zod schema enforces", () => {
    const src = readFileSync(GATEWAY, "utf8");
    const m = src.match(/REPLY_CHAR_LIMIT\s*=\s*(\d+)/);
    // Assert we actually FOUND it: a renamed constant would otherwise make
    // this suite pass by testing nothing.
    expect(m, "gateway REPLY_CHAR_LIMIT not found — was it renamed?").toBeTruthy();
    expect(Number(m![1])).toBe(REPLY_CHAR_LIMIT);

    // And that the constant is what the schema actually spends. A limit
    // declared beside a hard-coded `.max(2000)` is a comment, not a bound.
    expect(
      /content:\s*z\.string\(\)\.min\(1\)\.max\(REPLY_CHAR_LIMIT\)/.test(src),
      "the /replies body schema must bound content by REPLY_CHAR_LIMIT",
    ).toBe(true);
  });

  it("is declared once on this side, and every reply composer reads that one (§0ab guard (b))", () => {
    // The parity above held for ONE of two composers: `ReplyComposer` carried
    // its own `const REPLY_CHAR_LIMIT = 2000` beside the pinned one, so the
    // gateway could move and half the reply surfaces would go on enforcing
    // the old number with this suite green. Derived, not listed: any
    // declaration of the name under `web/src` other than `lib/replies.ts`.
    const files = sourceFiles(WEB_SRC);
    expect(files.length).toBeGreaterThan(50);
    const declaring = files.filter((f) =>
      /\b(?:const|let|var)\s+REPLY_CHAR_LIMIT\b/.test(readFileSync(f, "utf8")),
    );
    expect(declaring.map((f) => f.slice(WEB_SRC.length))).toEqual(["/lib/replies.ts"]);

    // And both composers actually take it from there.
    for (const rel of ["components/post/NativeReplyBox.tsx", "components/replies/ReplyComposer.tsx"]) {
      const src = readFileSync(join(WEB_SRC, rel), "utf8");
      expect(src, rel).toMatch(/import\s*\{[^}]*\bREPLY_CHAR_LIMIT\b[^}]*\}\s*from\s*["'][./]*lib\/replies["']/);
    }
  });
});
