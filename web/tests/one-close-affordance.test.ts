import { describe, it, expect } from "vitest";
import { readdirSync, readFileSync, statSync } from "node:fs";
import path from "node:path";

// =============================================================================
// A mobile sheet has ONE dismiss affordance, and it is the ∀ disc — a grep, not
// a memory.
//
// On the mobile workspace every Glasshouse is a full-screen sheet and the disc
// flips to its minimise-X (MOBILE-LAYOUT-ADR §III, ForallMenu `showClose`).
// Nothing suppressed the pane's own ✕, so fourteen states drew two: the shared
// Glasshouse close plus, for the three panes with a coloured top band, a second
// one parented in the bar. The fix is one declaration
// (`stores/glasshouse.ts::useDiscCloseActive`) read at four render sites — and
// four copies of one rule is exactly the shape this repo loses silently, since
// a pane that forgets it looks correct on every desktop screenshot.
//
// The gate is the disc's DECLARATION and never `isMobile`: ProfileOverlay /
// SurfaceOverlay / EditorOverlay / ComposeOverlay are mounted globally by
// LayoutShell and open on routes with no disc (/article/:dTag, /:username,
// /read/:postId, the public register), where suppressing would strand the sheet
// with no way out on touch. So this suite also pins the two links no scan of
// the close sites can see: that ForallMenu is what declares it, and that the
// store defaults FALSE — the safe direction, a redundant ✕ for one frame rather
// than a sheet nobody can shut.
//
// Exemptions are BY NAME with the reason, like the href guard next door: a
// transient modal stacked ABOVE a sheet is not what the disc closes (pressing
// it would dismiss the host pane and leave the modal's owner gone), so its ✕ is
// load-bearing. A NEW un-gated close fails until somebody writes its line.
//
// A comment cannot fail. This can.
// =============================================================================

const ROOT = path.resolve(__dirname, "..", "src", "components");

// Keyed by path relative to src/components. Each is a transient modal that
// floats ABOVE the active Glasshouse rather than being one, so the disc-X does
// not target it and it must keep its own.
const EXEMPT = new Map<string, string>([
  [
    "ui/LightboxOverlay.tsx",
    "floats above the ForallMenu itself (z over 60) — the disc is behind it",
  ],
  // The two the widened label regex found, both out of scope by the rule's own
  // terms rather than by convenience: a `×` that REMOVES something is not a
  // dismiss affordance, and a devtool is not a mobile sheet.
  [
    // The chrome BOTH in-situ reply boxes wear (native + interact-back), which
    // is where this ✕ moved to when they were made one construction.
    "post/InlineReplyPanel.tsx",
    "`Close reply` removes the inline composer — a remove, not a pane dismiss",
  ],
  [
    "devtools/PalettePanel.tsx",
    "the palette devtool is not a Glasshouse and never renders on a mobile sheet",
  ],
]);

// How far above the close button the guard may sit. The four gated sites put it
// on the element or on the conditional immediately wrapping it; a generous
// window keeps the check about PRESENCE rather than about formatting.
const GUARD_WINDOW_LINES = 12;

function tsxFiles(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir)) {
    const full = path.join(dir, entry);
    if (statSync(full).isDirectory()) out.push(...tsxFiles(full));
    else if (entry.endsWith(".tsx")) out.push(full);
  }
  return out;
}

interface CloseSite {
  rel: string;
  line: number;
  guarded: boolean;
}

// A CLOSE IS A CLOSE WHATEVER ELSE ITS LABEL SAYS. The scan used to require
// the exact string `Close`, so `aria-label="Close menu"` — or any future
// `Close reader` — was simply not a site, and an un-gated ✕ could ship by
// being politely worded — and it found two real sites the old one could not
// see. (The ∀ disc's own X labels itself `Close menu`, but it builds that
// string in a multi-line ternary, so no line-based scan reaches it; it is the
// DECLARER and would be exempt in any case.)
const CLOSE_LABEL_RE = /aria-label=\{?["']Close\b/;

// `!discClose` is a TOKEN, and a token proves only that somebody typed it.
// `const discClose = false;` in a pane leaves every guard in that file reading
// `!false` — the ✕ renders unconditionally, the disc-X renders over it, and
// the suite stays green at 5/5. That is the exact defect `5466bd3f` fixed, so
// a site counts as guarded only when its file ALSO binds `discClose` to the
// real hook.
const BINDS_HOOK_RE = /\bdiscClose\s*=\s*useDiscCloseActive\(\)/;

function closeSites(): CloseSite[] {
  const out: CloseSite[] = [];
  for (const file of tsxFiles(ROOT)) {
    const source = readFileSync(file, "utf8");
    const bindsHook = BINDS_HOOK_RE.test(source);
    const lines = source.split("\n");
    lines.forEach((text, i) => {
      if (!CLOSE_LABEL_RE.test(text)) return;
      const from = Math.max(0, i - GUARD_WINDOW_LINES);
      const guarded =
        bindsHook && lines.slice(from, i).some((l) => /!discClose\b/.test(l));
      out.push({ rel: path.relative(ROOT, file), line: i + 1, guarded });
    });
  }
  return out;
}

describe("one close affordance per mobile sheet", () => {
  const sites = closeSites();

  it("finds the close affordances it is meant to be scanning", () => {
    // A moved directory would make every assertion below pass by scanning
    // nothing — the reassuring silence this family of checks exists to end.
    expect(sites.length).toBeGreaterThanOrEqual(5);
  });

  it("gates every pane-owned ✕ on the disc's declaration", () => {
    const ungated = sites
      .filter((s) => !s.guarded && !EXEMPT.has(s.rel))
      .map((s) => `${s.rel}:${s.line}`);
    // Each entry is either a pane that needs `!discClose` on its ✕, or a
    // transient modal that needs a line in EXEMPT above with its reason.
    expect(ungated).toEqual([]);
  });

  it("keeps every exemption real", () => {
    // An exemption for a file that no longer renders a close is a line nobody
    // will delete and the next reader will trust.
    const seen = new Set(sites.map((s) => s.rel));
    for (const rel of EXEMPT.keys()) expect(seen).toContain(rel);
  });

  it("names ForallMenu as the one declarer, and nothing else", () => {
    // The link no scan of the close sites can see. If the disc stops declaring,
    // every pane above silently keeps its ✕ hidden on a surface with no X at
    // all — the failure this whole change is guarding against, inverted.
    const declarers = tsxFiles(ROOT)
      .filter((f) => /_setDiscClose\(/.test(readFileSync(f, "utf8")))
      .map((f) => path.relative(ROOT, f));
    expect(declarers).toEqual(["workspace/ForallMenu.tsx"]);
  });

  it("defaults the declaration to false", () => {
    // The safe direction: a pane renders its own ✕ until a disc says otherwise.
    // Defaulting true would hide the close on every SSR'd profile register.
    const store = readFileSync(
      path.resolve(__dirname, "..", "src", "stores", "glasshouse.ts"),
      "utf8",
    );
    expect(store).toMatch(/discClose:\s*false/);
  });
});
