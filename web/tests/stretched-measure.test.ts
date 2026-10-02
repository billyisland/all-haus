import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import path from "node:path";
import {
  stretchedMeasure,
  MEASURE_REST,
  MEASURE_CEIL,
  MEASURE_EFOLD,
} from "../src/lib/workspace/measure";

// =============================================================================
// The stretched measure is one rule held in SIX files, and nothing in any of
// them mentions the others.
//
// The curve is `lib/workspace/measure.ts`; the pane publishes it as a custom
// property (`Glasshouse.tsx`); a utility consumes that property (`globals.css`);
// four surfaces wear the utility; and its two endpoints are Tailwind tokens.
// Break any link and the rest still compile, lint, build and render — the column
// simply stops responding to the stretch, or quietly resizes at REST, with
// nothing red anywhere. Same shape as the editor focus fade next door, and it
// gets the same treatment: a grep, not a memory.
//
// The CURVE is testable for real (it is arithmetic), so that half is behavioural.
// The WIRING is not — jsdom resolves neither `theme()` nor a custom property set
// on an ancestor's inline style — so that half is a grep, and says so.
// =============================================================================

const web = (...p: string[]) => path.resolve(__dirname, "..", ...p);
const read = (...p: string[]) => readFileSync(web(...p), "utf8");

const CSS = read("src", "app", "globals.css");
const GLASSHOUSE = read("src", "components", "workspace", "Glasshouse.tsx");
const TAILWIND = read("tailwind.config.js");

// Surfaces that wear the utility. Strip JSX comments first: every one of these
// names the class in its own comment too, so a raw search says "wired" for a
// file whose className no longer carries it.
const SURFACES = {
  "ArticleEditor.tsx": ["src", "components", "editor", "ArticleEditor.tsx"],
  "ArticleReader.tsx": ["src", "components", "article", "ArticleReader.tsx"],
  "Composer.tsx": ["src", "components", "workspace", "Composer.tsx"],
  "ComposeOverlay.tsx": ["src", "components", "compose", "ComposeOverlay.tsx"],
} as const;

describe("the curve — arithmetic, so tested as arithmetic", () => {
  it("holds the rest measure until the pane is actually stretched", () => {
    // The whole point of pivoting on each pane's OWN default width: nothing
    // moves before anybody touches anything. A constant pivot would have shifted
    // every surface's appearance at rest, which is a different change entirely.
    expect(stretchedMeasure(1000, 1000)).toBe(MEASURE_REST);
    expect(stretchedMeasure(640, 640)).toBe(MEASURE_REST);
    expect(stretchedMeasure(736, 736)).toBe(MEASURE_REST);
    // Shrinking below the default holds it too, rather than going backwards.
    expect(stretchedMeasure(500, 1000)).toBe(MEASURE_REST);
  });

  it("is monotonic and bounded — it never passes the ceiling", () => {
    let prev = -1;
    for (let w = 640; w <= 4000; w += 8) {
      const m = stretchedMeasure(w, 640);
      expect(m).toBeGreaterThanOrEqual(prev);
      expect(m).toBeGreaterThanOrEqual(MEASURE_REST);
      expect(m).toBeLessThanOrEqual(MEASURE_CEIL);
      prev = m;
    }
  });

  it("CURVES — each further pixel of pane buys strictly less measure", () => {
    // This is the assertion the feature is named after, and the one a clamped
    // linear ramp (`clamp(640px, 50vw, 780px)`) would fail: a ramp's gain is
    // constant and then zero, which stalls under the pointer at the knee.
    const gain = (w: number) => stretchedMeasure(w + 200, 640) - stretchedMeasure(w, 640);
    const gains = [640, 840, 1040, 1240, 1440].map(gain);
    for (let i = 1; i < gains.length; i++) {
      expect(gains[i]).toBeLessThan(gains[i - 1]);
    }
    expect(gains[0]).toBeGreaterThan(0);
  });

  it("gives an even measure, so a centred column lands on whole pixels", () => {
    // Every consumer centres with `mx-auto` inside an even content box, and an
    // odd measure there puts the column on a half-pixel left edge — which
    // renders all of its text faintly fuzzy. Same reason `centreX` snaps the
    // pane's own left edge.
    for (let w = 640; w <= 3000; w += 7) {
      expect(stretchedMeasure(w, 640) % 2).toBe(0);
    }
  });

  it("reaches the e-folding point where it says it does", () => {
    // A silent change to EFOLD would leave every other assertion here green
    // while changing how the gesture feels.
    const atEfold = stretchedMeasure(1000 + MEASURE_EFOLD, 1000);
    const expected = MEASURE_CEIL - (MEASURE_CEIL - MEASURE_REST) / Math.E;
    expect(Math.abs(atEfold - expected)).toBeLessThanOrEqual(1);
  });
});

describe("the endpoints are existing tokens, not invented widths", () => {
  // The curve interpolates between two widths the design language already holds.
  // If either token moves and this file does not, the curve silently starts or
  // ends somewhere the rest of the site does not agree with.
  const token = (name: string) => {
    const m = TAILWIND.match(new RegExp(`['"]?${name}['"]?:\\s*'(\\d+)px'`));
    return m ? Number(m[1]) : null;
  };

  it("found the tokens at all", () => {
    expect(token("article")).not.toBeNull();
    expect(token("feed")).not.toBeNull();
  });

  it("rests at maxWidth.article and tops out at maxWidth.feed", () => {
    expect(MEASURE_REST).toBe(token("article"));
    expect(MEASURE_CEIL).toBe(token("feed"));
  });
});

describe("the wiring — a grep, because none of it is reachable from jsdom", () => {
  it("the pane publishes the property from the curve", () => {
    // Two halves: the import (so the number is the curve's, not a literal
    // re-derived here) and the property actually reaching the pane's style.
    expect(GLASSHOUSE).toContain("lib/workspace/measure");
    expect(GLASSHOUSE).toMatch(/stretchedMeasure\(effW,\s*widthFor\(maxWidth,\s*vp\.vw\)\)/);
    expect(GLASSHOUSE).toMatch(/"--ah-measure":\s*`\$\{pane\.measure\}px`/);
  });

  it("the utility consumes it, and falls back to the token for surfaces outside a pane", () => {
    const rule = CSS.match(/\.ah-measure\s*\{([^}]*)\}/);
    expect(rule).not.toBeNull();
    const body = rule![1].replace(/\s+/g, " ").trim();
    // The fallback is what keeps /write, /article/[dTag] and the public register
    // pixel-unchanged. Without it they would inherit `max-width: ` — i.e. none —
    // and every one of them would lose its column.
    expect(body).toContain("var(--ah-measure,");
    // `theme()`, not a literal: this IS maxWidth.article and the two must not drift.
    expect(body).toContain("theme('maxWidth.article')");
  });

  it("every surface that should curve does, in its className and not its prose", () => {
    for (const [name, p] of Object.entries(SURFACES)) {
      const code = read(...p).replace(/\{\/\*[\s\S]*?\*\/\}/g, "");
      expect(code, `${name} wears .ah-measure`).toContain("ah-measure");
    }
  });

  it("no surface still pins the old hard cap on the column it just uncapped", () => {
    // `max-w-article` is still correct elsewhere in these files (mastheads,
    // empty states); what must not survive is it sitting ON the measure column,
    // where it would win and the curve would be dead plumbing.
    for (const [name, p] of Object.entries(SURFACES)) {
      const code = read(...p).replace(/\{\/\*[\s\S]*?\*\/\}/g, "");
      for (const m of code.matchAll(/ah-measure/g)) {
        const line = code.slice(
          code.lastIndexOf("\n", m.index) + 1,
          code.indexOf("\n", m.index),
        );
        expect(line, `${name}: ah-measure sits beside max-w-article`).not.toContain(
          "max-w-article",
        );
      }
    }
  });
});
