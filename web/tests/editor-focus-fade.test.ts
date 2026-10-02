import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import path from "node:path";

// =============================================================================
// The editor's focus fade is one rule held in THREE files, and nothing in any
// of them mentions the other two.
//
// The behaviour is a CSS rule in `globals.css`, its two hooks are class names
// in `ArticleEditor.tsx`, and the state it keys on — `.ProseMirror-focused` —
// is put there by prosemirror-view, which is upstream. Break any one of the
// three and the other two still compile, lint, build and render: the toolbar
// simply stops receding, with nothing red anywhere. That is the same shape as
// the embed allowlist ⟂ `frame-src` pair and the nginx reachability list, and
// it gets the same treatment — a grep, not a memory.
//
// This suite is deliberately NOT a behavioural test. jsdom implements neither
// `:has()` nor media queries nor compositing, so a render test here would pin
// jsdom's opinion rather than a browser's; the behaviour was proved by driving
// a real Chromium and reading the PAINTED PIXELS back (slice 5's As built).
// What is left over is the wiring, and the wiring is what silently rots.
// =============================================================================

const CSS = readFileSync(
  path.resolve(__dirname, "..", "src", "app", "globals.css"),
  "utf8",
);
const EDITOR_SRC = readFileSync(
  path.resolve(__dirname, "..", "src", "components", "editor", "ArticleEditor.tsx"),
  "utf8",
);
// Count hooks over CODE, not prose: the comments beside each hook name the
// class too, so a raw count says two columns where there is one.
const EDITOR = EDITOR_SRC.replace(/\{\/\*[\s\S]*?\*\/\}/g, "");

/** The fade rule, found by its DECLARATION — the one part no rename touches. */
const FADE_RULE = (() => {
  const m = CSS.match(/([^{}]*?)\{\s*opacity:\s*var\(--ah-chrome-rest\)[^}]*\}/);
  return m ? m[1].trim().replace(/\s+/g, " ") : null;
})();

describe("editor focus fade — the wiring, which is what rots silently", () => {
  // A selector rename would otherwise make every assertion below vacuous.
  it("found the rule at all", () => {
    expect(FADE_RULE).not.toBeNull();
    expect(CSS).toContain("--ah-chrome-rest");
  });

  it("keys on the BODY's focus, reaching it through the column's :has()", () => {
    // `:focus-within` on the chrome itself — which the plan originally named —
    // is wrong twice: false while you type, and true while a toolbar button is
    // being used, so the block would dim exactly when it is in use. Measured:
    // under that selector the fade is lost while typing (opacity 1) and appears
    // on a focused toolbar button (0.5).
    expect(FADE_RULE).toContain(".ah-editor-column:has(.ProseMirror-focused)");
  });

  it("keeps BOTH ways back — the pointer and the keyboard", () => {
    // Dropping `:not(:hover)` leaves the toolbar at 0.5 with the pointer on it;
    // dropping `:not(:focus-within)` leaves it dim while shift-tabbed into.
    expect(FADE_RULE).toContain(":not(:hover)");
    expect(FADE_RULE).toContain(":not(:focus-within)");
  });

  it("hangs both opt-outs on the one custom property, not on a second selector", () => {
    // Pointer-gated (no hover = no gesture to undim it) and contrast-gated
    // (we deliberately lowered contrast on a control). Both move
    // `--ah-chrome-rest` so nothing depends on source order or specificity.
    const rest = (q: string) =>
      new RegExp(
        `@media[^{]*${q}[^{]*\\{\\s*\\.ah-editor-chrome\\s*\\{[^}]*--ah-chrome-rest:\\s*([0-9.]+)`,
      ).exec(CSS)?.[1];

    expect(rest("hover: hover")).toBe("0.5");
    expect(rest("prefers-contrast: more")).toBe("1");
    // Reduced motion drops the TRANSITION, not the fade: the recession is a
    // state and only the crossing of it is motion.
    expect(CSS).toMatch(
      /@media\s*\(prefers-reduced-motion:\s*reduce\)\s*\{\s*\.ah-editor-chrome\s*\{\s*transition:\s*none/,
    );
  });

  it("has its hooks on the editor — the column once, the chrome twice", () => {
    // The column is the `:has()` anchor. Exactly one, or the anchor is ambiguous.
    expect(EDITOR.match(/ah-editor-column/g) ?? []).toHaveLength(1);
    // The toolbar row AND the cover panel: they are one block of tools, and a
    // full-opacity panel under a receded toolbar reads as two surfaces.
    expect((EDITOR.match(/ah-editor-chrome/g) ?? []).length).toBeGreaterThanOrEqual(2);
  });

  it("puts the chrome class on the ROW, never on the sticky wrapper", () => {
    // An opacity below 1 on the sticky wrapper takes its BACKGROUND with it,
    // and prose scrolls BEHIND a sticky element — so the writer's own
    // paragraphs ghost through the toolbar. Measured: moving the class up one
    // level puts a glyph pixel at 0.5·102 + 0.5·20 = 61 over prose ink.
    // The wrapper is the div carrying `sticky`; the row is the flex inside it.
    const stickyLine = EDITOR.split("\n").find((l) => l.includes('className="sticky'));
    expect(stickyLine).toBeDefined();
    expect(stickyLine).not.toContain("ah-editor-chrome");
    expect(EDITOR).toMatch(/ah-editor-chrome flex items-center/);
  });

  it("keys on a class prosemirror-view still writes", () => {
    // The one term in the selector that is not ours. An upstream rename kills
    // the fade in total silence, and nothing in our tree would mention it.
    const pmv = readFileSync(
      path.resolve(__dirname, "..", "node_modules", "prosemirror-view", "dist", "index.cjs"),
      "utf8",
    );
    expect(pmv).toContain('classList.add("ProseMirror-focused")');
  });
});
