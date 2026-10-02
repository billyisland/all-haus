// @vitest-environment jsdom
import { describe, it, expect } from 'vitest'
import { Editor } from '@tiptap/core'
import { markdownExtensions } from '../src/components/editor/extensions'
import { PAYWALL_GATE_MARKER } from '../src/components/editor/PaywallGateNode'

// =============================================================================
// The two editor nodes that survive a markdown ROUND TRIP — and until
// 2026-09-09 neither did.
//
// Both are stored in the body as markdown (`<!-- paywall-gate -->` for the
// gate, a bare URL on its own line for an embed) and both have to come back as
// nodes when that markdown is handed to a fresh editor: reopening a draft,
// editing a published article, the note→article seed. Both had a core ruler
// rule that produced a token, and NEITHER had a renderer rule for it — and
// tiptap-markdown does not hand the editor the token stream, it calls
// `md.render()` and DOM-parses the HTML. A token with no renderer rule falls to
// markdown-it's `renderToken`, which builds the tag from `token.tag`, empty on
// both. So both rendered as `<>`, `parseHTML` matched nothing, and:
//
//   · the GATE was lost, `hasGateMarker()` went false, and Edit → Update
//     republished a paywalled article as free at price 0 (fired once on prod,
//     2026-07-10 — MIRROR-AUDIT-2026-09-08 §1.1);
//   · the EMBED was DELETED, because its rule splices the paragraph away, so
//     the URL went with it (§1.3).
//
// THIS TEST HAS TO RUN THROUGH THE EDITOR, not through markdown-it. A
// token-layer assertion cannot see the renderer half at all — that is exactly
// how the D334 fix (2026-05-16) shipped a parse rule with nothing to render it
// and nobody noticed for four months.
//
// MUTATION RUN (2026-09-09), each reverted alone:
//   · drop `renderer.rules.paywall_gate`       → 2 fail (both gate round trips)
//   · drop the paragraph arm of the gate ruler → 2 fail (the same two)
//   · `attrs = { src }` instead of pairs       → 2 fail (both embed cases)
//   · drop `renderer.rules.embed`              → 1 fail (the node is not built;
//     the URL still survives, because with attrs as PAIRS `renderToken` emits
//     `< src="…">` and the text carries it. Reverting BOTH halves is what
//     deletes it — measured `<>` — so the two mutations are only honest read
//     together, and the destructive case is the pair.)
// The controls (fenced marker, inline marker, non-embeddable URL) stay green
// throughout, which is what says the rules are narrow.
//
// The extension set is `markdownExtensions()` — the SHIPPED one, minus the four
// that take no part in markdown (Image/ImageUpload/Placeholder/CharacterCount).
// It used to be hand-copied here, so an extension registered in the editor and
// not in this list was covered by nothing; both sides now call the one home.
// `Markdown.configure({ html: false })` lives in there, matches ArticleEditor,
// and is load-bearing: `html: true` is NOT the fix — see §1.1.
//
// MUTATION RUN (2026-09-11), for the link mark added in the same commit — each
// reverted alone, and each caught by exactly one case:
//   · `autolink: true`                    → 1 fail (the TYPED bare URL)
//   · drop the `addPasteRules` narrowing  → 1 fail (the PASTED bare URL)
//   · drop the markdown link input rule   → 1 fail (the typed link)
//   · `isAllowedLinkHref` → always true   → 1 fail (the two `javascript:` gates)
//
// THE EMBED ROUND TRIPS ABOVE STAY GREEN UNDER `autolink: true` — measured.
// The execution plan proposed them as the proof of D1 and they are not: they
// feed MARKDOWN in, and autolink is an `appendTransaction` over document
// changes, so it never runs on a parse. The two D1 controls in the link block
// drive the gestures (typing, pasting) and are what actually pin the decision.
// Same rule as always: a passing test proves nothing until you mutate it —
// including a passing test somebody else nominated.
// =============================================================================

function editorFor(markdown: string): Editor {
  return new Editor({
    extensions: markdownExtensions(),
    content: markdown,
  })
}

function nodesNamed(editor: Editor, name: string) {
  const found: { attrs: Record<string, any> }[] = []
  editor.state.doc.descendants((node) => {
    if (node.type.name === name) found.push({ attrs: node.attrs })
  })
  return found
}

function markdownOf(editor: Editor): string {
  return (editor.storage as any).markdown.getMarkdown()
}

describe('paywall gate — markdown round trip', () => {
  it('parses the marker back into a gate node', () => {
    const editor = editorFor(`Free\n\n${PAYWALL_GATE_MARKER}\n\nPaid`)
    expect(nodesNamed(editor, 'paywallGate')).toHaveLength(1)
    // And it is a gate, not a paragraph carrying the marker as text — the
    // escaped `&lt;!-- paywall-gate --&gt;` is the fingerprint the prod sweep
    // found in the one flattened article.
    expect(editor.getText()).not.toContain('paywall-gate')
    editor.destroy()
  })

  it('re-serialises the gate as the marker, so the next save keeps it', () => {
    const editor = editorFor(`Free\n\n${PAYWALL_GATE_MARKER}\n\nPaid`)
    const out = markdownOf(editor)
    expect(out).toContain(PAYWALL_GATE_MARKER)
    expect(out).not.toContain('&lt;!--')
    // Feeding it back gives a gate again: the fixed point is the point.
    const second = editorFor(out)
    expect(nodesNamed(second, 'paywallGate')).toHaveLength(1)
    editor.destroy()
    second.destroy()
  })

  it('leaves the marker alone inside a fenced block', () => {
    const editor = editorFor(
      '```\n' + PAYWALL_GATE_MARKER + '\n```\n\nAfter',
    )
    expect(nodesNamed(editor, 'paywallGate')).toHaveLength(0)
    editor.destroy()
  })

  it('leaves the marker alone when it shares a line with prose', () => {
    const editor = editorFor(`before ${PAYWALL_GATE_MARKER} after`)
    expect(nodesNamed(editor, 'paywallGate')).toHaveLength(0)
    editor.destroy()
  })
})

describe('embed — markdown round trip', () => {
  const URL = 'https://www.youtube.com/watch?v=dQw4w9WgXcQ'

  it('parses a bare embeddable URL back into an embed node carrying its src', () => {
    const editor = editorFor(`Hi\n\n${URL}\n\nBye`)
    const embeds = nodesNamed(editor, 'embed')
    expect(embeds).toHaveLength(1)
    expect(embeds[0].attrs.src).toBe(URL)
    editor.destroy()
  })

  it('does not lose the URL on the way back out', () => {
    const editor = editorFor(`Hi\n\n${URL}\n\nBye`)
    const out = markdownOf(editor)
    expect(out).toContain(URL)
    expect(out).toContain('Hi')
    expect(out).toContain('Bye')
    editor.destroy()
  })

  it('leaves a non-embeddable URL as an ordinary paragraph', () => {
    const editor = editorFor('Hi\n\nhttps://example.com/not-a-video\n\nBye')
    expect(nodesNamed(editor, 'embed')).toHaveLength(0)
    expect(markdownOf(editor)).toContain('https://example.com/not-a-video')
    editor.destroy()
  })
})

// -----------------------------------------------------------------------------
// LINKS. Until 2026-09-11 `@tiptap/extension-link` was not installed, so the
// schema carried no link mark at all: typing `[text](url)` left literal
// brackets that the serialiser then ESCAPED (`\[text\](url)`, published as
// visible syntax), and pasting HTML kept the text while SILENTLY dropping the
// href. The second is content loss the writer is told nothing about.
//
// The defect is in what SERIALISES, so every case here reads the markdown back
// out. A DOM assertion alone passed against the paste bug while the href was
// already gone.
// -----------------------------------------------------------------------------

// jsdom ships no `ClipboardEvent`, and `view.pasteHTML` constructs one. The
// minimum that satisfies it — the paste path reads the HTML string it was
// handed, not the event.
if (typeof (globalThis as any).ClipboardEvent === 'undefined') {
  ;(globalThis as any).ClipboardEvent = class extends Event {
    clipboardData = null
  }
}

/** Drive real typing, so the input rules actually run. */
function typeText(editor: Editor, text: string) {
  const { view } = editor
  for (const ch of text) {
    const { from, to } = view.state.selection
    const insert = () => view.state.tr.insertText(ch, from, to)
    const handled = view.someProp('handleTextInput', (f) =>
      f(view, from, to, ch, insert),
    )
    if (!handled) view.dispatch(insert())
  }
}

function linkHrefs(editor: Editor): string[] {
  const hrefs: string[] = []
  editor.state.doc.descendants((node) => {
    node.marks.forEach((mark) => {
      if (mark.type.name === 'link') hrefs.push(mark.attrs.href)
    })
  })
  return hrefs
}

describe('link — markdown round trip', () => {
  it('parses a markdown link into a link mark, not literal brackets', () => {
    const editor = editorFor('See [the guardian](https://theguardian.com) here')
    expect(linkHrefs(editor)).toEqual(['https://theguardian.com'])
    expect(editor.getText()).toBe('See the guardian here')
    editor.destroy()
  })

  it('re-serialises UNESCAPED, so the next autosave keeps the link', () => {
    const editor = editorFor('See [the guardian](https://theguardian.com) here')
    const out = markdownOf(editor)
    expect(out).toContain('[the guardian](https://theguardian.com)')
    // The fingerprint of the bug: the draft came back `\[the guardian\](…)`.
    expect(out).not.toContain('\\[')
    const second = editorFor(out)
    expect(linkHrefs(second)).toEqual(['https://theguardian.com'])
    editor.destroy()
    second.destroy()
  })

  it('keeps the href when HTML carrying a link is PASTED', () => {
    const editor = editorFor('')
    editor.view.pasteHTML('<p>See <a href="https://theguardian.com">the guardian</a> here</p>')
    expect(linkHrefs(editor)).toEqual(['https://theguardian.com'])
    expect(markdownOf(editor)).toContain('[the guardian](https://theguardian.com)')
    editor.destroy()
  })

  it('resolves `[text](url)` as it is TYPED', () => {
    const editor = editorFor('')
    editor.commands.focus()
    typeText(editor, 'See [the guardian](https://theguardian.com)')
    expect(linkHrefs(editor)).toEqual(['https://theguardian.com'])
    // And the mark does not run on into whatever is typed next.
    typeText(editor, ' here')
    expect(editor.getText()).toBe('See the guardian here')
    expect(linkHrefs(editor)).toEqual(['https://theguardian.com'])
    editor.destroy()
  })

  it('keeps a nostr: link — the renderer allows it, so the editor must', () => {
    const editor = editorFor('[that note](nostr:note1abcdef)')
    expect(linkHrefs(editor)).toEqual(['nostr:note1abcdef'])
    expect(markdownOf(editor)).toContain('(nostr:note1abcdef)')
    editor.destroy()
  })

  it('refuses a scheme the renderer would strip, typed or pasted', () => {
    // Both gates, because markdown is NOT one of them: markdown-it's own
    // `validateLink` refuses `javascript:` before our schema ever sees it, so
    // a case fed as markdown stays green with the protocol check deleted —
    // measured. What reaches `isAllowedLinkHref` is the input rule and
    // `parseHTML`, and those are the two below.
    const typed = editorFor('')
    typed.commands.focus()
    // eslint-disable-next-line no-script-url
    typeText(typed, '[tap me](javascript:alert(1))')
    expect(linkHrefs(typed)).toEqual([])
    typed.destroy()

    const pasted = editorFor('')
    // eslint-disable-next-line no-script-url
    pasted.view.pasteHTML('<p>See <a href="javascript:alert(1)">tap me</a></p>')
    expect(linkHrefs(pasted)).toEqual([])
    expect(markdownOf(pasted)).toContain('tap me')
    pasted.destroy()
  })

  it('does not linkify an embeddable URL inside a PASTE (D1, the other half)', () => {
    // Upstream's paste rule linkifies every URL in pasted text. A single-line
    // bare-URL paste is claimed by `EmbedNode`'s own handler first, but a
    // multi-line paste falls through to the rule — and an embed IS a bare URL
    // on its own line, so linkifying one costs the writer the embed silently.
    const editor = editorFor('')
    editor.view.pasteHTML(
      '<p>Watch this</p><p>https://www.youtube.com/watch?v=dQw4w9WgXcQ</p>',
    )
    expect(linkHrefs(editor)).toEqual([])
    const out = markdownOf(editor)
    expect(out).toContain('https://www.youtube.com/watch?v=dQw4w9WgXcQ')
    expect(nodesNamed(editorFor(out), 'embed')).toHaveLength(1)
    editor.destroy()
  })

  it('leaves a TYPED bare URL alone, so the embed convention survives (D1)', () => {
    // The one control that says `autolink: false` is load-bearing rather than
    // incidental: an embed IS a bare URL on its own line, re-formed on reload.
    // Autolinked, it serialises as `[url](url)` and the ruler never matches.
    const editor = editorFor('')
    editor.commands.focus()
    typeText(editor, 'https://www.youtube.com/watch?v=dQw4w9WgXcQ ')
    expect(linkHrefs(editor)).toEqual([])
    const out = markdownOf(editor)
    expect(out).toContain('https://www.youtube.com/watch?v=dQw4w9WgXcQ')
    expect(out).not.toContain('](')
    expect(nodesNamed(editorFor(out), 'embed')).toHaveLength(1)
    editor.destroy()
  })
})

describe('image — markdown round trip', () => {
  // WHY THIS BLOCK EXISTS. Until 2026-09-12 the image was on the other side of
  // `markdownExtensions()`, on the stated grounds that it "takes no part in
  // markdown" — so nothing here covered it, and it was serialising through
  // prosemirror-markdown's INLINE `image` spec, which writes the link and never
  // closes the block. Everything after a picture was welded onto its line, and
  // for a heading or a list that is not a spacing defect, it is DELETION: `##`
  // mid-line is literal text.

  it('closes the block, so the next paragraph is still a paragraph', () => {
    const md = markdownOf(editorFor('Before.\n\n![pic](https://a.haus/x.webp)\n\nAfter.'))
    expect(md).toBe('Before.\n\n![pic](https://a.haus/x.webp)\n\nAfter.')
  })

  it('keeps a heading under a picture a heading', () => {
    // The destructive case. Asserting the markdown alone would pass against a
    // single `\n` too, so re-parse and read the DOCUMENT: a welded heading
    // comes back as paragraph text, and that is what is actually lost.
    const md = markdownOf(editorFor('![pic](https://a.haus/x.webp)\n\n## A heading\n\nAfter.'))
    const reparsed = editorFor(md)
    const headings = nodesNamed(reparsed, 'heading')
    expect(headings).toHaveLength(1)
    expect(reparsed.state.doc.textContent).toContain('A heading')
  })

  it('keeps a list under a picture a list', () => {
    const md = markdownOf(editorFor('![pic](https://a.haus/x.webp)\n\n- one\n- two'))
    expect(nodesNamed(editorFor(md), 'listItem')).toHaveLength(2)
  })

  it('separates two pictures in a row', () => {
    const md = markdownOf(editorFor('![one](https://a.haus/x.webp)\n\n![two](https://a.haus/y.webp)'))
    expect(nodesNamed(editorFor(md), 'image')).toHaveLength(2)
    expect(md).not.toMatch(/\)!\[/)
  })

  it('closes the block THROUGH the delimiter stack, so a picture in a list keeps the list', () => {
    // `state.closeBlock(node)` rather than the `"\n\n"` its two neighbours in
    // this file write: inside a list item a raw newline skips the item's own
    // indent prefix and ends the list early. The control is that the second
    // item survives.
    const md = markdownOf(editorFor('- item\n\n  ![pic](https://a.haus/x.webp)\n\n- next'))
    const reparsed = editorFor(md)
    expect(nodesNamed(reparsed, 'listItem')).toHaveLength(2)
    expect(nodesNamed(reparsed, 'image')).toHaveLength(1)
  })

  it('round trips a CAPTION as the image title', () => {
    // The carrier for a native caption: plain CommonMark, already an attribute
    // of the node, and the reason the feature needed no new syntax. A caption
    // that does not survive reopening a draft is worse than no caption.
    const md = '![A lime bike](https://a.haus/x.webp "Photograph: S Shepheard/Alamy")'
    const nodes = nodesNamed(editorFor(md), 'image')
    expect(nodes).toHaveLength(1)
    expect(nodes[0].attrs.title).toBe('Photograph: S Shepheard/Alamy')
    expect(nodes[0].attrs.alt).toBe('A lime bike')
    expect(markdownOf(editorFor(md))).toBe(md)
  })

  it('survives a caption that ends in a backslash, and one carrying an escaped quote', () => {
    // The title's escape has to cover `\\` as well as `"`. A trailing
    // backslash otherwise escapes the closing quote, markdown-it (the
    // editor's own reload parser) stops seeing an image, and the next draft
    // open shows a literal paragraph where the picture was — content loss
    // with nothing said. Drive it through the editor twice: the serialiser
    // writes it, the parser has to read it back as an image.
    for (const caption of ['Saved under C:\\photos\\', 'She said \"go\" — obviously', 'a\\"b']) {
      const editor = editorFor('![alt](https://a.haus/x.webp)')
      const image = nodesNamed(editor, 'image')[0]
      editor.commands.updateAttributes('image', { title: caption })
      expect(image).toBeTruthy()
      const md = markdownOf(editor)
      const reparsed = nodesNamed(editorFor(md), 'image')
      expect(reparsed).toHaveLength(1)
      expect(reparsed[0].attrs.title).toBe(caption)
    }
  })

  it('keeps alt and caption apart', () => {
    // Alt describes the picture to somebody who cannot see it; a caption is
    // read by everybody. Filling either from the other is an accessibility
    // regression wearing a convenience.
    const nodes = nodesNamed(editorFor('![](https://a.haus/x.webp "Only a caption")'), 'image')
    expect(nodes[0].attrs.title).toBe('Only a caption')
    expect(nodes[0].attrs.alt ?? '').toBe('')
    const other = nodesNamed(editorFor('![Only alt](https://a.haus/x.webp)'), 'image')
    expect(other[0].attrs.alt).toBe('Only alt')
    expect(other[0].attrs.title ?? null).toBeNull()
  })

  it('is idempotent — a second pass changes nothing', () => {
    for (const md of [
      'Before.\n\n![pic](https://a.haus/x.webp)\n\nAfter.',
      '![pic](https://a.haus/x.webp "cap")\n\n## Head\n\n- one\n- two',
    ]) {
      const once = markdownOf(editorFor(md))
      expect(markdownOf(editorFor(once))).toBe(once)
    }
  })
})
