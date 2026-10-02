import { describe, it, expect } from 'vitest'
import fs from 'fs'
import path from 'path'
import { fileURLToPath } from 'url'
import { blueskyInteractionData } from '../src/lib/atproto-reply-refs.js'

// =============================================================================
// CROSS-NETWORK-ROUNDTRIP-ADR F6/A8 — a Bluesky context row records its
// thread ROOT, or a reply to it goes out naming the wrong one.
// =============================================================================

const reply = {
  root: { uri: 'at://did:plc:carol/app.bsky.feed.post/1', cid: 'c1' },
  parent: { uri: 'at://did:plc:bob/app.bsky.feed.post/2', cid: 'c2' },
}

describe('blueskyInteractionData', () => {
  it('carries the four reply keys off a reply record', () => {
    expect(
      blueskyInteractionData({ uri: 'at://x/app.bsky.feed.post/3', cid: 'c3', record: { reply } }),
    ).toEqual({
      uri: 'at://x/app.bsky.feed.post/3',
      cid: 'c3',
      rootUri: reply.root.uri,
      rootCid: reply.root.cid,
      parentUri: reply.parent.uri,
      parentCid: reply.parent.cid,
    })
  })

  it('OMITS the keys for a top-level post — a null would erase a real row under the jsonb merge', () => {
    const out = blueskyInteractionData({ uri: 'at://x/app.bsky.feed.post/3', cid: 'c3', record: {} })
    expect(out).toEqual({ uri: 'at://x/app.bsky.feed.post/3', cid: 'c3' })
    expect('rootUri' in out).toBe(false)
  })
})

// The class, not the one site the ADR named: every writer that stores a
// Bluesky post's interaction_data from a fetched record goes through the
// helper. A bare `{ uri: post.uri, cid: post.cid }` literal is the pre-A8
// shape — seven sites wrote it — so its reappearance anywhere in the two
// packages that persist context rows fails here.
const here = path.dirname(fileURLToPath(import.meta.url))
const root = path.resolve(here, '../..')

function sources(dir: string): string[] {
  const out: string[] = []
  for (const e of fs.readdirSync(path.join(root, dir), { withFileTypes: true })) {
    const rel = path.join(dir, e.name)
    if (e.isDirectory()) out.push(...sources(rel))
    else if (e.name.endsWith('.ts') && !e.name.endsWith('.test.ts')) out.push(rel)
  }
  return out
}

describe('every Bluesky context writer records the root', () => {
  const files = [...sources('gateway/src'), ...sources('feed-ingest/src')]

  it('finds the trees it guards', () => {
    expect(files.length).toBeGreaterThan(50)
    // …and the helper really is used where the defect was.
    const users = files.filter((f) =>
      fs.readFileSync(path.join(root, f), 'utf8').includes('blueskyInteractionData('),
    )
    expect(users.length).toBeGreaterThanOrEqual(6)
  })

  it('no file builds the bare {uri, cid} pair off a fetched post', () => {
    // The WRITING shapes only — a stringified column value, or a value bound
    // to something named interactionData. A strong ref returned for a record
    // reference (the root resolver's own answer) is not interaction_data.
    const bare =
      /(JSON\.stringify\(|interactionData(?::\s*[\w<>, ]+?)?\s*[:=])\s*\{\s*uri:\s*post\.uri,\s*cid:\s*post\.cid,?\s*\}/
    const offenders = files.filter((f) => bare.test(fs.readFileSync(path.join(root, f), 'utf8')))
    expect(offenders).toEqual([])
  })
})
