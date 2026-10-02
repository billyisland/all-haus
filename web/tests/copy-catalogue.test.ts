import { describe, it, expect } from 'vitest'
import path from 'node:path'
import { extractAll, extractFile, readsAsWords, surfaceOf, renderPage, SRC } from '../scripts/copy-catalogue'

// =============================================================================
// The copy catalogue (copy tier 3) is a REVIEW tool: it reads the interface's
// words in place and nothing in the app depends on it. What can go wrong is
// quiet — a parse that finds nothing, or a pass that stops seeing one kind of
// copy — and a review page that is silently missing half the site reads as a
// clean one. So the passes are pinned on a synthetic file, where every kind of
// copy and every kind of non-copy sits side by side, and the real tree is held
// to a floor.
// =============================================================================

const FIXTURE = `
"use client"
import { thing } from "@/lib/thing"
import Copy from "./copy"

const LABELS = { "cancel-key": "Cancel" }

export function Panel({ busy, n, name }: { busy: boolean; n: number; name: string }) {
  const [error, setError] = useState<string | null>(null)
  if (kind === "draft mode") return null
  console.log("Debug output that is not copy")
  const cls = cn("btn-text text-ui-xs", busy && "opacity-50")
  async function save() {
    try { await put("/api/feeds") } catch { setError("That didn't save. Try again.") }
  }
  return (
    <div className="flex items-center gap-2" style={{ transition: "opacity 120ms ease-out" }}>
      <h2>Your feeds</h2>
      <p>You&rsquo;ve read it &mdash; twice</p>
      <input placeholder="Name this feed…" aria-label="Feed name" type="text" />
      <button title={busy ? "Saving…" : "Save the feed"} onClick={save}>
        {busy ? "Saving…" : "Save"}
      </button>
      <p>{\`\${n} sources serve this feed\`}</p>
      <img alt="" src="/x.png" />
      <Row variant="primary" detail="Shown to readers once" />
    </div>
  )
}
`

describe('the extractor', () => {
  const abs = path.join(SRC, 'components', 'demo', 'Panel.tsx')
  const got = extractFile(abs, FIXTURE)
  const texts = got.map((e) => e.text)

  it('reads JSX text, copy attributes, expressions, templates and stray sentences', () => {
    expect(got).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ kind: 'text', text: 'Your feeds' }),
        expect.objectContaining({ kind: 'text', text: 'You’ve read it — twice' }),
        expect.objectContaining({ kind: 'attr', where: 'placeholder', text: 'Name this feed…' }),
        expect.objectContaining({ kind: 'attr', where: 'aria-label', text: 'Feed name' }),
        expect.objectContaining({ kind: 'expr', where: 'title', text: 'Save the feed' }),
        expect.objectContaining({ kind: 'expr', text: 'Save' }),
        expect.objectContaining({ kind: 'expr', text: '{n} sources serve this feed' }),
        expect.objectContaining({ kind: 'attr', where: 'detail', text: 'Shown to readers once' }),
        expect.objectContaining({ kind: 'code', where: 'setError', text: "That didn't save. Try again." }),
      ]),
    )
    // Both arms of a conditional, each once — a literal is claimed by the JSX
    // pass and never counted again by the code pass.
    expect(texts.filter((t) => t === 'Saving…')).toHaveLength(2)
  })

  it('leaves out what is not copy', () => {
    for (const notCopy of [
      'use client', '@/lib/thing', './copy', 'cancel-key', 'draft mode',
      'Debug output that is not copy', 'btn-text text-ui-xs', 'opacity-50',
      '/api/feeds', 'flex items-center gap-2', 'opacity 120ms ease-out', 'text',
      '/x.png', 'primary',
    ]) {
      expect(texts, notCopy).not.toContain(notCopy)
    }
  })

  it('reads every string of a copy module, sentence or not', () => {
    const mod = extractFile(
      path.join(SRC, 'content', 'demo.ts'),
      'export const FEED_MERGE_FAILED = "Merge failed."\nexport const LABEL = "Feeds"\nexport const KEY = "feed-merge"',
    )
    expect(mod.map((e) => [e.kind, e.text])).toEqual([
      ['module', 'Merge failed.'],
      ['module', 'Feeds'],
    ])
  })

  it('tells words from identifiers, paths, classes and CSS', () => {
    expect(readsAsWords('Something went wrong')).toBe(true)
    expect(readsAsWords('{who} is already active')).toBe(true)
    expect(readsAsWords('btn-soft py-1.5 px-4{hovering}')).toBe(false)
    expect(readsAsWords('translateX(calc({x}% + 2px))')).toBe(false)
    expect(readsAsWords('https://all.haus/about us')).toBe(false)
    expect(readsAsWords('single')).toBe(false)
  })
})

describe('the surfaces', () => {
  it('groups a page by its route, a component by its directory', () => {
    expect(surfaceOf('app/settings/page.tsx')).toEqual({ register: 'Pages', name: '/settings' })
    expect(surfaceOf('app/page.tsx')).toEqual({ register: 'Pages', name: '/' })
    expect(surfaceOf('components/post/PostCard.tsx')).toEqual({ register: 'Components', name: 'components/post' })
    expect(surfaceOf('content/paywall.ts')).toEqual({ register: 'Copy modules', name: 'content/paywall' })
    expect(surfaceOf('app/modernhaus/[...path]/route.tsx').register).toBe('modernhaus')
  })
})

describe('the real tree', () => {
  const all = extractAll()

  it('finds the tree it is meant to be scanning, every kind of copy in it', () => {
    // ~3,700 at 2026-10-01. A floor, not a pin: copy comes and goes.
    expect(all.length).toBeGreaterThan(2500)
    for (const kind of ['text', 'attr', 'expr', 'module', 'code'] as const) {
      expect(all.filter((e) => e.kind === kind).length, kind).toBeGreaterThan(100)
    }
  })

  it('skips the tests and the published legal texts', () => {
    expect(all.some((e) => /\.test\.tsx?$/.test(e.file))).toBe(false)
    expect(all.some((e) => e.file.startsWith('content/legal/'))).toBe(false)
  })

  it('renders one page with every entry escaped', () => {
    const html = renderPage([{ file: 'x.tsx', line: 1, kind: 'text', text: '<b>&</b>' }], 'now')
    expect(html).toContain('&lt;b&gt;&amp;&lt;/b&gt;')
    expect(html).not.toContain('<b>&</b>')
  })
})
