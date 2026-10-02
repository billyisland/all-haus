import { escapeHtml } from "../text.js";

// =============================================================================
// THE ONE EMAIL LAYOUT. Every email all.haus sends is built here, and nowhere
// else writes a `style=` attribute into an email.
//
// An email is a SUBJECT, a HEADING and a list of BLOCKS. A template (one file
// per family under `./templates/`) returns that description and nothing else:
// no database, no send, no markup. `renderEmail` turns it into both bodies.
//
// WHY BLOCKS AND NOT MARKUP. Until this module every sender hand-wrote its own
// HTML: ten files pasted the same `<div style="font-family: …">` shell, each a
// little different (one button had lost its border-radius, three emails had no
// sign-off), and each wrote its plain-text body separately, so the two halves
// of one email said different things. Here the plain text and the HTML are two
// renderings of the same blocks, so they cannot disagree, and the look lives
// in `TOKENS` alone.
//
// EVERY STRING IS TEXT. A template never hands this module markup: inline
// emphasis and links are values (`strong`, `em`, `link`, `mail`), and the
// renderer escapes everything it prints. The old helpers interpolated a
// button's label raw and left escaping to each caller, so every template that
// put a display name in a label had to remember to escape it by hand.
//
// A URL IS GATED WHERE IT IS RENDERED. An href or image source that is not
// http(s) (or mailto, for a link) is dropped: a link renders as its label, an
// image not at all. Some URLs here come from member-controlled columns.
//
// THE VOICE. Plain, second person, British spelling. Say what happened and
// what the reader can do, in that order; name the Writer as the seller
// wherever money is mentioned (`.claude/rules/money.md`); never say all.haus is
// the seller, the payer or the biller. A notice that takes something away
// states what the member KEEPS in the same email.
//
// To see every email as it renders: `npx tsx scripts/email-preview.ts` (the
// catalogue is `./catalogue.ts`; a test fails when a template is missing).
// =============================================================================

// ---------------------------------------------------------------------------
// Inline content
// ---------------------------------------------------------------------------

export type Inline =
  | string
  | Inline[]
  | { strong: Inline }
  | { em: Inline }
  | { link: string; label?: Inline }
  | { mail: string };

export const strong = (body: Inline): Inline => ({ strong: body });
export const em = (body: Inline): Inline => ({ em: body });
/** A link. Without a label the URL is its own label, in both renderings. */
export const link = (href: string, label?: Inline): Inline => ({ link: href, label });
export const mail = (address: string): Inline => ({ mail: address });

// ---------------------------------------------------------------------------
// Blocks
// ---------------------------------------------------------------------------

export interface LedgerRow {
  label: string;
  detail?: string;
  amount: string;
  /** Said beside the amount — why a line is £0.00, for instance. */
  note?: string;
}

export type Block =
  | { kind: "p"; body: Inline; tone: "body" | "muted" }
  | { kind: "button"; href: string; label: string }
  | { kind: "list"; items: Inline[] }
  | { kind: "ledger"; rows: LedgerRow[] }
  | { kind: "byline"; name: string; avatarUrl: string | null }
  | { kind: "fine"; body: Inline }
  | { kind: "post"; action: string; label: string };

/** A paragraph. A `\n` inside a string is a line break, never a new paragraph. */
export const p = (...body: Inline[]): Block => ({ kind: "p", body, tone: "body" });
/** A writer's own words — an excerpt — set in the literary voice. */
export const muted = (...body: Inline[]): Block => ({ kind: "p", body, tone: "muted" });
/** The one thing to press. In plain text it becomes `label: url`. */
export const button = (href: string, label: string): Block => ({ kind: "button", href, label });
export const list = (items: Inline[]): Block => ({ kind: "list", items });
/** Itemised money lines: what, who, how much. */
export const ledger = (rows: LedgerRow[]): Block => ({ kind: "ledger", rows });
/** A person heading the email's content — the Writer of a published piece. */
export const byline = (name: string, avatarUrl: string | null): Block => ({ kind: "byline", name, avatarUrl });
/** Small print: the "if this wasn't you", the unsubscribe line. */
export const fine = (...body: Inline[]): Block => ({ kind: "fine", body });
/** A button that POSTs to `action` — PAGES ONLY (`renderPage`): a mail client
 *  runs no forms, and a GET that acts is what a link scanner presses. */
export const post = (action: string, label: string): Block => ({ kind: "post", action, label });

export interface EmailContent {
  subject: string;
  heading: string;
  blocks: Block[];
  /** The signed unsubscribe URL, for an email a reader can opt out of. It
   *  becomes the `List-Unsubscribe` header pair (RFC 2369 + RFC 8058 one-click),
   *  which the bulk-sender rules of Gmail and Yahoo require and which the mail
   *  client POSTs to — so the URL must ACT on a POST with no confirm step. */
  listUnsubscribe?: string;
}

export interface RenderedEmail {
  subject: string;
  textBody: string;
  htmlBody: string;
  /** Extra message headers; only present when the email carries any. */
  headers?: Record<string, string>;
}

export const SIGN_OFF = "all.haus: together we can make it";

// ---------------------------------------------------------------------------
// The look. Change it here and every email changes.
//
// The PUBLIC REGISTER's look (`.claude/rules/web-public.md`), because an email
// is read by people who are not signed in: a white card on the bone floor, the
// ∀ disc and wordmark above it, serif for the claim (the heading), mono for
// the prose, Literata for a writer's own words (an excerpt), square ink
// buttons (`.btn`), no line anywhere. Values are the light-mode triples of the
// web's colour registry (`web/src/lib/palette/registry.ts`); an email cannot
// read a CSS variable, so they are copied here, and only here.
//
// The three faces are the site's own files, fetched from APP_URL by the
// clients that honour `@font-face` (Apple Mail, iOS). Everything else (Gmail,
// Outlook) falls back down each stack, so every stack ends somewhere sane.
// ---------------------------------------------------------------------------

const TOKENS = {
  sans: "Jost, system-ui, -apple-system, 'Segoe UI', Roboto, sans-serif",
  serif: "Literata, Georgia, 'Times New Roman', serif",
  mono: "'IBM Plex Mono', ui-monospace, 'SF Mono', Menlo, Consolas, monospace",
  ink: "#111111", // --ah-ink
  bone: "#f0efeb", // --ah-bone: the floor
  card: "#ffffff", // --ah-white: PublicCard's ground
  standfirst: "#5f5e5a", // --ah-stone-600: PublicBody's muted ink
  meta: "#8a8880", // --ah-stone-400: cardMeta
  width: "560px",
} as const;

/** The disc for a bone ground (`web/public/brand/`), served by the web app. */
const DISC_PATH = "/brand/allhaus-disc-on-bone-1024.png";
const FONT_FILES = [
  ["Jost", "normal", "400 600", "jost-latin.woff2"],
  ["Literata", "normal", "300 700", "literata-latin-400.woff2"],
  ["Literata", "italic", "300 700", "literata-latin-400-italic.woff2"],
  ["IBM Plex Mono", "normal", "400", "ibm-plex-mono-latin-400.woff2"],
] as const;

const STYLE = {
  floor: `background: ${TOKENS.bone}; padding: 32px 16px;`,
  column: `max-width: ${TOKENS.width}; margin: 0 auto;`,
  masthead: `margin: 0 0 20px; font-family: ${TOKENS.sans}; font-size: 22px; font-weight: 500; letter-spacing: -0.01em; line-height: 28px; color: ${TOKENS.ink};`,
  mastheadLink: `color: ${TOKENS.ink}; text-decoration: none;`,
  disc: `vertical-align: middle; margin-right: 10px; border: 0;`,
  wordmark: `vertical-align: middle;`,
  card: `background: ${TOKENS.card}; padding: 32px 28px;`,
  heading: `font-family: ${TOKENS.serif}; font-size: 26px; font-weight: 500; letter-spacing: -0.02em; line-height: 1.2; color: ${TOKENS.ink}; margin: 0 0 20px;`,
  p: `font-family: ${TOKENS.mono}; font-size: 15px; letter-spacing: 0.01em; color: ${TOKENS.standfirst}; line-height: 1.65; margin: 0 0 16px;`,
  excerpt: `font-family: ${TOKENS.serif}; font-style: italic; font-size: 17px; color: ${TOKENS.ink}; line-height: 1.6; margin: 0 0 20px;`,
  strong: `color: ${TOKENS.ink}; font-weight: 600;`,
  link: `color: ${TOKENS.ink}; text-decoration: underline;`,
  buttonWrap: `margin: 8px 0 24px;`,
  button: `display: inline-block; background: ${TOKENS.ink}; color: ${TOKENS.card}; font-family: ${TOKENS.sans}; font-size: 15px; font-weight: 600; padding: 12px 32px; border-radius: 0; text-decoration: none;`,
  list: `font-family: ${TOKENS.mono}; font-size: 15px; letter-spacing: 0.01em; color: ${TOKENS.standfirst}; line-height: 1.65; margin: 0 0 16px; padding-left: 20px;`,
  table: `width: 100%; border-collapse: collapse; margin: 0 0 16px;`,
  cellLabel: `font-family: ${TOKENS.sans}; font-size: 15px; color: ${TOKENS.ink}; padding: 6px 12px 6px 0; vertical-align: top;`,
  cellAmount: `font-family: ${TOKENS.mono}; font-size: 14px; color: ${TOKENS.ink}; padding: 6px 0; text-align: right; white-space: nowrap; vertical-align: top;`,
  cellSub: `font-family: ${TOKENS.mono}; font-size: 12px; color: ${TOKENS.meta};`,
  byline: `margin: 0 0 20px;`,
  avatar: `border-radius: 50%; vertical-align: middle; margin-right: 10px;`,
  bylineName: `font-family: ${TOKENS.mono}; font-size: 12px; font-weight: 400; letter-spacing: 0.06em; text-transform: uppercase; color: ${TOKENS.ink}; vertical-align: middle;`,
  fine: `font-family: ${TOKENS.mono}; font-size: 12px; letter-spacing: 0.01em; color: ${TOKENS.meta}; line-height: 1.6; margin: 24px 0 0;`,
  signOff: `font-family: ${TOKENS.mono}; font-size: 11px; letter-spacing: 0.06em; text-transform: uppercase; color: ${TOKENS.meta}; margin: 20px 0 0;`,
} as const;

/** APP_URL when it is set, for the disc and the faces; without it they are left out. */
function siteBase(): string | null {
  const base = process.env.APP_URL?.trim();
  return base ? base.replace(/\/+$/, "") : null;
}

function fontFaces(base: string | null): string {
  if (!base) return "";
  const faces = FONT_FILES.map(
    ([family, style, weight, file]) =>
      `@font-face { font-family: '${family}'; font-style: ${style}; font-weight: ${weight}; src: url('${base}/fonts/${file}') format('woff2'); }`,
  ).join("\n");
  return `<style>\n${faces}\n</style>`;
}

/** The lockup, disc first — as `ForallLockup` sets it. The wordmark stands alone without APP_URL. */
function masthead(base: string | null): string {
  const disc = base
    ? `<img src="${escapeHtml(base + DISC_PATH)}" alt="" width="28" height="28" style="${STYLE.disc}" />`
    : "";
  const lockup = `${disc}<span style="${STYLE.wordmark}">all.haus</span>`;
  const href = base ? safeHref(base, false) : null;
  return `<div style="${STYLE.masthead}">${
    href ? `<a href="${escapeHtml(href)}" style="${STYLE.mastheadLink}">${lockup}</a>` : lockup
  }</div>`;
}

// ---------------------------------------------------------------------------
// URL gate
// ---------------------------------------------------------------------------

function safeHref(href: string, allowMailto: boolean): string | null {
  const trimmed = href.trim();
  if (/^https?:\/\//i.test(trimmed)) return trimmed;
  if (allowMailto && /^mailto:/i.test(trimmed)) return trimmed;
  return null;
}

// ---------------------------------------------------------------------------
// HTML
// ---------------------------------------------------------------------------

function inlineHtml(node: Inline): string {
  if (typeof node === "string") return escapeHtml(node).replace(/\n/g, "<br>");
  if (Array.isArray(node)) return node.map(inlineHtml).join("");
  if ("strong" in node) return `<strong style="${STYLE.strong}">${inlineHtml(node.strong)}</strong>`;
  if ("em" in node) return `<em>${inlineHtml(node.em)}</em>`;
  if ("mail" in node) {
    const href = safeHref(`mailto:${node.mail}`, true);
    return href
      ? `<a href="${escapeHtml(href)}" style="${STYLE.link}">${escapeHtml(node.mail)}</a>`
      : escapeHtml(node.mail);
  }
  const label = inlineHtml(node.label ?? node.link);
  const href = safeHref(node.link, true);
  return href ? `<a href="${escapeHtml(href)}" style="${STYLE.link}">${label}</a>` : label;
}

function blockHtml(block: Block): string {
  switch (block.kind) {
    case "p":
      return `<p style="${block.tone === "muted" ? STYLE.excerpt : STYLE.p}">${inlineHtml(block.body)}</p>`;
    case "button": {
      const href = safeHref(block.href, false);
      if (!href) return `<p style="${STYLE.p}">${escapeHtml(block.label)}</p>`;
      return `<p style="${STYLE.buttonWrap}"><a href="${escapeHtml(href)}" style="${STYLE.button}">${escapeHtml(block.label)}</a></p>`;
    }
    case "list":
      return `<ul style="${STYLE.list}">${block.items.map((i) => `<li>${inlineHtml(i)}</li>`).join("")}</ul>`;
    case "ledger":
      return (
        `<table style="${STYLE.table}">` +
        block.rows
          .map(
            (r) =>
              `<tr><td style="${STYLE.cellLabel}">${escapeHtml(r.label)}` +
              (r.detail ? `<div style="${STYLE.cellSub}">${escapeHtml(r.detail)}</div>` : "") +
              `</td><td style="${STYLE.cellAmount}">${escapeHtml(r.amount)}` +
              (r.note ? `<div style="${STYLE.cellSub}">${escapeHtml(r.note)}</div>` : "") +
              `</td></tr>`,
          )
          .join("") +
        `</table>`
      );
    case "byline": {
      const src = block.avatarUrl ? safeHref(block.avatarUrl, false) : null;
      const avatar = src
        ? `<img src="${escapeHtml(src)}" alt="" width="40" height="40" style="${STYLE.avatar}" />`
        : "";
      return `<div style="${STYLE.byline}">${avatar}<strong style="${STYLE.bylineName}">${escapeHtml(block.name)}</strong></div>`;
    }
    case "fine":
      return `<p style="${STYLE.fine}">${inlineHtml(block.body)}</p>`;
    case "post": {
      const action = safeHref(block.action, false);
      if (!action) return `<p style="${STYLE.p}">${escapeHtml(block.label)}</p>`;
      return `<form method="post" action="${escapeHtml(action)}" style="${STYLE.buttonWrap}"><button type="submit" style="${STYLE.button} border: 0; cursor: pointer;">${escapeHtml(block.label)}</button></form>`;
    }
  }
}

/** The blocks alone, without the shell — for tests of one block's rendering. */
export function renderBlocksHtml(blocks: Block[]): string {
  return blocks.map(blockHtml).join("\n");
}

/** The shell every email and page shares: bone floor, lockup, white card, sign-off. */
function shellHtml(headingTag: "h1" | "h2", heading: string, blocks: Block[]): string {
  const base = siteBase();
  return [
    fontFaces(base),
    `<div style="${STYLE.floor}">`,
    `<div style="${STYLE.column}">`,
    masthead(base),
    `<div style="${STYLE.card}">`,
    `<${headingTag} style="${STYLE.heading}">${escapeHtml(heading)}</${headingTag}>`,
    renderBlocksHtml(blocks),
    `</div>`,
    `<p style="${STYLE.signOff}">${escapeHtml(SIGN_OFF)}</p>`,
    `</div>`,
    `</div>`,
  ]
    .filter(Boolean)
    .join("\n");
}

function renderHtml(content: EmailContent): string {
  return shellHtml("h2", content.heading, content.blocks);
}

// ---------------------------------------------------------------------------
// Plain text — the same blocks, read aloud
// ---------------------------------------------------------------------------

function inlineText(node: Inline): string {
  if (typeof node === "string") return node;
  if (Array.isArray(node)) return node.map(inlineText).join("");
  if ("strong" in node) return inlineText(node.strong);
  if ("em" in node) return inlineText(node.em);
  if ("mail" in node) return node.mail;
  if (node.label === undefined) return node.link;
  const label = inlineText(node.label);
  return label === node.link ? label : `${label} (${node.link})`;
}

function blockText(block: Block): string {
  switch (block.kind) {
    case "p":
    case "fine":
      return inlineText(block.body);
    case "button":
      return `${block.label}: ${block.href}`;
    case "list":
      return block.items.map((i) => `  - ${inlineText(i)}`).join("\n");
    case "ledger":
      return block.rows
        .map(
          (r) =>
            `  ${[r.label, r.detail, r.amount].filter(Boolean).join(" — ")}` +
            (r.note ? ` (${r.note})` : ""),
        )
        .join("\n");
    case "byline":
      return block.name;
    case "post":
      return block.label;
  }
}

export function renderBlocksText(blocks: Block[]): string {
  return blocks.map(blockText).join("\n\n");
}

// ---------------------------------------------------------------------------
// Entry points
// ---------------------------------------------------------------------------

/** Both bodies from one description, each opening with the heading. */
export function renderEmail(content: EmailContent): RenderedEmail {
  const rendered: RenderedEmail = {
    subject: content.subject,
    textBody: `${content.heading}\n\n${renderBlocksText(content.blocks)}\n\n—\n${SIGN_OFF}`,
    htmlBody: renderHtml(content),
  };
  // https only: RFC 8058 one-click requires it, and the header is a URL a mail
  // client will POST to without asking anybody.
  const unsubscribe = content.listUnsubscribe?.trim();
  if (unsubscribe && /^https:\/\//i.test(unsubscribe)) {
    rendered.headers = {
      "List-Unsubscribe": `<${unsubscribe}>`,
      "List-Unsubscribe-Post": "List-Unsubscribe=One-Click",
    };
  }
  return rendered;
}

/**
 * A standalone page in the same look — for the handful of pages the gateway
 * serves itself, outside the web app (the unsubscribe confirmation). Same
 * blocks, same escaping; the heading is the page's `<h1>` and its title.
 */
export function renderPage(heading: string, blocks: Block[]): string {
  const safe = escapeHtml(heading);
  return `<!DOCTYPE html>
<html lang="en-GB">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<title>${safe} — all.haus</title>
</head>
<body style="margin: 0; min-height: 100vh; background: ${TOKENS.bone}; color: ${TOKENS.ink};">
${shellHtml("h1", heading, blocks)}
</body>
</html>`;
}
