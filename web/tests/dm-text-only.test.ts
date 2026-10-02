import { describe, it, expect } from 'vitest'
import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'

// =============================================================================
// THE DM THREAD RENDERS PLAIN TEXT, AND THAT IS LOAD-BEARING (L6.2)
//
// `MediaContent` linkified bare URLs and mounted YouTube iframes. On the DM
// surface both are the vector the policy says does not exist — a DM is the one
// place a stranger can put something in front of a member with nobody else in
// the room.
//
// WHY A GREP AND NOT A RENDER TEST. The thing to prevent is the import coming
// BACK, and a render test asserts what a fixture happened to produce. The
// gateway's link refusal (`containsUrl`) is deliberately loose — it does not
// chase a bare `example.com`, because the pattern that catches one also
// catches "node.js" — and it is only safe to be loose because nothing on this
// surface turns text into a link. So the two are one rule in two files, and
// this is the half that holds the renderer down. Same shape as the `href={`
// guard and the SSR-encoding grep: a standing rule is a grep, not a memory.
//
// EVERY ASSERTION CHECKS ITS SUBJECT WAS FOUND, because a renamed or moved
// component would otherwise make this suite pass by reading nothing.
// =============================================================================

const THREAD = join(__dirname, '../src/components/messages/MessageThread.tsx')
const GATEWAY_MESSAGES = join(__dirname, '../../gateway/src/routes/messages.ts')

/**
 * The file with its COMMENTS TAKEN OUT, because the component's own header
 * explains at length what was removed from it and why — and a grep for the
 * banned identifiers hits that prose first. This is the general trap in a
 * standing grep: the rule's own explanation is written in the words the rule
 * forbids, so the guard fires on the documentation and the real mount would
 * pass unnoticed behind it.
 *
 * Only whole-line `//` comments and `{\/* … *\/}` JSX comment blocks go; a
 * `//` inside a string literal (a URL) is on a line with code before it and
 * survives, which is the conservative direction — a surviving comment can only
 * make this test STRICTER.
 */
function code(path: string): string {
  return readFileSync(path, 'utf8')
    .replace(/\{\/\*[\s\S]*?\*\/\}/g, '')
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .split('\n')
    .filter((line) => !/^\s*\/\//.test(line))
    .join('\n')
}

describe('the DM thread is text only', () => {
  const src = code(THREAD)

  it('read the component at all, and read CODE', () => {
    // Both guards below are worthless against an empty string — and against a
    // file the comment-stripper ate.
    expect(src.length).toBeGreaterThan(2000)
    expect(src).toContain('export function MessageThread')
  })

  it('never imports MediaContent', () => {
    expect(src).not.toMatch(/MediaContent/)
  })

  it('offers no upload and appends no URL', () => {
    // `useMediaAttachments` is what uploaded the image AND what appended the
    // resulting URL to the body (`buildContent`). Both halves go together:
    // keeping the hook for "just the preview" is how the append comes back.
    expect(src).not.toMatch(/useMediaAttachments|MediaPreview|buildContent|detectEmbeds/)
  })

  it('renders the body as pre-wrapped text', () => {
    expect(src).toMatch(/whitespace-pre-wrap/)
  })

  it('surfaces the gateway refusal rather than swallowing it', () => {
    // A silent failure reads to the sender as a network hiccup, so they press
    // Send on the same body again and it fails identically.
    expect(src).toMatch(/apiErrorMessage\(err\)/)
    expect(src).toMatch(/setSendError/)
  })
})

describe('the two halves of the rule are both in place', () => {
  it('the gateway refuses a link in a DM body', () => {
    const gw = code(GATEWAY_MESSAGES)
    expect(gw).toMatch(/if \(containsUrl\(parsed\.data\.content\)\)/)
    expect(gw).toMatch(/DM_LINKS_REFUSED/)
  })

  it('MediaContent is gone, and MediaPreview is still a live component', () => {
    // MediaContent outlived its last caller and was deleted (CA-I7), so the
    // "never imports" case above now also stops it being RE-CREATED here.
    // MediaPreview is still the note composer's, so the `not.toMatch` on it
    // above is a guard on a real component, not on a name that no longer
    // means anything — which is what this case pins.
    expect(existsSync(join(__dirname, '../src/components/ui/MediaContent.tsx'))).toBe(false)
    const mp = join(__dirname, '../src/components/ui/MediaPreview.tsx')
    expect(readFileSync(mp, 'utf8')).toContain('export function MediaPreview')
  })
})
