import { describe, it, expect } from 'vitest'
import { readdirSync, readFileSync, statSync } from 'node:fs'
import { join } from 'node:path'

// An "are you sure?" is the house ConfirmDialog, never the browser's
// (.claude/rules/web-overlays.md; walkthrough A12, W5). Comment lines are
// skipped — ConfirmDialog's own header names what it replaced.
const SRC = join(__dirname, '../src')

function walk(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const p = join(dir, name)
    if (statSync(p).isDirectory()) return walk(p)
    return /\.(ts|tsx)$/.test(name) && !/\.test\.tsx?$/.test(name) ? [p] : []
  })
}

describe('no window.confirm', () => {
  const files = walk(SRC)

  it('scanned the tree', () => {
    expect(files.length).toBeGreaterThan(100)
    // And the replacement is really in use, or "none left" is vacuous.
    const uses = files.filter((f) => readFileSync(f, 'utf8').includes('useConfirm()'))
    expect(uses.length).toBeGreaterThanOrEqual(10)
  })

  it('no call to confirm() survives', () => {
    const hits: string[] = []
    for (const f of files) {
      readFileSync(f, 'utf8').split('\n').forEach((line, i) => {
        const t = line.trim()
        if (t.startsWith('//') || t.startsWith('*') || t.startsWith('/*')) return
        if (/(^|[^\w.])confirm\(|window\.confirm\(/.test(line)) hits.push(`${f}:${i + 1}`)
      })
    }
    expect(hits).toEqual([])
  })
})
