// @vitest-environment jsdom
import { describe, it, expect } from 'vitest'
import { Editor } from '@tiptap/core'
import { markdownExtensions } from '../src/components/editor/extensions'

// =============================================================================
// The image node VIEW — what a writer actually sees and types into.
//
// The round-trip suite next door drives the document model and never renders,
// so it is green against a node view that draws nothing at all: the first
// version of this one built a <figure>, built an <img> and a <figcaption>, and
// appended NEITHER — an empty box in the editor where the picture should be,
// with every markdown test passing. Same shape as the D334 gate (a parse rule
// with nothing to render it, four months unnoticed): a node's markdown half and
// its DOM half are two features, and each needs its own proof.
//
// The caption is rendered as the REAL <figcaption> the reader will get, so both
// take `.ah-caption-voice` from one home in globals.css — what the writer sees
// is what publishes.
// =============================================================================

function mount(markdown: string) {
  const element = document.createElement('div')
  document.body.appendChild(element)
  const editor = new Editor({ element, extensions: markdownExtensions(), content: markdown })
  return { editor, element }
}

describe('image node view', () => {
  it('draws the picture and its caption', () => {
    const { element } = mount('![A lime bike](https://a.haus/x.webp "Photograph: S Shepheard/Alamy")')
    const figure = element.querySelector('figure.ah-editor-figure')
    expect(figure).not.toBeNull()
    expect(figure!.querySelector('img')?.getAttribute('src')).toBe('https://a.haus/x.webp')
    expect(figure!.querySelector('img')?.getAttribute('alt')).toBe('A lime bike')
    expect(figure!.querySelector('figcaption')?.textContent).toBe('Photograph: S Shepheard/Alamy')
  })

  it('marks an UNCAPTIONED picture so the empty field stays out of the way', () => {
    // The field is chrome until it has something to say; the pane's whole rule
    // is that the chrome recedes while you write. CSS hides it on this flag, so
    // the flag is what the test can see.
    const { element } = mount('![Just a picture](https://a.haus/x.webp)')
    const figure = element.querySelector('figure.ah-editor-figure')!
    expect(figure.getAttribute('data-has-caption')).toBe('false')
    expect(figure.querySelector('figcaption')?.textContent).toBe('')
  })

  it('a caption typed into the field becomes the document`s own title attribute', () => {
    // The field is contenteditable and NOT part of the document, so nothing
    // reaches the model unless the node view puts it there. Assert the MODEL,
    // never the element: the element shows what was typed either way.
    const { editor, element } = mount('![pic](https://a.haus/x.webp)')
    const caption = element.querySelector('figcaption')!
    caption.textContent = 'Typed by the writer'
    caption.dispatchEvent(new Event('input', { bubbles: true }))

    let title: string | null = null
    editor.state.doc.descendants((node) => { if (node.type.name === 'image') title = node.attrs.title })
    expect(title).toBe('Typed by the writer')
    // And it survives all the way out to the markdown the publish path sends.
    expect((editor.storage as any).markdown.getMarkdown()).toContain('"Typed by the writer"')
  })

  it('clears the attribute to NULL when the caption is emptied', () => {
    // `""` and "no caption" must not be two states. The markdown cannot tell
    // them apart — the serialiser treats an empty title as absent — so this
    // asserts the MODEL, which is what every other reader of the attribute sees
    // (the node view's own `data-has-caption`, and the archive importer next).
    // Asserting the markdown alone passes against `attrs.title = ""`, measured.
    const { editor, element } = mount('![pic](https://a.haus/x.webp "Remove me")')
    const caption = element.querySelector('figcaption')!
    caption.textContent = '   '
    caption.dispatchEvent(new Event('input', { bubbles: true }))

    let title: unknown = 'unset'
    editor.state.doc.descendants((node) => { if (node.type.name === 'image') title = node.attrs.title })
    expect(title).toBeNull()
    expect((editor.storage as any).markdown.getMarkdown()).toBe('![pic](https://a.haus/x.webp)')
  })
})
