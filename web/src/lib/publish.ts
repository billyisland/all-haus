import { KIND_ARTICLE, KIND_DELETION } from './ndk'
import { signAndPublish, signViaGateway } from './sign'
import { articles as articlesApi, publications as publicationsApi, tags as tagsApi } from './api'
import type { PublishData } from '../components/editor/ArticleEditor'

// =============================================================================
// Publishing Service
//
// Orchestrates the full article publishing pipeline.
//
// Free articles:
//   1. Build, sign AND publish the NIP-23 event (v1 is canonical)
//   2. Index in the platform database (on failure: retract v1 from the relay)
//
// Paywalled articles (mirrors the scheduler pipeline — v1 never reaches the
// relay, so a failure part-way can't leave a live article whose paywall body
// was never vaulted, the "poisoned article" class):
//   1. Build and sign v1 (free content only) — SIGN ONLY, no relay publish.
//      v1 exists purely as the vault-ownership anchor: the key service
//      verifies the article row's nostr_event_id against it.
//   2. Index v1 → get the article UUID (row not on the relay yet)
//   3. Call key service to encrypt the paywall body (vault_keys row)
//   4. Build v2 with the ['payload', ciphertext, algorithm] tag, sign and
//      publish — the only event that ever reaches the relay
//   5. Re-index with v2's event ID (upsert on (writer, dTag))
//   On a step-3/4 failure for a NEW article, the just-created index row is
//   soft-deleted (best-effort) so nothing broken stays in feeds; the draft
//   still holds the full content. Edits are left in place — their original
//   vault key is intact, so reader unlocks keep working via the DB ciphertext.
//
// Drive fulfilment (draftId) and the subscriber email ride only the FINAL
// index call (step 2 for free, step 5 for paywalled) — see indexArticle below.
// =============================================================================

// Use relative URLs so requests go through the Next.js rewrite (same origin).
const API_BASE = '/api/v1'

interface PublishResult {
  articleEventId: string
  dTag: string
  articleId: string
}

export async function publishArticle(
  data: PublishData,
  writerPubkey: string,
  existingDTag?: string
): Promise<PublishResult> {
  const dTag = existingDTag ?? generateDTag(data.title)
  const isPaywalled = data.isPaywalled

  // A paywalled publish with nothing behind the gate can never be vaulted
  // (the key service rejects an empty body) — refuse before touching anything.
  // The editor validates this too; this is the pipeline's own guard.
  if (isPaywalled && !data.paywallContent.trim()) {
    throw new Error('There is no content after the paywall gate — move the gate up, or remove it.')
  }

  // `final` marks the index call after which the article is fully live (the
  // only call for free articles; step 5 / v2 for paywalled). Drive fulfilment
  // (draftId) and the subscriber email ride ONLY the final call: matched or
  // sent at the paywalled step-2 v1 index, a vault failure would charge
  // pledgers / email subscribers about an article that soft-deletes and never
  // publishes. emailAsNew tells the route the step-5 upsert is really a new
  // article (its own isNew is always false), echoed from step 2's response.
  const indexArticle = (
    nostrEventId: string,
    opts: { final: boolean; emailAsNew?: boolean }
  ) =>
    articlesApi.index({
      nostrEventId,
      dTag,
      title: data.title,
      summary: data.dek?.trim() || undefined,
      content: data.freeContent,
      accessMode: isPaywalled ? 'paywalled' : 'public',
      pricePence: data.pricePence,
      gatePositionPct: data.gatePositionPct,
      coverImageUrl: data.coverImageUrl ?? null,
      commentsEnabled: data.commentsEnabled,
      draftId: opts.final ? data.draftId ?? undefined : undefined,
      sendEmail: opts.final ? data.sendEmail : false,
      ...(opts.emailAsNew ? { emailAsNew: true } : {}),
    })

  // Step 1: Build and sign NIP-23 v1 (free content only — no payload yet).
  // Free articles publish it to the relay; paywalled articles ONLY SIGN it
  // (nothing on the relay until the vault is sealed and v2 exists).
  const v1 = buildNip23Event(data, dTag, null)
  const signedV1 = isPaywalled ? await signViaGateway(v1) : await signAndPublish(v1)

  // Step 2: Index v1 → get article UUID. For free articles this is the final
  // (and only) call; for paywalled it's the anchor-only index — no draftId,
  // no email — the final call is step 5.
  let articleId!: string
  let indexedAsNew = false
  try {
    const result = await indexArticle(signedV1.id, { final: !isPaywalled })
    articleId = result.articleId
    indexedAsNew = result.isNew === true
  } catch (indexErr) {
    if (!isPaywalled) {
      // Retract v1 from relay so it doesn't become a dead link
      try {
        await signAndPublish({
          kind: KIND_DELETION,
          content: '',
          tags: [
            ['e', signedV1.id],
            ['a', `30023:${writerPubkey}:${dTag}`],
          ],
        })
      } catch { /* best-effort */ }
    }
    // Paywalled: v1 was never published — nothing to retract.
    throw indexErr
  }

  // Save tags (non-fatal)
  if (data.tags && data.tags.length > 0) {
    try { await tagsApi.setForArticle(articleId, data.tags) } catch { /* non-fatal */ }
  }

  if (!isPaywalled) {
    return { articleEventId: signedV1.id, dTag, articleId }
  }

  let signedV2
  try {
    // Step 3: Encrypt the paywall body — needs articleId for vault key FK
    const { ciphertext, algorithm } = await encryptPaywallBody(
      signedV1.id,
      articleId,
      dTag,
      data
    )

    // Step 4: Build NIP-23 v2 with embedded payload tag, sign and publish.
    // This is the only event that reaches the relay. Replaceable events
    // (kind 30023) need strictly newer created_at to replace a prior version
    // on edit — pin v2 one second ahead of v1.
    const v2 = buildNip23Event(data, dTag, { ciphertext, algorithm })
    signedV2 = await signAndPublish({ ...v2, created_at: signedV1.created_at + 1 })
  } catch (err) {
    if (!existingDTag) {
      // New article: the index row just created would be a live paywalled
      // article with no vault key — readers must never see it. Soft-delete
      // (best-effort); the editor keeps the draft, so nothing is lost.
      try { await articlesApi.remove(articleId) } catch { /* best-effort */ }
    }
    // Edits keep their original vault key, so the live article still works.
    throw new Error(
      `Publishing the paywalled section failed — ${err instanceof Error ? err.message : 'unknown error'}. ` +
      'Nothing broken went live and your draft is intact. Please try publishing again.'
    )
  }

  // Step 5: Re-index with v2 event ID (upsert on (writer, dTag)). The final
  // call: carries draftId (drive fulfilment) + fires the new-article email.
  await indexArticle(signedV2.id, { final: true, emailAsNew: indexedAsNew })

  return { articleEventId: signedV2.id, dTag, articleId }
}

// =============================================================================
// Internal helpers
// =============================================================================

function buildNip23Event(
  data: PublishData,
  dTag: string,
  payload: { ciphertext: string; algorithm: string } | null
) {
  const tags: string[][] = [
    ['d', dTag],
    ['title', data.title],
    ['published_at', String(Math.floor(Date.now() / 1000))],
  ]

  if (data.dek?.trim()) {
    tags.push(['summary', data.dek.trim()])
  }

  if (data.coverImageUrl) {
    tags.push(['image', data.coverImageUrl])
  }

  if (data.isPaywalled) {
    tags.push(
      ['price', String(data.pricePence), 'GBP'],
      ['gate', String(data.gatePositionPct)]
    )
  }

  if (payload) {
    tags.push(['payload', payload.ciphertext, payload.algorithm])
  }

  return {
    kind: KIND_ARTICLE,
    content: data.isPaywalled ? data.freeContent : data.content,
    tags,
  }
}

async function encryptPaywallBody(
  articleEventId: string,
  articleId: string,
  dTag: string,
  data: PublishData
): Promise<{ ciphertext: string; algorithm: string }> {
  const res = await fetch(`${API_BASE}/articles/${articleEventId}/vault`, {
    method: 'POST',
    credentials: 'include',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      articleId,
      paywallBody: data.paywallContent,
      pricePence: data.pricePence,
      gatePositionPct: data.gatePositionPct,
      nostrDTag: dTag,
    }),
  })

  if (!res.ok) {
    const body = await res.json().catch(() => null)
    // Prefer the human `message`; never string-interpolate a non-string
    // `error` (a zod flatten object renders as "[object Object]").
    const detail =
      typeof body?.message === 'string' ? body.message
      : typeof body?.error === 'string' ? body.error
      : body?.error != null ? JSON.stringify(body.error)
      : 'unknown'
    throw new Error(`Vault encryption failed: ${res.status} — ${detail}`)
  }

  const result = await res.json()
  return { ciphertext: result.ciphertext, algorithm: result.algorithm }
}

// =============================================================================
// Publication publishing — delegates to the server-side pipeline
// =============================================================================

export async function publishToPublication(
  publicationId: string,
  data: PublishData & { showOnWriterProfile: boolean },
  existingDTag?: string
): Promise<{ articleId: string; status: string; dTag: string }> {
  const result = await publicationsApi.submitArticle(publicationId, {
    title: data.title,
    summary: data.dek?.trim() || undefined,
    content: data.isPaywalled ? data.freeContent : data.content,
    fullContent: data.content,
    accessMode: data.isPaywalled ? 'paywalled' : 'public',
    pricePence: data.isPaywalled ? data.pricePence : undefined,
    gatePositionPct: data.isPaywalled ? data.gatePositionPct : undefined,
    showOnWriterProfile: data.showOnWriterProfile,
    coverImageUrl: data.coverImageUrl ?? null,
    commentsEnabled: data.commentsEnabled,
    existingDTag,
  })

  if (data.tags && data.tags.length > 0) {
    try { await tagsApi.setForArticle(result.articleId, data.tags) } catch { /* non-fatal */ }
  }

  return result
}

// Mirror of shared/src/lib/slug.ts. Duplicated because Next.js (bundler
// moduleResolution, no workspace setup) can't cleanly import from shared/.
// web/tests/publish.test.ts asserts identical output to the gateway version
// and is how drift is caught.
function slugify(title: string, maxLen = 80): string {
  return title
    .toLowerCase()
    .replace(/[^a-z0-9\s-]/g, '')
    .replace(/\s+/g, '-')
    .replace(/-+/g, '-')
    .slice(0, maxLen)
}

export function generateDTag(title: string): string {
  const timestamp = Math.floor(Date.now() / 1000).toString(36)
  return `${slugify(title, 80)}-${timestamp}`
}
