import { describe, it, expect } from "vitest";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { JSDOM } from "jsdom";
import { normaliseCaptions } from "../src/lib/article-captions.js";
import { sanitizeArticleContent } from "@platform-pub/shared/lib/sanitize.js";

// =============================================================================
// A picture caption survives from the origin page to the reader — or it is left
// as body text, deliberately.
//
// The capability spans THREE places and widening one alone renders nothing:
// `keepClasses: true` at the Readability call in routes/extract.ts (without it
// the caption's class — the whole signal for most publishers — is stripped
// before this code runs), normaliseCaptions, and `figure`/`figcaption` in the
// sanitiser's article allowlist (without which the markup is deleted on the way
// out). Same shape as the embed allowlist and its `frame-src` twin, so the
// assertions here run the WHOLE chain: every expectation is read off the
// SANITISED html, which is the string the reader actually receives.
//
// The fixtures are the real shapes, measured over 21 publishers: an existing
// <figcaption> (Guardian, BBC, ProPublica), a caption-classed sibling of the
// image's wrapper (NPR, the LRB, WordPress), and a <dd> answering a <dt> of
// image (Ars Technica). The NEGATIVE cases carry equal weight — a short
// paragraph after a picture is the tier this refuses, and a test suite whose
// only fixtures are captions passes green against a pass that captions
// everything.
// =============================================================================

function captions(html: string): string[] {
  const out = sanitizeArticleContent(normaliseCaptions(html));
  const doc = new JSDOM(`<body>${out}</body>`).window.document;
  return [...doc.querySelectorAll("figcaption")].map((f) =>
    (f.textContent ?? "").replace(/\s+/g, " ").trim(),
  );
}

/** Visible text, tags removed — nothing this pass does may add or lose a word. */
function words(html: string): string {
  return sanitizeArticleContent(html).replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim();
}

const IMG = '<img src="https://example.com/p.jpg" alt="a picture">';

describe("normaliseCaptions — what it marks up", () => {
  it("leaves an existing figcaption exactly where it is (T1)", () => {
    const html = `<figure><div>${IMG}</div><figcaption>Photograph: A Name/Getty</figcaption></figure><p>Body prose.</p>`;
    expect(captions(html)).toEqual(["Photograph: A Name/Getty"]);
  });

  it("adopts a caption-classed sibling of the image's wrapper (T2 — NPR)", () => {
    const html =
      `<div class="bucketwrap image"><div class="imagewrap"><picture>${IMG}</picture></div>` +
      `<div class="credit-caption">People walk past the memorial. <span>Ann Photographer/AP</span></div></div>` +
      `<p>A week into the semester, the campus was quiet.</p>`;
    expect(captions(html)).toEqual(["People walk past the memorial. Ann Photographer/AP"]);
  });

  it("adopts a caption nested inside the block after the picture (T2)", () => {
    const html =
      `<div class="wp-caption"><p>${IMG}</p></div>` +
      `<div class="caption-wrap"><p class="wp-caption-text">The thing itself.</p></div><p>Body prose.</p>`;
    expect(captions(html)).toEqual(["The thing itself."]);
  });

  it("adopts the <dd> answering a <dt> of image (T3 — Ars Technica)", () => {
    const html = `<dl><dt>${IMG}</dt><dd>Nobu Okada, centre, at the launch.</dd></dl><p>Body prose.</p>`;
    expect(captions(html)).toEqual(["Nobu Okada, centre, at the launch."]);
  });

  it("puts the caption INSIDE a figure with its own picture, not merely after it", () => {
    const html =
      `<div class="imagewrap">${IMG}</div><div class="caption">The caption.</div>` +
      `<div class="imagewrap"><img src="https://example.com/q.jpg" alt="second"></div>` +
      `<div class="caption">The other caption.</div>`;
    const doc = new JSDOM(
      `<body>${sanitizeArticleContent(normaliseCaptions(html))}</body>`,
    ).window.document;
    const figures = [...doc.querySelectorAll("figure")];
    expect(figures).toHaveLength(2);
    // Which caption belongs to which picture is the whole point: a pass that
    // emits two figures and two captions in the right ORDER but the wrong
    // PAIRING reads correctly in a flat string and wrongly on the page.
    expect(figures[0].querySelector("img")?.getAttribute("src")).toBe("https://example.com/p.jpg");
    expect(figures[0].querySelector("figcaption")?.textContent).toBe("The caption.");
    expect(figures[1].querySelector("img")?.getAttribute("src")).toBe("https://example.com/q.jpg");
    expect(figures[1].querySelector("figcaption")?.textContent).toBe("The other caption.");
  });
});

describe("normaliseCaptions — what it refuses", () => {
  it("does NOT caption the short paragraph after a picture", () => {
    // The refused tier, and the reason the whole pass is safe to ship: on the
    // measured corpus this shape was a genuine body sentence as often as a
    // caption. Body prose set in small sans is a visible defect; a missed
    // caption is today's reader.
    const html = `<p>${IMG}</p><p>Looks pretty good, right? I'm happy it found a home.</p>`;
    expect(captions(html)).toEqual([]);
  });

  it("does not take a paragraph that merely reads like a credit", () => {
    const html = `<p>${IMG}</p><p>Photograph: this sentence has no caption class anywhere.</p>`;
    expect(captions(html)).toEqual([]);
  });

  it("does not caption a byline avatar from the block beneath it", () => {
    const html =
      `<div><img src="https://example.com/a.jpg" width="36" height="36" alt="Jay"></div>` +
      `<div class="credit-caption">Not this author's photo credit.</div>`;
    expect(captions(html)).toEqual([]);
  });

  it("does not take a byline: `credit` is a whole token, never a substring", () => {
    const html = `<div class="imagewrap">${IMG}</div><div class="article-credits">By A Reporter</div>`;
    expect(captions(html)).toEqual([]);
  });

  it("does not swallow a body-length block wearing a caption class", () => {
    const long = "This is body prose that happens to sit in a classed div. ".repeat(20);
    const html = `<div class="imagewrap">${IMG}</div><div class="caption">${long}</div>`;
    expect(captions(html)).toEqual([]);
  });

  it("refuses a candidate that CONTAINS the picture", () => {
    // A wrapper is not a caption; adopting it into a figure built round the box
    // it contains would be a cycle. The assertion is that nothing is lost.
    const html = `<div class="caption"><p>${IMG}</p><p>Words inside the same wrapper.</p></div>`;
    const out = sanitizeArticleContent(normaliseCaptions(html));
    expect(out).toContain("Words inside the same wrapper.");
    expect(out).toContain("example.com/p.jpg");
  });

  it("leaves a body with no pictures byte-identical", () => {
    const html = `<p>One paragraph.</p><p class="caption">A classed one, with no image anywhere.</p>`;
    expect(normaliseCaptions(html)).toBe(html);
    expect(captions(html)).toEqual([]);
  });
});

describe("normaliseCaptions — it moves text, it never adds or loses any", () => {
  it("preserves every word of the body across all the shapes above", () => {
    const html =
      `<figure>${IMG}<figcaption>One.</figcaption></figure>` +
      `<div class="imagewrap"><img src="https://example.com/q.jpg"></div><div class="credit-caption">Two.</div>` +
      `<dl><dt><img src="https://example.com/r.jpg"></dt><dd>Three.</dd></dl>` +
      `<p>Body prose that must survive intact.</p>`;
    expect(words(normaliseCaptions(html))).toBe(words(html));
    expect(captions(html)).toEqual(["One.", "Two.", "Three."]);
  });
});

describe("the sanitiser is the third place, and it must not strip what we mark up", () => {
  it("keeps figure/figcaption through sanitizeArticleContent", () => {
    // If `figcaption` ever leaves the article allowlist this pass becomes an
    // expensive no-op with nothing anywhere saying so — the failure is silent
    // and looks exactly like a page that carried no captions.
    const out = sanitizeArticleContent("<figure><img src=\"https://e.com/a.jpg\"><figcaption>Cap.</figcaption></figure>");
    expect(out).toContain("<figcaption>");
    expect(out).toContain("<figure>");
  });

  it("strips the class the detector ran on, so nothing about the origin page leaks", () => {
    const out = sanitizeArticleContent(
      normaliseCaptions(`<div class="imagewrap">${IMG}</div><div class="credit-caption">Cap.</div>`),
    );
    expect(out).toContain("<figcaption>Cap.</figcaption>");
    expect(out).not.toContain("class=");
  });
});

describe("the extract route is the second place, and it is a text pin", () => {
  // The one link in the chain this file cannot exercise: every fixture above
  // arrives with its classes intact, so a route that let Readability strip them
  // would leave all fourteen tests green while the reader showed nothing. The
  // failure mode is silent and total, which is what earns a grep.
  const source = fs.readFileSync(
    path.join(path.dirname(fileURLToPath(import.meta.url)), "../src/routes/extract.ts"),
    "utf8",
  );

  it("asks Readability to keep classes, and hands the result to normaliseCaptions", () => {
    // Assert the call is THERE first — a moved or renamed route would make the
    // two assertions below pass over a file that no longer extracts anything.
    expect(source).toMatch(/new Readability\(/);
    expect(source).toMatch(/new Readability\([^)]*keepClasses:\s*true/s);
    expect(source).toMatch(/sanitizeArticleContent\(\s*normaliseCaptions\(/);
  });

  it("normalises BEFORE sanitising — the other order detects nothing", () => {
    // sanitizeArticleContent strips every class, so running it first destroys
    // the signal and leaves a pass that can only ever find an existing
    // <figcaption>. Both orders compile and neither errors.
    expect(source).not.toMatch(/normaliseCaptions\(\s*sanitizeArticleContent\(/);
  });
});
