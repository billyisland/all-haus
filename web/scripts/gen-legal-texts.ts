/**
 * Generate web/src/content/legal/generated.ts from the markdown beside it.
 *
 * WHY A GENERATED MODULE AND NOT A READ AT RENDER TIME. `web/Dockerfile`'s
 * runtime stage copies `.next`, `node_modules` and `public` — and NOT `src`.
 * A page that read its own markdown with `fs` would work locally, work in
 * `next build`, and 500 in production the first time Next chose to render it
 * dynamically. Committing the rendered HTML removes the question: the pages
 * import a module like any other, and nothing reads the filesystem at all.
 *
 * WHAT IS THE ONE HOME. The `.md` files are. They are the text a person edits;
 * this script is how that text reaches a page, and `generated.ts` is never
 * hand-edited (the same standing as `schema.sql` and
 * `discovery-catalog.generated.ts`). `web/tests/legal-text.test.ts` re-runs the
 * whole conversion in memory and fails if the committed output differs, so a
 * forgotten regeneration is a red test rather than a stale page — which the
 * network-fetching generators in this repo cannot do and this one can, being a
 * pure function of two committed files.
 *
 * THE MARKDOWN IS OURS, WHICH IS WHY THE PIPELINE IS NARROW. `web/src/lib/
 * markdown.ts` renders NIP-23 bodies from strangers: it detects embeddable
 * URLs, wraps images in figures and sends every off-site link to a new tab.
 * All three are wrong for a legal document — an oEmbed wrapper inside a set of
 * terms, or a clause silently gaining target="_blank", is the renderer having
 * an opinion about text that has to say exactly what it says. So: parse,
 * convert, sanitise, stringify, and nothing else. The sanitiser stays because
 * a gate you remove for trusted input is a gate that is missing the day the
 * input stops being trusted.
 *
 * Run: npm run gen:legal   (from web/; `unified` is a web dependency,
 * which is why the script lives here and not in the repo-root scripts/ dir)
 */

import { readFileSync, writeFileSync, readdirSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

import { unified } from "unified";
import remarkParse from "remark-parse";
import remarkRehype from "remark-rehype";
import rehypeSanitize from "rehype-sanitize";
import rehypeStringify from "rehype-stringify";

const HERE = dirname(fileURLToPath(import.meta.url));
export const LEGAL_DIR = join(HERE, "..", "src", "content", "legal");
export const OUTPUT = join(LEGAL_DIR, "generated.ts");

export interface LegalDoc {
  slug: string;
  title: string;
  version: string;
  html: string;
}

/**
 * The frontmatter block, hand-parsed.
 *
 * Three keys, all required, all plain strings — a dependency for that would be
 * a dependency to keep. A missing or malformed block THROWS: this runs at
 * generation time, where a loud failure costs a re-run, and the alternative is
 * a page that renders a document with no version, which is a document nobody
 * can be shown to have accepted.
 */
export function parseFrontmatter(src: string, file: string): {
  meta: Record<string, string>;
  body: string;
} {
  const match = /^---\n([\s\S]*?)\n---\n/.exec(src);
  if (!match) throw new Error(`${file}: no frontmatter block`);
  const meta: Record<string, string> = {};
  for (const line of match[1].split("\n")) {
    const at = line.indexOf(":");
    if (at === -1) throw new Error(`${file}: malformed frontmatter line: ${line}`);
    meta[line.slice(0, at).trim()] = line.slice(at + 1).trim();
  }
  for (const key of ["slug", "title", "version"]) {
    if (!meta[key]) throw new Error(`${file}: frontmatter is missing "${key}"`);
  }
  return { meta, body: src.slice(match[0].length) };
}

const processor = unified()
  .use(remarkParse)
  .use(remarkRehype, { allowDangerousHtml: false })
  .use(rehypeSanitize)
  .use(rehypeStringify);

export async function renderLegal(markdown: string): Promise<string> {
  const html = String(await processor.process(markdown));
  // `---` in the markdown becomes `<hr>`, which is a 1px line by browser
  // default and which the house does not have — scripts/check-hairlines.sh
  // refuses the raw element for exactly that reason. It becomes the register's
  // 4px slab instead.
  //
  // NOT `.slab-rule-4`: that draws in `var(--ah-ink)`, and these pages render
  // inside a PublicVessel, which is islanded — an un-islanded ink token
  // inverts a second time there and the rule disappears against a dark ground.
  // `.ah-legal-rule` takes the vessel's own wall colour (globals.css §1a-ter),
  // the same pairing the register's `controlLine` rule is about.
  //
  // A string replace, and safely: this runs AFTER the sanitiser, so an `<hr>`
  // in the output carries no attributes of its own — there is nothing for a
  // regex over HTML to get wrong here, and the alternative (a tree plugin plus
  // a widened schema to let the replacement's class survive) is more moving
  // parts guarding less.
  return html.replace(/<hr\s*\/?>/g, '<div class="ah-legal-rule"></div>');
}

/** Every `*.md` in the legal directory, rendered, sorted by slug. */
export async function buildDocs(): Promise<LegalDoc[]> {
  const files = readdirSync(LEGAL_DIR)
    .filter((f) => f.endsWith(".md"))
    .sort();
  const docs: LegalDoc[] = [];
  for (const file of files) {
    const src = readFileSync(join(LEGAL_DIR, file), "utf8");
    const { meta, body } = parseFrontmatter(src, file);
    docs.push({
      slug: meta.slug,
      title: meta.title,
      version: meta.version,
      html: await renderLegal(body),
    });
  }
  return docs.sort((a, b) => a.slug.localeCompare(b.slug));
}

export function renderModule(docs: LegalDoc[]): string {
  return `// GENERATED by scripts/gen-legal-texts.ts from the .md files beside
// this one. Do not hand-edit: web/tests/legal-text.test.ts re-runs the
// conversion and fails on any difference. Edit the markdown, then run
//   cd web && npm run gen:legal
export interface LegalDoc {
  slug: string
  title: string
  version: string
  html: string
}

export const LEGAL_DOCS: readonly LegalDoc[] = ${JSON.stringify(docs, null, 2)} as const
`;
}

async function main() {
  const docs = await buildDocs();
  writeFileSync(OUTPUT, renderModule(docs), "utf8");
  for (const d of docs) {
    console.log(`  ${d.slug} v${d.version} — ${d.html.length} chars of HTML`);
  }
  console.log(`Wrote ${OUTPUT}`);
}

// Only when run directly — the test imports the helpers above.
if (process.argv[1] && process.argv[1].endsWith("gen-legal-texts.ts")) {
  main().catch((err) => {
    console.error(err);
    process.exit(1);
  });
}
