import type { Post } from '../lib/post/types'
import type { LinkedAccount } from '../lib/api/linked-accounts'
import type { ArticleMetadata } from '../lib/api/articles'
import { crossPostAccounts } from '../lib/note-compose'
import { PAYWALL_GATE_MARKER, splitAtGateMarker } from '../lib/gate-marker'
import { renderMarkdown } from '../lib/markdown'
import { stripOrnament } from './html-pass'
import { call, must, okBody, path, GatewayFault, type GatewayContext } from './gateway'
import type { Viewer } from './html'
import { EMPTY_SCHEDULE, penceToPounds, type WriteDraft, type WriteValues, type DraftRow } from './pages/writing'

// =============================================================================
// modernhaus — the writing step's gateway reads (MODERNHAUS-ADR §D2.3, E4).
//
// Same contract as the other loaders: null is the route's own "no such thing",
// a THROW is a fault, and a secondary read never throws — it says it is
// unavailable. One read here is NOT secondary although it looks it: the paid
// half of a published piece. An edit form that silently lacked it would
// publish the piece free — so a paywalled piece whose paid half could not be
// read is not offered for editing at all.
// =============================================================================

function absent(status: number): boolean {
  return status === 404 || status === 400
}

interface ThreadBody {
  focalId: string
  posts: Post[]
}

/** The post a note would quote, or null when there is none to quote. */
export async function loadQuoted(gw: GatewayContext, postId: string): Promise<Post | null> {
  const t = must(await call<ThreadBody>(gw, 'GET', path`/thread/${postId}`), 'thread')
  if (absent(t.status)) return null
  const thread = okBody(t, 'thread')
  const post = Array.isArray(thread.posts) ? thread.posts.find((p) => p.id === thread.focalId) : undefined
  // The full site offers no Quote on a deleted post or a locked conversation.
  if (!post || post.isDeleted || post.rootLocked === true) return null
  return post
}

/** The accounts a note can be cross-posted through — a secondary read. */
export async function loadCrossPost(gw: GatewayContext): Promise<LinkedAccount[] | null> {
  try {
    const a = await call<{ accounts?: LinkedAccount[] }>(gw, 'GET', '/linked-accounts')
    if (a.status !== 200 || !a.body || !Array.isArray(a.body.accounts)) return null
    return crossPostAccounts(a.body.accounts)
  } catch (err) {
    console.warn('[modernhaus] linked accounts unavailable', err instanceof GatewayFault ? err.message : err)
    return null
  }
}

export interface DraftBody {
  draftId: string
  title: string | null
  dek: string | null
  content: string | null
  dTag: string | null
  gatePositionPct: number | null
  pricePence: number | null
  publicationId: string | null
  coverImageUrl: string | null
  commentsEnabled: boolean
  autoSavedAt: string
  scheduledAt: string | null
}

export async function loadDraft(gw: GatewayContext, draftId: string): Promise<DraftBody | null> {
  const d = must(await call<DraftBody>(gw, 'GET', path`/drafts/${draftId}`), 'draft')
  if (absent(d.status)) return null
  return okBody(d, 'draft')
}

export function valuesFromDraft(d: DraftBody): { values: WriteValues; draft: WriteDraft } {
  return {
    values: {
      title: d.title ?? '',
      dek: d.dek ?? '',
      content: d.content ?? '',
      price: penceToPounds(d.pricePence),
      commentsEnabled: d.commentsEnabled,
      tags: '',
      sendEmail: true,
      schedule: EMPTY_SCHEDULE,
    },
    draft: {
      draftId: d.draftId,
      dTag: d.dTag,
      cover: d.coverImageUrl,
      scheduledAt: d.scheduledAt,
      publicationId: d.publicationId,
      savedAt: d.autoSavedAt,
      // A draft carrying a d-tag publishes as that piece. Whether a live piece
      // holds it yet is the route's to decide; the form only stops offering an
      // email the editor would not send.
      isEdit: d.dTag !== null,
    },
  }
}

interface EditorArticle {
  id: string
  contentFree: string | null
  contentPaywall: string | null
  isPaywalled: boolean
  pricePence: number | null
  commentsEnabled: boolean | null
  coverImageUrl: string | null
  summary: string | null
  title: string
}

export type EditLoad =
  | { kind: 'form'; values: WriteValues; draft: WriteDraft }
  | { kind: 'paid_half_unavailable'; dTag: string }

/**
 * A published piece of the viewer's, as an edit form. The public read finds it
 * and proves it is theirs; the EDITOR's read (`/articles/by-event`) carries the
 * paid half, which only the writer is given.
 */
export async function loadEdit(gw: GatewayContext, viewer: Viewer, dTag: string): Promise<EditLoad | null> {
  const a = must(await call<ArticleMetadata>(gw, 'GET', path`/articles/${dTag}`), 'article')
  if (absent(a.status)) return null
  const meta = okBody(a, 'article')
  if (meta.writer.id !== viewer.id || meta.withdrawn || !meta.nostrEventId) return null

  const e = must(await call<EditorArticle>(gw, 'GET', path`/articles/by-event/${meta.nostrEventId}`), 'article for editing')
  if (absent(e.status)) return null
  const ed = okBody(e, 'article for editing')
  if (ed.isPaywalled && !ed.contentPaywall) return { kind: 'paid_half_unavailable', dTag: meta.dTag }

  const content = ed.isPaywalled
    ? `${ed.contentFree ?? ''}\n\n${PAYWALL_GATE_MARKER}\n\n${ed.contentPaywall ?? ''}`
    : (ed.contentFree ?? '')

  // The tags are shown so the edit can keep them; unreadable, the field is
  // empty and Publish leaves the piece's tags as they are (it sets only a
  // non-empty list).
  let tags = ''
  try {
    const t = await call<{ tags?: string[] }>(gw, 'GET', path`/articles/${meta.id}/tags`)
    if (t.status === 200 && Array.isArray(t.body?.tags)) tags = t.body.tags.join(', ')
  } catch (err) {
    console.warn('[modernhaus] article tags unavailable', err instanceof GatewayFault ? err.message : err)
  }

  return {
    kind: 'form',
    values: {
      title: ed.title,
      dek: ed.summary ?? '',
      content,
      price: penceToPounds(ed.pricePence),
      commentsEnabled: ed.commentsEnabled ?? true,
      tags,
      sendEmail: false,
      schedule: EMPTY_SCHEDULE,
    },
    draft: {
      draftId: null,
      dTag: meta.dTag,
      cover: ed.coverImageUrl,
      scheduledAt: null,
      publicationId: null,
      savedAt: null,
      isEdit: true,
    },
  }
}

export async function loadDrafts(gw: GatewayContext): Promise<DraftRow[]> {
  const b = okBody(await call<{ drafts: DraftRow[] }>(gw, 'GET', '/drafts'), 'drafts')
  return Array.isArray(b.drafts) ? b.drafts : []
}

export interface PreviewData {
  draft: DraftBody
  freeHtml: string
  paid: { html: string; pricePence: number | null } | null
}

/** A draft, split where PUBLISH splits it (`lib/gate-marker.ts`), and rendered. */
export async function loadPreview(gw: GatewayContext, draftId: string): Promise<PreviewData | null> {
  const draft = await loadDraft(gw, draftId)
  if (!draft) return null
  const { free, paywall } = splitAtGateMarker(draft.content ?? '')
  const [freeHtml, paidHtml] = await Promise.all([
    renderMarkdown(free).then(stripOrnament),
    paywall ? renderMarkdown(paywall).then(stripOrnament) : Promise.resolve(null),
  ])
  return { draft, freeHtml, paid: paidHtml === null ? null : { html: paidHtml, pricePence: draft.pricePence } }
}
