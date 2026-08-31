import { PublicShell } from '../components/public/PublicShell'
import {
  PublicVessel,
  PublicCard,
  PublicTitle,
  PublicBody,
} from '../components/public/PublicVessel'
import { PublicLink } from '../components/public/Field'

// NEW 2026-07-25. There was no `not-found.tsx`, so every 404 — and there are
// several routes that call `notFound()` deliberately, e.g. /read/:postId for a
// native post id — fell through to the Next.js default: a centred sans-serif
// "404 | This page could not be found" on white, with a hairline divider. That  hairline-ok (prose: describes the Next.js default this file replaces)
// was the single most off-brand screen on the site and the easiest to reach.
//
// A 404 on a link-shared platform is usually a DEAD SHARE — someone followed a
// link to a piece that has moved or been withdrawn — so the copy assumes that
// rather than assuming the visitor mistyped a URL.
export default function NotFound() {
  return (
    <PublicShell>
      <PublicVessel>
        <PublicCard>
          <PublicTitle>Nothing here.</PublicTitle>
          <div style={{ marginTop: 10 }}>
            <PublicBody>
              This page doesn’t exist, or doesn’t any more. If you followed a
              link to something someone wrote, they may have taken it down.
            </PublicBody>
          </div>
        </PublicCard>
        <PublicCard>
          <PublicBody>
            <PublicLink href="/">Back to the front</PublicLink>
          </PublicBody>
        </PublicCard>
      </PublicVessel>
    </PublicShell>
  )
}
