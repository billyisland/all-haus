/**
 * Every line of interface copy in the web app, on one page — for review.
 *
 *   npm run copy:catalogue [-- out.html | out.json] [--fragment]   (from web/)
 *
 * Copy tier 3 (CONSOLIDATED-TODO › *Copy centralisation*). Tier 1 moved the
 * emails into templates and tier 2 moved the copy that carries RISK into
 * `src/content/`. Everything else stays INLINE, beside the component that shows
 * it, because a key indirection makes a component harder to read and buys
 * nothing without a second language. Inline copy cannot be read in one place
 * without moving it, so this script reads it in place instead: nothing in the
 * source moves, and the page says where each string lives.
 *
 * WHAT COUNTS AS COPY. The scan parses every file with the TypeScript compiler
 * rather than grepping, because copy is not only a string literal — JSX text
 * between two tags is invisible to a literal grep (the lesson of
 * `tests/ellipsis-house-style.test.ts`). It collects, per file:
 *   - text   JSX text between tags;
 *   - attr   a string given to a JSX attribute that carries words
 *            (`placeholder`, `aria-label`, `title`, `alt`, `label`, …), or to
 *            any attribute not on the technical list when the value reads as
 *            words;
 *   - expr   a string inside `{…}` in JSX children or a copy attribute,
 *            through `?:`, `??`, `||`, `&&` and template literals;
 *   - module every string in `src/content/` (the copy modules, which are
 *            already the home of the copy that carries risk);
 *   - code   any OTHER string that reads like a sentence — an error set in
 *            state, a toast, an object field the JSX renders later. This is a
 *            heuristic and the page says so: it is the part to skim.
 * A template literal is shown with each `${…}` as `{…}`, so a sentence that
 * interpolates a name still reads as a sentence.
 *
 * WHAT IS LEFT OUT. Comments; import paths; `className` and the other
 * technical attributes; strings passed to `console.*`, `cn`/`clsx`, and the
 * DOM/route helpers; the published legal texts (`content/legal/`), which are
 * their own pages with their own generator and are listed as a pointer. A
 * surface that is parked or behind a dark flag is still scanned, and labelled.
 *
 * Writes `~/allhaus-copy-catalogue.html` by default — the home directory and
 * not the system temp directory, because a Snap-packaged browser cannot see
 * /tmp. A path ending `.json` writes the raw entries instead, for diffing two
 * runs. `--fragment` writes the page without its document skeleton, which is
 * the form the Artifact tool publishes (it adds its own). Reads source only: no build, no gateway, no database.
 */

import { readFileSync, readdirSync, statSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";

import ts from "typescript";

const HERE = dirname(fileURLToPath(import.meta.url));
export const SRC = join(HERE, "..", "src");

export type CopyKind = "text" | "attr" | "expr" | "module" | "code";

export interface CopyEntry {
  /** Path relative to `web/src`, forward slashes. */
  file: string;
  line: number;
  kind: CopyKind;
  /** The attribute name (attr/expr inside an attribute) or the enclosing
   *  property / call name (code/module), when there is one. */
  where?: string;
  text: string;
}

// Attributes whose string is copy whatever it looks like.
const COPY_ATTRS = new Set([
  "placeholder", "title", "alt", "label", "aria-label", "aria-description",
  "aria-valuetext", "aria-roledescription", "heading", "subheading", "subtitle",
  "description", "message", "hint", "caption", "tooltip", "prompt", "body",
  "text", "emptyText", "emptyLabel", "confirmLabel", "cancelLabel",
  "submitLabel", "actionLabel", "busyLabel", "pendingLabel", "doneLabel",
  "eyebrow", "kicker", "lede", "note", "detail", "summary", "question",
]);

// Attributes whose string is never copy.
const TECH_ATTRS = new Set([
  "className", "class", "style", "id", "key", "href", "src", "srcSet", "type",
  "name", "role", "rel", "target", "method", "action", "htmlFor", "for", "lang",
  "variant", "size", "tone", "kind", "mode", "as", "align", "side", "position",
  "inputMode", "autoComplete", "enterKeyHint", "pattern", "accept", "form",
  "encType", "fill", "stroke", "viewBox", "d", "xmlns", "width", "height",
  "strokeWidth", "strokeLinecap", "strokeLinejoin", "fillRule", "clipRule",
  "transform", "points", "cx", "cy", "r", "rx", "ry", "x", "y", "x1", "x2",
  "y1", "y2", "offset", "stopColor", "gradientUnits", "dir", "loading",
  "decoding", "referrerPolicy", "sandbox", "allow", "crossOrigin", "media",
  "sizes", "dateTime", "colorScheme", "scheme", "icon", "slot", "testId",
  "data-testid", "aria-controls", "aria-labelledby", "aria-describedby",
  "aria-haspopup", "aria-live", "aria-current", "aria-hidden", "aria-expanded",
  "aria-pressed", "aria-selected", "aria-checked", "aria-modal", "aria-busy",
  "aria-orientation", "aria-autocomplete", "aria-invalid", "aria-disabled",
  "tabIndex", "value", "defaultValue", "min", "max", "step", "path", "route",
  "storageKey", "queryKey", "explainKey", "explain", "anchor", "placement",
  "cursor", "font", "weight", "voice", "register", "surface", "palette",
  "colour", "color", "accent", "background", "ink", "level", "status",
]);

// Calls whose string arguments are never copy.
const TECH_CALLS = new Set([
  "cn", "clsx", "classNames", "require", "fetch", "request", "get", "post",
  "put", "patch", "del", "querySelector", "querySelectorAll", "getElementById",
  "addEventListener", "removeEventListener", "getItem", "setItem",
  "removeItem", "matchMedia", "push", "replace", "prefetch", "redirect",
  "notFound", "startsWith", "endsWith", "includes", "split", "join", "test",
  "match", "matchAll", "padStart", "padEnd", "toLocaleDateString",
  "toLocaleString", "toLocaleTimeString", "DateTimeFormat", "NumberFormat",
  "getPropertyValue", "setProperty", "createElement", "setAttribute",
  "getAttribute", "hasAttribute", "removeAttribute", "postMessage", "open",
  "useSearchParams", "searchParams", "has", "append", "set", "delete",
  "encodeURIComponent", "dynamic", "localeCompare", "RegExp", "Symbol",
  "useExplainable", "registerExplain", "track", "emit", "on", "off", "closest",
]);

// Object fields and variables whose string is a style value, never copy.
const STYLE_NAMES = new Set([
  "transition", "transform", "animation", "boxShadow", "background", "backgroundImage",
  "border", "borderTop", "borderBottom", "borderLeft", "borderRight", "rel", "font", "fontFamily", "fontVariationSettings",
  "gridTemplateColumns", "gridTemplateRows", "gridTemplateAreas", "clipPath", "filter",
  "backdropFilter", "mask", "maskImage", "WebkitMaskImage", "margin", "padding", "inset",
  "outline", "textShadow", "willChange", "transformOrigin", "fontFeatureSettings",
  "paddingTop", "paddingBottom", "fontSize", "lineHeight", "top", "bottom", "left", "right",
  "className", "classes", "cls",
]);

// A file or directory that is parked, suspended, dev-only or seen only by the
// operator. Scanned anyway; the page labels it so a reviewer can choose to skip
// it.
export const DARK: { prefix: string; why: string }[] = [
  { prefix: "components/devtools/", why: "dev-only tool" },
  { prefix: "components/tribute/", why: "tributes suspended" },
  { prefix: "app/tribute/", why: "tributes suspended" },
  { prefix: "components/publication/", why: "publications suspended" },
  { prefix: "app/pub/", why: "publications suspended" },
  { prefix: "components/trust/", why: "trust graph parked" },
  { prefix: "app/admin/", why: "operator only" },
  { prefix: "components/admin/", why: "operator only" },
];

const SKIP_FILES = [/\.generated\.ts$/, /^content\/legal\//, /\.d\.ts$/, /\.test\.tsx?$/];

function walk(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) out.push(...walk(full));
    else if (/\.tsx?$/.test(entry)) out.push(full);
  }
  return out;
}

/** Collapse runs of whitespace — JSX text and multi-line literals carry the
 *  source's indentation, which is not part of the copy. */
function squash(s: string): string {
  return s.replace(/\s+/g, " ").trim();
}

const hasLetter = (s: string) => /\p{L}/u.test(s);

// JSX text carries HTML entities as written (`You&rsquo;ve`); a reviewer reads
// the character. The named ones the tree actually uses, plus numeric forms.
const ENTITIES: Record<string, string> = {
  amp: "&", lt: "<", gt: ">", quot: '"', apos: "'", nbsp: "\u00a0", rsquo: "’",
  lsquo: "‘", rdquo: "”", ldquo: "“", mdash: "—", ndash: "–", hellip: "…",
  middot: "·", times: "×", pound: "£", copy: "©", larr: "←", rarr: "→",
  uarr: "↑", darr: "↓", bull: "•", forall: "∀", thinsp: "\u2009",
};
export function decodeEntities(s: string): string {
  return s.replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (m, e: string) => {
    if (e[0] === "#") {
      const n = e[1] === "x" || e[1] === "X" ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10);
      return Number.isFinite(n) ? String.fromCodePoint(n) : m;
    }
    return ENTITIES[e.toLowerCase()] ?? m;
  });
}

/** Reads as WORDS rather than as an identifier, a path, a class list or a key:
 *  at least one space, a lowercase letter, no path-, url- or token-shaped
 *  run, and not a list of lowercase-hyphen tokens (a class string). */
export function readsAsWords(s: string): boolean {
  // A template's `{…}` stands for a value, not a word: judge what is around it.
  const t = squash(s.replace(/\{[^{}]*\}/g, " "));
  if (!/\s/.test(t) || !/\p{Ll}/u.test(t)) return false;
  if (/^(https?:|mailto:|\/|\.\/|#|@|\{|\[|<)/.test(t)) return false;
  if (/^[a-zA-Z-]+\(/.test(t)) return false; // a CSS function: calc(…), color-mix(…), translateX(…)
  // A class list: lowercase tokens, most of them carrying a hyphen, colon,
  // slash, bracket or digit (`btn-soft py-1.5 hover:text-ink`). Lowercase
  // PROSE has a token like that rarely, so the test is the share, not any.
  const tokens = t.split(" ");
  if (
    !/\p{Lu}/u.test(t) &&
    tokens.every((w) => /^[\w:./[\]()%#&!=-]+$/.test(w)) &&
    tokens.filter((w) => /[-:/[\]\d]/.test(w)).length * 2 >= tokens.length
  ) {
    return false;
  }
  if (/(^|\s)(SELECT|INSERT|UPDATE|DELETE)\s/.test(t)) return false;
  return true;
}

/** A literal's text, with a template's substitutions shown as `{…}`. */
function literalText(node: ts.Node, sf: ts.SourceFile): string | null {
  if (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node)) return node.text;
  if (ts.isTemplateExpression(node)) {
    let s = node.head.text;
    for (const span of node.templateSpans) s += `{${squash(span.expression.getText(sf))}}` + span.literal.text;
    return s;
  }
  return null;
}

/** The literals an expression can evaluate to, through the operators copy is
 *  usually chosen with. */
function literalsOf(expr: ts.Expression): ts.Node[] {
  if (ts.isParenthesizedExpression(expr) || ts.isAsExpression(expr) || ts.isNonNullExpression(expr)) {
    return literalsOf(expr.expression);
  }
  if (ts.isConditionalExpression(expr)) return [...literalsOf(expr.whenTrue), ...literalsOf(expr.whenFalse)];
  if (ts.isBinaryExpression(expr)) {
    const op = expr.operatorToken.kind;
    if (op === ts.SyntaxKind.AmpersandAmpersandToken) return literalsOf(expr.right);
    if (op === ts.SyntaxKind.BarBarToken || op === ts.SyntaxKind.QuestionQuestionToken || op === ts.SyntaxKind.PlusToken) {
      return [...literalsOf(expr.left), ...literalsOf(expr.right)];
    }
    return [];
  }
  if (ts.isStringLiteral(expr) || ts.isNoSubstitutionTemplateLiteral(expr) || ts.isTemplateExpression(expr)) {
    return [expr];
  }
  return [];
}

function calleeName(call: ts.CallExpression | ts.NewExpression): string | undefined {
  const e = call.expression;
  if (ts.isIdentifier(e)) return e.text;
  if (ts.isPropertyAccessExpression(e)) {
    if (ts.isIdentifier(e.expression) && e.expression.text === "console") return "console";
    return e.name.text;
  }
  return undefined;
}

/** The nearest name that says what a stray literal is FOR: the property it is
 *  the value of, the variable it initialises, or the call it is an argument
 *  to. */
function enclosingName(node: ts.Node): string | undefined {
  const p = node.parent;
  if (!p) return undefined;
  if (ts.isPropertyAssignment(p) && p.initializer === node) return p.name.getText();
  if (ts.isVariableDeclaration(p) && p.initializer === node) return p.name.getText();
  if ((ts.isCallExpression(p) || ts.isNewExpression(p)) && p.arguments?.includes(node as ts.Expression)) {
    return calleeName(p);
  }
  if (ts.isConditionalExpression(p) || ts.isBinaryExpression(p) || ts.isParenthesizedExpression(p)) {
    return enclosingName(p);
  }
  return undefined;
}

/** A literal that is structurally never copy: an import or export path, a
 *  property NAME, a type, a `case` label, an `===` operand, an index key. */
function isStructural(node: ts.Node): boolean {
  const p = node.parent;
  if (!p) return false;
  if (ts.isImportDeclaration(p) || ts.isExportDeclaration(p) || ts.isExternalModuleReference(p)) return true;
  if (ts.isImportTypeNode(p.parent ?? p) || ts.isLiteralTypeNode(p)) return true;
  if ((ts.isPropertyAssignment(p) || ts.isPropertySignature(p) || ts.isMethodDeclaration(p)) && p.name === node) return true;
  if (ts.isElementAccessExpression(p) && p.argumentExpression === node) return true;
  if (ts.isCaseClause(p)) return true;
  if (ts.isBinaryExpression(p)) {
    const op = p.operatorToken.kind;
    if (
      op === ts.SyntaxKind.EqualsEqualsEqualsToken || op === ts.SyntaxKind.ExclamationEqualsEqualsToken ||
      op === ts.SyntaxKind.EqualsEqualsToken || op === ts.SyntaxKind.ExclamationEqualsToken ||
      op === ts.SyntaxKind.InKeyword
    ) {
      return true;
    }
  }
  if (ts.isExpressionStatement(p)) return true; // "use client"
  return false;
}

export function extractFile(abs: string, src: string): CopyEntry[] {
  const file = relative(SRC, abs).split(sep).join("/");
  const sf = ts.createSourceFile(abs, src, ts.ScriptTarget.Latest, true, abs.endsWith(".tsx") ? ts.ScriptKind.TSX : ts.ScriptKind.TS);
  const isModule = file.startsWith("content/");
  const out: CopyEntry[] = [];
  const claimed = new Set<ts.Node>();
  const lineOf = (n: ts.Node) => sf.getLineAndCharacterOfPosition(n.getStart(sf)).line + 1;

  const push = (node: ts.Node, kind: CopyKind, text: string, where?: string) => {
    const t = squash(text);
    if (!t || !hasLetter(t)) return;
    out.push({ file, line: lineOf(node), kind, where, text: t });
  };

  const visit = (node: ts.Node): void => {
    if (ts.isJsxText(node)) {
      push(node, "text", decodeEntities(node.text));
    } else if (ts.isJsxAttribute(node) && node.initializer) {
      const name = node.name.getText(sf);
      const init = node.initializer;
      const exprs = ts.isStringLiteral(init)
        ? [init]
        : ts.isJsxExpression(init) && init.expression
          ? literalsOf(init.expression)
          : [];
      for (const lit of exprs) {
        claimed.add(lit);
        const text = literalText(lit, sf);
        if (text === null || TECH_ATTRS.has(name) || name.startsWith("data-") || /^on[A-Z]/.test(name)) continue;
        if (COPY_ATTRS.has(name) || readsAsWords(text)) push(lit, lit === init ? "attr" : "expr", text, name);
      }
    } else if (ts.isJsxExpression(node) && node.expression && !ts.isJsxAttribute(node.parent)) {
      for (const lit of literalsOf(node.expression)) {
        claimed.add(lit);
        const text = literalText(lit, sf);
        if (text !== null) push(lit, "expr", text);
      }
    } else if (
      (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node) || ts.isTemplateExpression(node)) &&
      !claimed.has(node)
    ) {
      const text = literalText(node, sf);
      if (text !== null && !isStructural(node)) {
        const where = enclosingName(node);
        const techCall =
          where !== undefined && (where === "console" || TECH_CALLS.has(where) || STYLE_NAMES.has(where) || /className$|Class$/.test(where));
        if (isModule) {
          // A lowercase single token is a key or a slug (`feed-merge`), not copy.
          if (!techCall && hasLetter(text) && !(/^[\w./-]+$/.test(text) && !/\p{Lu}/u.test(text))) {
            push(node, "module", text, where);
          }
        } else if (!techCall && readsAsWords(text)) {
          push(node, "code", text, where);
        }
      }
      // A template's own substitutions can hold literals too.
      if (ts.isTemplateExpression(node)) node.templateSpans.forEach((s) => visit(s.expression));
      return;
    }
    ts.forEachChild(node, visit);
  };
  visit(sf);
  return out.sort((a, b) => a.line - b.line);
}

export function extractAll(root = SRC): CopyEntry[] {
  const out: CopyEntry[] = [];
  for (const abs of walk(root)) {
    const rel = relative(root, abs).split(sep).join("/");
    if (SKIP_FILES.some((re) => re.test(rel))) continue;
    out.push(...extractFile(abs, readFileSync(abs, "utf8")));
  }
  return out;
}

// --- grouping -----------------------------------------------------------------

export interface Surface {
  register: string;
  name: string;
  dark?: string;
  entries: CopyEntry[];
}

const REGISTERS = ["Pages", "Components", "Copy modules", "Hooks, stores and lib", "modernhaus"] as const;

/** Which surface a file belongs to: a page by its route, a component by its
 *  directory, a copy module by itself. */
export function surfaceOf(file: string): { register: string; name: string } {
  const parts = file.split("/");
  if (parts[0] === "app") {
    if (parts[1] === "modernhaus") return { register: "modernhaus", name: "app/modernhaus" };
    const route = parts.slice(1, -1).filter((p) => !/^\(.*\)$/.test(p));
    return { register: "Pages", name: "/" + route.join("/") };
  }
  if (parts[0] === "components") {
    return { register: "Components", name: parts.length > 2 ? `components/${parts[1]}` : "components (top level)" };
  }
  if (parts[0] === "content") return { register: "Copy modules", name: file.replace(/\.tsx?$/, "") };
  if (parts[0] === "modernhaus") return { register: "modernhaus", name: parts.slice(0, Math.min(parts.length - 1, 2)).join("/") || "modernhaus" };
  return { register: "Hooks, stores and lib", name: parts.length > 2 ? parts.slice(0, 2).join("/") : file.replace(/\.tsx?$/, "") };
}

export function group(entries: CopyEntry[]): Surface[] {
  const by = new Map<string, Surface>();
  for (const e of entries) {
    const { register, name } = surfaceOf(e.file);
    const key = `${register}\0${name}`;
    let s = by.get(key);
    if (!s) {
      const dark = DARK.find((d) => e.file.startsWith(d.prefix))?.why;
      s = { register, name, dark, entries: [] };
      by.set(key, s);
    }
    s.entries.push(e);
  }
  const order = (r: string) => REGISTERS.indexOf(r as (typeof REGISTERS)[number]);
  return [...by.values()].sort((a, b) => order(a.register) - order(b.register) || a.name.localeCompare(b.name));
}

// --- the page -----------------------------------------------------------------

const esc = (s: string) =>
  s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");

const KIND_NOTE: Record<CopyKind, string> = {
  text: "JSX text",
  attr: "attribute",
  expr: "in {…}",
  module: "copy module",
  code: "string in code (heuristic)",
};

/** The fragment as a file a browser opens directly. */
export function standalone(fragment: string): string {
  return `<!doctype html>\n<html lang="en-GB"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover"></head><body>\n${fragment}</body></html>\n`;
}

export function renderPage(entries: CopyEntry[], generatedAt: string): string {
  const surfaces = group(entries);
  const counts = (Object.keys(KIND_NOTE) as CopyKind[]).map(
    (k) => `<span class="chip k-${k}">${esc(KIND_NOTE[k])} · ${entries.filter((e) => e.kind === k).length}</span>`,
  );
  let body = "";
  let register = "";
  for (const s of surfaces) {
    if (s.register !== register) {
      register = s.register;
      body += `<h2>${esc(register)}</h2>`;
    }
    const rows = s.entries
      .map(
        (e) =>
          `<tr class="k-${e.kind}" data-kind="${e.kind}"><td class="t">${esc(e.text)}</td>` +
          `<td class="m">${esc(KIND_NOTE[e.kind])}${e.where ? ` · <code>${esc(e.where)}</code>` : ""}</td>` +
          `<td class="m"><code>${esc(e.file)}:${e.line}</code></td></tr>`,
      )
      .join("");
    body +=
      `<details class="surface"${s.dark ? ' data-dark="1"' : ""}><summary><span class="n">${esc(s.name)}</span>` +
      `${s.dark ? ` <span class="dark">${esc(s.dark)}</span>` : ""} <span class="c">${s.entries.length}</span></summary>` +
      `<table>${rows}</table></details>`;
  }

  // A fragment, not a document: the Artifact host wraps a published page in
  // its own skeleton, and `standalone()` below wraps it for a local file.
  // The look is the public register's — bone floor, white cards, Literata
  // headings, Plex Mono body — with the registry's values copied in, as the
  // email layout does.
  return `<title>Copy catalogue</title>
<link rel="preconnect" href="https://fonts.googleapis.com">
<link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
<link rel="stylesheet" href="https://fonts.googleapis.com/css2?family=IBM+Plex+Mono:ital,wght@0,400;0,500;1,400&family=Literata:opsz,wght@7..72,500;7..72,600&display=swap">
<style>
:root{--bg:#f0efeb;--card:#ffffff;--ink:#111111;--muted:#5f5e5a;--meta:#8a8880;--line:#e3e1db;--chip:#e6e4de;--code:#7a4a1c;--focus:#111111;
--serif:Literata,Georgia,"Times New Roman",serif;--mono:"IBM Plex Mono",ui-monospace,"SF Mono",Menlo,Consolas,monospace}
@media (prefers-color-scheme:dark){:root:not([data-theme="light"]){color-scheme:dark;--bg:#161615;--card:#21201e;--ink:#ecebe7;--muted:#b0aea7;--meta:#8a8880;--line:#33322f;--chip:#2c2b28;--code:#e2b07a;--focus:#ecebe7}}
:root[data-theme="dark"]{color-scheme:dark;--bg:#161615;--card:#21201e;--ink:#ecebe7;--muted:#b0aea7;--meta:#8a8880;--line:#33322f;--chip:#2c2b28;--code:#e2b07a;--focus:#ecebe7}
*{box-sizing:border-box}
body{margin:0;background:var(--bg);color:var(--ink);font:14px/1.5 var(--mono);padding-inline:16px;padding-block:28px 80px}
main{max-width:1100px;margin:0 auto}
h1{font:600 30px/1.15 var(--serif);margin:0 0 8px;text-wrap:balance}
h2{font:600 19px/1.2 var(--serif);margin:36px 0 10px}
p.lede{color:var(--muted);margin:0 0 18px;max-width:72ch}
.bar{position:sticky;top:env(safe-area-inset-top,0px);background:var(--bg);padding-block:10px;display:flex;flex-wrap:wrap;gap:10px;align-items:center;z-index:1}
input[type=search]{flex:1 1 260px;min-width:0;font:inherit;padding:8px 10px;border:2px solid var(--line);background:var(--card);color:var(--ink)}
label{font-size:12px;color:var(--muted);display:flex;gap:6px;align-items:center}
button{font:inherit;font-size:12px;text-transform:uppercase;letter-spacing:.06em;padding:6px 10px;border:0;background:var(--ink);color:var(--bg);cursor:pointer}
:focus-visible{outline:2px solid var(--focus);outline-offset:2px}
.chips{display:flex;flex-wrap:wrap;gap:6px;margin:6px 0 0}
.chip{font-size:11px;letter-spacing:.04em;background:var(--chip);padding:3px 8px;font-variant-numeric:tabular-nums}
details.surface{background:var(--card);margin:0 0 6px}
summary{padding:9px 12px;cursor:pointer;display:flex;flex-wrap:wrap;gap:8px;align-items:baseline}
summary .n{font-weight:500}
summary .c{margin-left:auto;color:var(--meta);font-size:12px;font-variant-numeric:tabular-nums}
.dark{font-size:10px;text-transform:uppercase;letter-spacing:.08em;color:var(--muted);background:var(--chip);padding:1px 6px}
table{width:100%;border-collapse:collapse;table-layout:fixed}
td{padding:7px 12px;border-top:2px solid var(--bg);vertical-align:top;overflow-wrap:anywhere}
td.t{width:56%;font-size:14px}
td.m{color:var(--meta);font-size:11px}
code{font-family:var(--mono);color:var(--code)}
tr.k-code td.t{font-style:italic;color:var(--muted)}
.hidden{display:none}
@media (max-width:640px){td{display:block;width:auto!important;border-top:0;padding:2px 12px}tr{display:block;border-top:2px solid var(--bg);padding-block:6px}}
@media (prefers-reduced-motion:reduce){*{scroll-behavior:auto}}
</style><main>
<h1>Copy catalogue</h1>
<p class="lede">Every user-facing string in <code>web/src</code>, read in place and grouped by surface. Nothing here has been moved: each line names its file. ${entries.length} strings across ${surfaces.length} surfaces, generated ${esc(generatedAt)} by <code>web/scripts/copy-catalogue.ts</code>. Italic rows are the heuristic “string in code” pass — skim those. The published legal texts are not here; they are <code>web/src/content/legal/*.md</code>, and the emails are <code>scripts/email-preview.ts</code>.</p>
<div class="bar">
<input type="search" id="q" placeholder="Filter by words, file or attribute…" autofocus>
<label><input type="checkbox" id="code" checked> heuristic rows</label>
<label><input type="checkbox" id="dark" checked> parked and operator-only surfaces</label>
<button id="open">Expand all</button><button id="shut">Collapse all</button>
</div>
<div class="chips">${counts.join("")}</div>
${body}
</main>
<script>
const q=document.getElementById('q'),code=document.getElementById('code'),dark=document.getElementById('dark');
const surfaces=[...document.querySelectorAll('details.surface')];
function apply(){
  const term=q.value.trim().toLowerCase();
  for(const d of surfaces){
    const darkOff=!dark.checked&&d.dataset.dark;
    let shown=0;
    for(const tr of d.querySelectorAll('tr')){
      const ok=!darkOff&&(code.checked||tr.dataset.kind!=='code')&&(!term||tr.textContent.toLowerCase().includes(term)||d.querySelector('.n').textContent.toLowerCase().includes(term));
      tr.classList.toggle('hidden',!ok);if(ok)shown++;
    }
    d.classList.toggle('hidden',shown===0);
    d.querySelector('.c').textContent=shown;
    if(term)d.open=shown>0;
  }
}
q.addEventListener('input',apply);code.addEventListener('change',apply);dark.addEventListener('change',apply);
document.getElementById('open').onclick=()=>surfaces.forEach(d=>{if(!d.classList.contains('hidden'))d.open=true});
document.getElementById('shut').onclick=()=>surfaces.forEach(d=>d.open=false);
</script>
`;
}

// --- run ----------------------------------------------------------------------

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const target = process.argv.slice(2).find((a) => !a.startsWith("--"));
  const out = resolve(target ?? join(homedir(), "allhaus-copy-catalogue.html"));
  const entries = extractAll();
  writeFileSync(
    out,
    out.endsWith(".json")
      ? JSON.stringify(entries, null, 1)
      : process.argv.includes("--fragment")
        ? renderPage(entries, new Date().toISOString().slice(0, 16).replace("T", " "))
        : standalone(renderPage(entries, new Date().toISOString().slice(0, 16).replace("T", " "))),
  );
  console.log(`${entries.length} strings → ${out}`);
}
