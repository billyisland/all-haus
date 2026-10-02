import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

// =============================================================================
// The Mute/Block controls read three things off the gateway, none of which a
// type can vouch for (W2, walkthrough A7):
//
//   · the viewer's state — `{ muted, blocked }` — built in ONE place,
//     `lib/blocks.ts::viewerRelation`, and carried under three names: the
//     body of `GET /my/relations/:userId`, `viewer` on `GET /writers/:username`
//     and `viewerRelation` on the author card. A renamed key reads `undefined`
//     here, which `MuteBlockControls` takes as "not known yet" and fetches — so
//     the profile would still work, slower, and nothing would ever say so;
//   · the relations route's PATH, which `social.relation` builds by hand;
//   · the block's answer, whose `subscriptionsEnding` is what the web types.
//
// Reads the gateway source rather than importing it — there is no module path
// between the workspaces — and asserts every match was FOUND, since a renamed
// constant otherwise passes by testing nothing.
// =============================================================================

const read = (p: string) => readFileSync(join(__dirname, p), 'utf8')

const BLOCKS = read('../../gateway/src/lib/blocks.ts')
const SOCIAL_ROUTE = read('../../gateway/src/routes/social.ts')
const WRITERS_ROUTE = read('../../gateway/src/routes/writers.ts')
const AUTHOR_RESOLVE = read('../../gateway/src/lib/author-resolve.ts')
const WEB_SOCIAL = read('../src/lib/api/social.ts')
const WEB_WRITERS = read('../src/lib/api/writers.ts')
const WEB_POST = read('../src/lib/api/post.ts')

describe('mute/block — parity with the gateway', () => {
  it('the relation is { muted, blocked } on both sides', () => {
    const gw = BLOCKS.match(/export interface ViewerRelation \{([^}]*)\}/)
    expect(gw, 'ViewerRelation not found in lib/blocks.ts').not.toBeNull()
    const web = WEB_SOCIAL.match(/export interface ViewerRelation \{([^}]*)\}/)
    expect(web, 'ViewerRelation not found in web api/social.ts').not.toBeNull()
    const keys = (body: string) =>
      [...body.matchAll(/(\w+)\s*:/g)].map((m) => m[1]).sort()
    expect(keys(gw![1])).toEqual(['blocked', 'muted'])
    expect(keys(web![1])).toEqual(keys(gw![1]))
  })

  it('the relations route is the path the web builds', () => {
    expect(SOCIAL_ROUTE).toContain('"/my/relations/:userId"')
    expect(WEB_SOCIAL).toContain('`/my/relations/${userId}`')
  })

  it('the profile payloads carry it under the names the web reads', () => {
    // writers.ts spreads `{ viewer }`; the web type reads `viewer`.
    expect(WRITERS_ROUTE).toMatch(/\.\.\.\(viewer \? \{ viewer \} : \{\}\)/)
    expect(WEB_WRITERS).toMatch(/\bviewer\?: ViewerRelation/)
    // author-resolve.ts stamps `viewerRelation`; so does the web type.
    expect(AUTHOR_RESOLVE).toMatch(/\{ viewerRelation: relation \}/)
    expect(WEB_POST).toMatch(/\bviewerRelation\?:/)
  })

  it("the block's answer names what the web types", () => {
    for (const key of ['followsDropped', 'subscriptionsEnding']) {
      expect(SOCIAL_ROUTE, `${key} not in the block route`).toContain(key)
      expect(WEB_SOCIAL, `${key} not in BlockResult`).toContain(key)
    }
    expect(SOCIAL_ROUTE).toContain('accessUntil')
    expect(WEB_SOCIAL).toContain('accessUntil')
  })
})
