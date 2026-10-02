import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { mergeTop, EMPTY_TOP, type TopState } from '../src/hooks/useArticleConversation'
import type { PostThreadTopResponse } from '../src/lib/api/post'
import type { Post } from '../src/lib/post/types'

// =============================================================================
// The article foot's rest state — GET /thread/:postId/top + mergeTop.
//
// The WIRE half reads the gateway source (a type is not a contract): the route
// path, the three query keys the client sends, and the response fields the
// section reads. Every match is asserted FOUND.
//
// The MERGE half pins the one ordering promise: a refresh never re-sorts what
// the reader is looking at, and anything new lands at the END.
// =============================================================================

const ROUTE = readFileSync(
  join(__dirname, '../../gateway/src/routes/post-thread.ts'),
  'utf8',
)

describe('GET /thread/:postId/top wire', () => {
  it('serves the path the client asks for', () => {
    expect(ROUTE).toMatch(/"\/thread\/:postId\/top"/)
  })
  it('reads the three query keys the client sends', () => {
    const qs = /Querystring: \{ limit\?: string; offset\?: string; focusComment\?: string \}/.exec(ROUTE)
    expect(qs).not.toBeNull()
  })
  it('answers every field the section reads', () => {
    const send = /return reply\.send\(\{\s*rootId:[\s\S]*?repostEdges,\s*\}\);/.exec(ROUTE)
    expect(send).not.toBeNull()
    for (const field of ['posts', 'topLevel:', 'nextOffset:', 'totalTopLevel:', 'totalReplies:', 'focus,']) {
      expect(send![0]).toContain(field)
    }
    for (const field of ['id: r.node.derived_post_id', 'count: r.count', 'previewIds:']) {
      expect(send![0]).toContain(field)
    }
  })
})

const post = (id: string): Post => ({ id }) as unknown as Post
const res = (
  ids: Array<[string, number]>,
  extra: Partial<PostThreadTopResponse> = {},
): PostThreadTopResponse => ({
  rootId: 'R',
  posts: ids.map(([id]) => post(id)),
  topLevel: ids.map(([id, count]) => ({ id, count, previewIds: [] })),
  totalTopLevel: ids.length,
  totalReplies: ids.reduce((n, [, c]) => n + 1 + c, 0),
  focus: null,
  repostEdges: [],
  ...extra,
})

describe('mergeTop', () => {
  it('a refresh keeps the loaded order, updates counts, appends arrivals', () => {
    const loaded: TopState = mergeTop(EMPTY_TOP, res([['a', 3], ['b', 1], ['c', 0]]), 'page')
    // b has gained enough to outrank a, and d is new.
    const after = mergeTop(loaded, res([['b', 5], ['a', 3], ['d', 0], ['c', 0]]), 'refresh')
    expect(after.entries.map((e) => [e.id, e.count])).toEqual([
      ['a', 3], ['b', 5], ['c', 0], ['d', 0],
    ])
  })

  it('a page appends in the server order and carries its own cursor', () => {
    const one = mergeTop(EMPTY_TOP, res([['a', 3]], { nextOffset: 1 }), 'page')
    const two = mergeTop(one, res([['a', 3], ['b', 1]]), 'page')
    expect(two.entries.map((e) => e.id)).toEqual(['a', 'b'])
    expect(two.nextOffset).toBeUndefined()
  })

  it('after a refresh with more beyond, the next page starts after everything shown', () => {
    const one = mergeTop(EMPTY_TOP, res([['a', 3], ['b', 1]], { nextOffset: 2 }), 'page')
    const after = mergeTop(one, res([['a', 3], ['b', 1], ['n', 0]], { nextOffset: 3 }), 'refresh')
    expect(after.nextOffset).toBe(3)
  })
})
