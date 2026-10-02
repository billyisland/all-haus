import { JSDOM } from "jsdom";

// =============================================================================
// article-captions — a picture caption is a SIGNAL THE PAGE ALREADY CARRIES,
// and we were throwing it away twice.
//
// A caption in a reader pane ran straight into the body prose because by the
// time the HTML reached the client there was nothing left to style. The signal
// dies in two places, both ours:
//
//   • Readability strips every `class` attribute unless `keepClasses` is set,
//     and for a large share of publishers the class IS the caption (NPR's
//     `div.credit-caption`, Wired, the LRB, every WordPress `wp-caption-text`).
//   • `sanitizeArticleContent` allows no `div`, so what survived arrived as
//     BARE TEXT between two paragraphs — indistinguishable from body prose to
//     any stylesheet, which is exactly what the reader showed.
//
// So the extract route now keeps classes (they never reach the client — the
// sanitiser's allowlist has no `class` on any tag), and this pass runs between
// the two: it normalises every caption it can PROVE into `<figure><figcaption>`,
// the one shape the sanitiser already permits and the reader can style.
//
// WHAT IT WILL NOT DO, which is the substance. Measured over 151 images across
// 21 publishers (Guardian, BBC, NPR, Ars, Wired, Verge, Nature, ProPublica,
// Aeon, Smithsonian, the LRB, Substack, …), three tiers carry 93 of them and
// each is a POSITIVE claim the page makes about itself:
//
//   T1  an existing <figcaption>            36   (Guardian, BBC, ProPublica…)
//   T2  a caption-classed element           54   (NPR, LRB, WordPress)
//   T3  a <dd> answering a <dt> of image     3   (Ars Technica)
//
// A fourth tier — "the short paragraph after the picture" — catches 15 more and
// is REFUSED. On the same corpus its hits were Nature's article-list links, the
// New Yorker's nav, and a genuine body sentence on kottke ("Looks pretty good,
// right?"). A missed caption reads as today's reader, which is ordinary; a body
// paragraph set in small sans reads as a bug, on the one surface whose whole job
// is to present somebody else's prose faithfully. Structure that is merely
// SUGGESTIVE is not structure, so an uncaptioned picture stays uncaptioned.
//
// The capability spans three places and widening one alone does nothing:
// `keepClasses` at the Readability call, this pass, and `figure`/`figcaption`
// in the sanitiser's article allowlist. Same shape as the embed allowlist and
// its `frame-src` twin — pinned together by tests/article-captions.test.ts.
// =============================================================================

/** A class that NAMES the element a caption. `caption` matches as a SUBSTRING,
 *  because publishers spell it every way there is (`wp-caption-text`,
 *  `figure__caption`, `imagecaption`) and inside an article body the word means
 *  one thing. `credit` and `cutline` are whole tokens only — `article-credits`
 *  is a byline and `discredit` is a word — which is the difference between a
 *  caption pass and a pass that also restyles the author line. */
const CAPTION_CLASS = /caption|(?:^|[\s_-])(?:credit|cutline)(?:[\s_-]|$)/i;

/** A caption is a line or two. Past this the element is a body block wearing a
 *  caption-ish class, and swallowing it would delete a paragraph from the piece
 *  (it renders, but as a caption — worse than leaving it alone). */
const MAX_CAPTION_CHARS = 600;

/** Below this an image is furniture — a byline avatar, a share icon, a tracking
 *  pixel — and the block after it is body text, not its caption. Only applied
 *  when the page states a size; an unstated one is treated as a real picture. */
const MIN_MEDIA_PX = 120;

const MEDIA_SELECTOR = "img, video, iframe";

function isCaptionClassed(el: Element): boolean {
  const cls = el.getAttribute("class");
  return !!cls && CAPTION_CLASS.test(cls);
}

function usableCaption(el: Element | null | undefined): el is Element {
  if (!el) return false;
  if (el.querySelector(MEDIA_SELECTOR)) return false; // another media block
  const text = el.textContent?.trim() ?? "";
  return text.length > 0 && text.length <= MAX_CAPTION_CHARS;
}

function tooSmall(media: Element): boolean {
  for (const attr of ["width", "height"]) {
    const raw = media.getAttribute(attr);
    if (!raw) continue;
    const n = Number.parseInt(raw, 10);
    if (Number.isFinite(n) && n > 0 && n < MIN_MEDIA_PX) return true;
  }
  return false;
}

/**
 * The MEDIA BOX: the outermost ancestor that still holds this one picture and
 * nothing else. Publishers wrap an image two or three divs deep, and the caption
 * is a sibling of the WRAPPER, never of the `<img>` — climbing is what makes
 * NPR's `div.credit-caption` reachable at all. It stops the moment an ancestor
 * carries prose of its own (a paragraph the image is floated inside) or a second
 * picture, so the box can never grow to swallow the article.
 */
function mediaBox(media: Element, body: Element): Element {
  let box = media;
  while (box.parentElement && box.parentElement !== body) {
    const parent = box.parentElement;
    if (parent.tagName === "FIGURE") return parent;
    const ownText = (parent.textContent ?? "").trim();
    if (ownText.length >= 15) break;
    if (parent.querySelectorAll(MEDIA_SELECTOR).length > 1) break;
    box = parent;
  }
  return box;
}

/** T2/T3: the element this page is calling the picture's caption, or null. */
function findCaption(media: Element, box: Element): Element | null {
  const figure = media.closest("figure");

  // T2a — inside the enclosing figure, but not yet marked up as one.
  if (figure) {
    for (const el of Array.from(figure.querySelectorAll("*"))) {
      if (isCaptionClassed(el) && usableCaption(el)) return el;
    }
  }

  // T2b — the block after the picture's wrapper, or a caption-classed element
  // inside it (a `div.caption-wrap > p.caption` is one shape of the same claim).
  const after = box.nextElementSibling;
  if (after && !after.querySelector("figure")) {
    if (isCaptionClassed(after) && usableCaption(after)) return after;
    for (const el of Array.from(after.querySelectorAll("*"))) {
      if (isCaptionClassed(el) && usableCaption(el)) return el;
    }
  }

  // T3 — a definition list used as a gallery: <dt> holds the picture, <dd>
  // answers it. The pairing is the page's own statement, not our inference.
  const dt = media.closest("dt");
  if (dt && dt.nextElementSibling?.tagName === "DD" && usableCaption(dt.nextElementSibling)) {
    return dt.nextElementSibling;
  }

  return null;
}

/** Re-tag `el` as <figcaption>, preserving its children. */
function toFigcaption(el: Element, doc: Document): Element {
  if (el.tagName === "FIGCAPTION") return el;
  const fc = doc.createElement("figcaption");
  while (el.firstChild) fc.appendChild(el.firstChild);
  el.replaceWith(fc);
  return fc;
}

/**
 * Normalise every provable picture caption in a Readability article body into
 * `<figure><figcaption>`. Input is the article HTML WITH classes intact (the
 * signal); output is the same HTML with captions marked up. Pure string in,
 * string out — the caller sanitises afterwards, which is what removes the
 * classes again.
 */
export function normaliseCaptions(html: string): string {
  if (!html || !/<(img|video|iframe)\b/i.test(html)) return html;

  let dom: JSDOM;
  try {
    dom = new JSDOM(`<body>${html}</body>`);
  } catch {
    return html; // a body we cannot parse is one we leave exactly as it was
  }
  const doc = dom.window.document;
  const body = doc.body;

  for (const media of Array.from(doc.querySelectorAll(MEDIA_SELECTOR))) {
    if (!media.isConnected || tooSmall(media)) continue;

    const existing = media.closest("figure")?.querySelector("figcaption");
    if (existing && (existing.textContent ?? "").trim()) continue; // T1, already right

    const box = mediaBox(media, body);
    const caption = findCaption(media, box);
    // A candidate that CONTAINS the picture is the picture's own wrapper, not
    // its caption; adopting it into a figure built around the box would be a
    // cycle. Refuse rather than rearrange.
    if (!caption || caption === box || caption.contains(box)) continue;

    // Build the figure where the box stands, then adopt the caption into it.
    let figure = box.tagName === "FIGURE" ? box : null;
    if (!figure) {
      figure = doc.createElement("figure");
      box.replaceWith(figure);
      figure.appendChild(box);
    }
    figure.appendChild(caption);
    toFigcaption(caption, doc);
  }

  return body.innerHTML;
}
