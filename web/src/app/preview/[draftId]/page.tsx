import type { Metadata } from 'next'
import { PublicPage } from '../../../components/public/PublicPage'
import { ReadingScrollbar } from '../../../components/layout/ReadingScrollbar'
import { DraftPreview } from './DraftPreview'

// =============================================================================
// Draft preview — /preview/:draftId  (ARTICLE-EDITOR-PLAN slice 4)
//
// A SERVER SHELL OVER A CLIENT BODY, and the split is forced rather than
// stylistic. `GET /drafts/:id` is writer-scoped on the session cookie, so the
// fetch belongs client-side — the `/read/[postId]` precedent is a server
// component and is the wrong model here, because a server fetch would have to
// forward the viewer's session into a route shape that is otherwise
// anonymous-and-cached. But `noindex` wants Next's `metadata`, which is a
// server export. So: this file is the server component that carries the robots
// directive, and it renders a client child that does the fetch and mounts the
// real `ArticleReader`.
//
// ONE BODY, ONE SEAM. The preview renders through `ArticleReader` under its
// `preview` prop — never a parallel presentational component. Fidelity to the
// native URL is the whole feature, and two bodies drift silently: the drift
// would be invisible until the piece was live, which is precisely when a
// preview has stopped being able to help.
//
// `noindex` is belt and braces beside the reader's own standing strap: the
// route is already writer-scoped and a crawler has no session, so there is
// nothing here for one to index. It costs a line and it removes the class of
// accident where a draft URL is pasted somewhere public.
// =============================================================================

export const metadata: Metadata = {
  robots: { index: false, follow: false },
}

export default function DraftPreviewPage({ params }: { params: { draftId: string } }) {
  // `ground={false}` + `barGround`: `ArticleReader`'s root is
  // `min-h-screen bg-white` — it is the reading surface and owns both its
  // ground and its height — and the fixed nav bar must sit on that same white
  // or it draws its own bottom edge as a seam. Same pair as /article/[dTag].
  return (
    <PublicPage ground={false} barGround="var(--ah-white)">
      <ReadingScrollbar />
      <DraftPreview draftId={params.draftId} />
    </PublicPage>
  )
}
