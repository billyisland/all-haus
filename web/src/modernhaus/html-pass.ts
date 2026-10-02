import { unified } from 'unified'
import rehypeParse from 'rehype-parse'
import rehypeStringify from 'rehype-stringify'
import type { Root, Element, Parent, Text } from 'hast'
import { safeHttpUrl } from '../lib/external-links'

// =============================================================================
// modernhaus — the ornament pass over TRUSTED HTML (MODERNHAUS-ADR §D2.7.1).
//
// modernhaus places some HTML raw: an article's `renderMarkdown` output, a
// post's stored `body.html` (sanitised at ingest), an extracted article (sanitised
// by the gateway), the generated legal texts. Each is already SAFE — this pass is
// not a sanitiser and must never be treated as one. It removes ORNAMENT, which
// those producers were built to emit for the full site:
//
//   - an `<iframe>` becomes a link to its `src`. `renderMarkdown` wraps provider
//     embeds in iframes, and the ingest sanitiser allows iframes from listed
//     hosts; modernhaus's CSP has no `frame-src`, deliberately (§D1.5), so an
//     iframe would render as nothing. The link goes through `safeHttpUrl`, and a
//     src that fails it leaves no link at all.
//   - `style` and `class` go, everywhere. With no stylesheet, `class` means
//     nothing, and `style` is the design this register removes.
//
// Everything else — including `target`/`rel` on outbound anchors, which
// `externalizeHtml` adds — passes through untouched.
// =============================================================================

const processor = unified()
  .use(rehypeParse, { fragment: true })
  .use(rehypeStringify)

function embedLink(src: string | undefined): Element | null {
  const href = safeHttpUrl(src)
  if (!href) return null
  const text: Text = { type: 'text', value: href }
  // A bare anchor, not a paragraph: an iframe can sit inside a `<p>`, and a
  // paragraph inside a paragraph is split apart by every HTML parser.
  return {
    type: 'element',
    tagName: 'a',
    properties: { href, target: '_blank', rel: ['noopener', 'noreferrer'] },
    children: [text],
  }
}

function walk(node: Parent): void {
  const next: Parent['children'] = []
  for (const child of node.children) {
    if (child.type === 'element') {
      if (child.tagName === 'iframe') {
        const src = child.properties?.src
        const link = embedLink(typeof src === 'string' ? src : undefined)
        if (link) next.push(link)
        continue
      }
      if (child.properties) {
        delete child.properties.style
        delete child.properties.className
      }
      walk(child)
    }
    next.push(child)
  }
  node.children = next as typeof node.children
}

/** Trusted HTML with its ornament removed. Never a sanitiser. */
export function stripOrnament(html: string): string {
  if (!html) return ''
  const tree = processor.parse(html) as Root
  walk(tree)
  return processor.stringify(tree)
}
