import { createElement } from 'react'
import {
  NOTE_CHAR_LIMIT,
  joinTextAndImages,
  noteEventParts,
  quoteUrlReserve,
  type CrossPostTarget,
} from '../../lib/note-compose'
import { quoteTargetFromPost } from '../../lib/post/quote-target'
import { splitAtGateMarker, hasGateMarker, gatePositionPct } from '../../lib/gate-marker'
import { validatePaywalledPublish, PAYWALL_EMPTY, PAYWALL_PRICE_REQUIRED } from '../../lib/publish-validation'
import { safeHttpUrl } from '../../lib/external-links'
import { call, must, path, type GatewayAnswer } from '../gateway'
import { safeReturn } from '../outcomes'
import { documentResponse, loadViewer } from '../page'
import type { ActionContext, ActionOutcome, Input, Registry } from '../door'
import { doorOwns, refusalSentence } from './shared'
import { loadQuoted, loadCrossPost } from '../writing-loaders'
import { filePart, uploadPicture } from '../picture'
import { wallFromBoxes, londonToInstant } from '../london-time'
import { acceptCarriedTerms, errorCode } from './terms'
import { ACCEPT_TERMS_FIELD } from '../consent'
import {
  ComposePage,
  WritePage,
  UploadPage,
  type WriteValues,
  type WriteDraft,
} from '../pages/writing'

// =============================================================================
// modernhaus — the writing step's writes (MODERNHAUS-ADR §D2.4, E4).
//
// A NOTE is `publishNote`'s sequence on the server — the picture uploaded
// first, then sign-and-publish, then `POST /notes` — over the event the full
// site builds (`noteEventParts`). Its checks run BEFORE the signature: the
// relay takes a signed event whatever the index then says, so an empty or
// over-long note refused only by the index would leave an orphan on the relay.
//
// AN ARTICLE is saved first, always. Save draft stops there; Publish now and
// Schedule save and then ask, so the writer's text is in the draft before any
// refusal can happen — and every later refusal is a redirect to the draft's
// own page with a code, never a lost form. Publish now goes through the one
// door made for it (`POST /drafts/:id/publish`, over `publishPersonalArticle`),
// after running the editor's own paywall check (`validatePaywalledPublish`).
//
// Long text re-renders its form on a refusal (§D1.3) with the route's own
// sentence (§D2.5.3); 401 and `age_required` stay the door's.
// =============================================================================

const str = (v: Input[string]): string => (typeof v === 'string' ? v.trim() : '')
const raw = (v: Input[string]): string => (typeof v === 'string' ? v : '')

/** A picture uploaded by an earlier, refused press — kept rather than asked for again. */
function keptPicture(input: Input): string | null {
  return safeHttpUrl(str(input.pictureUrl)) ?? null
}

// ---------------------------------------------------------------------------
// A note.
// ---------------------------------------------------------------------------

async function noteAgain(
  ctx: ActionContext,
  input: Input,
  sentence: string,
  status: number,
  pictureUrl: string | null,
): Promise<ActionOutcome> {
  const quoteId = str(input.quote)
  const [viewer, quote, crossPost] = await Promise.all([
    loadViewer(ctx.gw),
    quoteId ? loadQuoted(ctx.gw, quoteId) : Promise.resolve(null),
    quoteId ? Promise.resolve([]) : loadCrossPost(ctx.gw),
  ])
  return {
    kind: 'response',
    response: await documentResponse({
      title: 'Your note was not posted',
      viewer,
      csrf: ctx.csrf,
      twin: null,
      outcome: { kind: 'error', sentence },
      body: createElement(ComposePage, {
        csrf: ctx.csrf,
        quote,
        crossPost,
        back: safeReturn(str(input.return) || null),
        draft: raw(input.content),
        pictureUrl,
        ticked: Array.isArray(input.crossPost) ? input.crossPost : [],
        canWrite: viewer?.canWrite,
      }),
      status,
      cookies: ctx.gw.setCookies,
    }),
  }
}

async function note(ctx: ActionContext, input: Input): Promise<ActionOutcome> {
  // The quoted post is RE-READ, never taken from the form: the target and its
  // snapshot are the gateway's, as the follow target is (§E3.2.6).
  const quoteId = str(input.quote)
  const quoted = quoteId ? await loadQuoted(ctx.gw, quoteId) : null
  if (quoteId && !quoted) return { kind: 'error', code: 'not_found' }
  const target = quoted ? quoteTargetFromPost(quoted) : undefined

  let pictureUrl = keptPicture(input)
  const upload = await uploadPicture(ctx, filePart(ctx.form, 'picture'))
  if (upload.kind === 'refused') {
    if (doorOwns(upload.answer)) return { kind: 'answer', answer: upload.answer }
    return noteAgain(ctx, input, refusalSentence(upload.answer), 400, pictureUrl)
  }
  if (upload.kind === 'stored') pictureUrl = upload.url

  const body = joinTextAndImages(raw(input.content), pictureUrl ? [pictureUrl] : [])
  if (!body) return noteAgain(ctx, input, 'Write something, or add a picture, before posting.', 400, pictureUrl)
  const length = body.length + quoteUrlReserve(target)
  if (length > NOTE_CHAR_LIMIT) {
    return noteAgain(
      ctx,
      input,
      `A note can be at most ${NOTE_CHAR_LIMIT.toLocaleString('en-GB')} characters, and this one is ${length.toLocaleString('en-GB')}. Shorten it, or write an article instead.`,
      400,
      pictureUrl,
    )
  }

  // A quote carries no cross-posts (it publishes through its own path).
  const crossPosts: CrossPostTarget[] = target
    ? []
    : (Array.isArray(input.crossPost) ? input.crossPost : [])
        .filter((id) => id.trim() !== '')
        .map((id) => ({ linkedAccountId: id, actionType: 'original' as const }))

  const parts = noteEventParts(body, target, crossPosts.length > 0 ? crossPosts : undefined)
  const signed = must(
    await call<{ id?: string; pubkey?: string; sig?: string; created_at?: number }>(ctx.gw, 'POST', '/sign-and-publish', {
      json: { kind: 1, content: parts.content, tags: parts.tags },
    }),
    'sign-and-publish',
  )
  if (signed.status !== 200 || typeof signed.body?.id !== 'string') {
    if (doorOwns(signed) || signed.status < 400) return { kind: 'answer', answer: signed }
    return noteAgain(ctx, input, refusalSentence(signed), signed.status, pictureUrl)
  }

  const { id, pubkey, sig, created_at } = signed.body
  const signature =
    typeof pubkey === 'string' && typeof sig === 'string' && typeof created_at === 'number'
      ? { id, pubkey, sig, created_at }
      : undefined
  const indexed = must(await call(ctx.gw, 'POST', '/notes', { json: parts.indexBody(id, signature) }), 'notes')
  if (indexed.status === 201 || indexed.status === 200) return { kind: 'done', code: 'posted' }
  if (doorOwns(indexed) || indexed.status < 400) return { kind: 'answer', answer: indexed }
  return noteAgain(ctx, input, refusalSentence(indexed), indexed.status, pictureUrl)
}

// ---------------------------------------------------------------------------
// An article: save, then (maybe) publish or schedule.
// ---------------------------------------------------------------------------

/** Pounds as typed → pence; "" is none (0), anything not a sum of money is null. */
export function poundsToPence(value: string): number | null {
  const v = value.trim()
  if (v === '') return 0
  const m = /^£?\s*(\d{1,5})(?:\.(\d{1,2}))?$/.exec(v)
  if (!m) return null
  return Number(m[1]) * 100 + (m[2] ? Number(m[2].padEnd(2, '0')) : 0)
}

function writeValues(input: Input): WriteValues {
  return {
    title: raw(input.title),
    dek: raw(input.dek),
    content: raw(input.content),
    price: raw(input.price),
    commentsEnabled: input.commentsEnabled === true,
    tags: raw(input.tags),
    sendEmail: input.sendEmail === true,
    schedule: {
      day: raw(input.schedule_day),
      month: raw(input.schedule_month),
      year: raw(input.schedule_year),
      hour: raw(input.schedule_hour),
      minute: raw(input.schedule_minute),
    },
  }
}

function writeDraft(input: Input, draftId: string | null): WriteDraft {
  const dTag = str(input.dTag) || null
  return {
    draftId,
    dTag,
    cover: str(input.cover) || null,
    scheduledAt: null,
    publicationId: null,
    savedAt: null,
    isEdit: dTag !== null,
  }
}

async function writeAgain(ctx: ActionContext, input: Input, sentence: string, status: number): Promise<ActionOutcome> {
  const viewer = await loadViewer(ctx.gw)
  return {
    kind: 'response',
    response: await documentResponse({
      title: 'Your piece was not saved',
      viewer,
      csrf: ctx.csrf,
      twin: null,
      outcome: { kind: 'error', sentence },
      body: createElement(WritePage, {
        csrf: ctx.csrf,
        values: writeValues(input),
        draft: writeDraft(input, str(input.draftId) || null),
      }),
      status,
      cookies: ctx.gw.setCookies,
    }),
  }
}

type Saved = { kind: 'saved'; draftId: string } | { kind: 'outcome'; outcome: ActionOutcome }

/**
 * `POST /drafts`, targeting the row EXPLICITLY (posts.md: one draft row per
 * article, never re-guessed): the draft's own id when the form has one, else
 * the piece's d-tag for an edit, else `newDraft` — a row of its own.
 */
async function saveDraft(ctx: ActionContext, input: Input): Promise<Saved> {
  const content = raw(input.content)
  const pricePence = poundsToPence(raw(input.price))
  if (pricePence === null) {
    return {
      kind: 'outcome',
      outcome: await writeAgain(ctx, input, 'Write the price in pounds and pence, for example 0.40.', 400),
    }
  }
  const paywalled = hasGateMarker(content)
  const { free, paywall } = splitAtGateMarker(content)
  const draftId = str(input.draftId)
  const dTag = str(input.dTag)
  const cover = str(input.cover)
  const answer = must(
    await call<{ draftId?: string }>(ctx.gw, 'POST', '/drafts', {
      json: {
        title: raw(input.title),
        dek: raw(input.dek),
        content,
        pricePence,
        // Where the gate falls, the editor's way — the figure the key service
        // will be handed when the piece publishes, so it must be 1..99.
        gatePositionPct: paywalled ? gatePositionPct(free, paywall) : 50,
        commentsEnabled: input.commentsEnabled === true,
        ...(draftId ? { draftId } : {}),
        ...(dTag ? { dTag } : {}),
        // A piece never saved before gets a row of its own — never the route's
        // guess, which would overwrite the writer's latest untitled draft.
        ...(!draftId && !dTag ? { newDraft: true } : {}),
        ...(cover ? { coverImageUrl: cover } : {}),
      },
    }),
    'draft save',
  )
  if ((answer.status === 200 || answer.status === 201) && typeof answer.body?.draftId === 'string') {
    return { kind: 'saved', draftId: answer.body.draftId }
  }
  if (doorOwns(answer) || answer.status < 400) return { kind: 'outcome', outcome: { kind: 'answer', answer } }
  return { kind: 'outcome', outcome: await writeAgain(ctx, input, refusalSentence(answer), 400) }
}

const draftPage = (id: string) => `/modernhaus/write/${encodeURIComponent(id)}`

async function draftSave(ctx: ActionContext, input: Input): Promise<ActionOutcome> {
  const saved = await saveDraft(ctx, input)
  if (saved.kind === 'outcome') return saved.outcome
  return { kind: 'done', code: 'draft_saved', back: draftPage(saved.draftId) }
}

/** The editor's own paywall check, on the text just saved; a code for the draft's page. */
function paywallRefusal(input: Input): string | null {
  const content = raw(input.content)
  const { paywall } = splitAtGateMarker(content)
  const sentence = validatePaywalledPublish({
    isPaywalled: hasGateMarker(content),
    paywallContent: paywall,
    pricePence: poundsToPence(raw(input.price)) ?? 0,
    publicationId: null,
  })
  if (sentence === null) return null
  return sentence === PAYWALL_EMPTY ? 'paywall_empty' : sentence === PAYWALL_PRICE_REQUIRED ? 'paywall_price' : 'invalid'
}

/** The comma list as the route takes it: trimmed, empties dropped, five at most (the route normalises). */
export function tagList(value: string): string[] {
  return value
    .split(',')
    .map((t) => t.trim())
    .filter(Boolean)
    .slice(0, 5)
}

/**
 * The draft's page, remembering WHICH press met the Writer Agreement, so the
 * consent stands in for that press's button and accepting resumes it.
 */
function termsBack(back: string, press: 'publish' | 'schedule'): string {
  return `${back}?press=${press}`
}

/** The Writer Agreement, first, when the press carried the ticked box. */
async function writerTermsFirst(ctx: ActionContext, input: Input, back: string, press: 'publish' | 'schedule'): Promise<ActionOutcome | null> {
  const terms = await acceptCarriedTerms(ctx.gw, 'writer', input)
  if (terms.kind === 'answer') return { kind: 'answer', answer: terms.answer, back }
  if (terms.kind === 'refused') return { kind: 'error', code: terms.code, back: termsBack(back, press) }
  return null
}

/** The route's own Writer Agreement refusal, back to the press that met it. */
function writerTermsRefused(answer: GatewayAnswer, back: string, press: 'publish' | 'schedule'): ActionOutcome | null {
  return answer.status === 403 && errorCode(answer.body) === 'writer_terms_required'
    ? { kind: 'error', code: 'writer_terms_required', back: termsBack(back, press) }
    : null
}

async function publishNow(ctx: ActionContext, input: Input): Promise<ActionOutcome> {
  const saved = await saveDraft(ctx, input)
  if (saved.kind === 'outcome') return saved.outcome
  const back = draftPage(saved.draftId)

  const refusal = paywallRefusal(input)
  if (refusal) return { kind: 'error', code: refusal, back }

  const terms = await writerTermsFirst(ctx, input, back, 'publish')
  if (terms) return terms

  const answer = must(
    await call<{ articleId?: string; dTag?: string }>(ctx.gw, 'POST', path`/drafts/${saved.draftId}/publish`, {
      // Only a form that OFFERED the email choice says anything about it; an
      // edit's form does not, and the route then decides (an edit emails nobody).
      json: input.emailOffered === '1' ? { sendEmail: input.sendEmail === true } : {},
    }),
    'publish now',
  )
  if (answer.status !== 201 || typeof answer.body?.dTag !== 'string' || typeof answer.body.articleId !== 'string') {
    if (answer.status >= 200 && answer.status < 300) throw new Error('publish-now answered without its article')
    return writerTermsRefused(answer, back, 'publish') ?? { kind: 'answer', answer, back }
  }
  const article = `/modernhaus/article/${encodeURIComponent(answer.body.dTag)}`

  // Tags ride the publish, as on the full site, and a refusal there does not
  // un-publish anything — it is said, never swallowed.
  const tags = tagList(raw(input.tags))
  if (tags.length > 0) {
    try {
      const t = await call(ctx.gw, 'PUT', path`/articles/${answer.body.articleId}/tags`, { json: { tags } })
      if (t.status < 200 || t.status >= 300) return { kind: 'done', code: 'published_untagged', back: article }
    } catch (err) {
      console.error('[modernhaus] tags not saved after publish', err)
      return { kind: 'done', code: 'published_untagged', back: article }
    }
  }
  return { kind: 'done', code: 'published', back: article }
}

async function schedule(ctx: ActionContext, input: Input): Promise<ActionOutcome> {
  const saved = await saveDraft(ctx, input)
  if (saved.kind === 'outcome') return saved.outcome
  const back = draftPage(saved.draftId)

  const wall = wallFromBoxes({
    day: raw(input.schedule_day),
    month: raw(input.schedule_month),
    year: raw(input.schedule_year),
    hour: raw(input.schedule_hour),
    minute: raw(input.schedule_minute),
  })
  const at = wall ? londonToInstant(wall) : null
  if (!at) return { kind: 'error', code: 'schedule_invalid', back }
  if (at.getTime() <= Date.now()) return { kind: 'error', code: 'schedule_past', back }

  const refusal = paywallRefusal(input)
  if (refusal) return { kind: 'error', code: refusal, back }

  const terms = await writerTermsFirst(ctx, input, back, 'schedule')
  if (terms) return terms

  const answer = must(
    await call(ctx.gw, 'POST', path`/drafts/${saved.draftId}/schedule`, { json: { scheduledAt: at.toISOString() } }),
    'schedule',
  )
  if (answer.status === 200) return { kind: 'done', code: 'scheduled', back }
  return writerTermsRefused(answer, back, 'schedule') ?? { kind: 'answer', answer, back }
}

// ---------------------------------------------------------------------------
// A picture on its own: the upload renders its result (the URL is the
// gateway's own answer; a redirect could only carry it as free text).
// ---------------------------------------------------------------------------

async function upload(ctx: ActionContext): Promise<ActionOutcome> {
  const file = filePart(ctx.form, 'file')
  const render = async (url: string | null, refused: string | null, status: number) => {
    const viewer = await loadViewer(ctx.gw)
    return {
      kind: 'response' as const,
      response: await documentResponse({
        title: 'Upload a picture',
        viewer,
        csrf: ctx.csrf,
        twin: null,
        outcome: null,
        body: createElement(UploadPage, { csrf: ctx.csrf, url, refused, canWrite: viewer?.canWrite }),
        status,
        cookies: ctx.gw.setCookies,
      }),
    }
  }
  if (!file) return render(null, 'Choose a picture to upload.', 400)
  const stored = await uploadPicture(ctx, file)
  if (stored.kind === 'refused') {
    if (doorOwns(stored.answer)) return { kind: 'answer', answer: stored.answer }
    return render(null, refusalSentence(stored.answer), 400)
  }
  if (stored.kind === 'none') return render(null, 'Choose a picture to upload.', 400)
  return render(stored.url, null, 200)
}

const WRITE_FIELDS = {
  title: 'string',
  dek: 'string',
  content: 'string',
  price: 'string',
  commentsEnabled: 'boolean',
  tags: 'string',
  sendEmail: 'boolean',
  emailOffered: 'string',
  draftId: 'string',
  dTag: 'string',
  cover: 'string',
  schedule_day: 'string',
  schedule_month: 'string',
  schedule_year: 'string',
  schedule_hour: 'string',
  schedule_minute: 'string',
  [ACCEPT_TERMS_FIELD]: 'string',
} as const

const drafts = () => '/modernhaus/write/drafts'

export const WRITING_ACTIONS: Registry = {
  note: {
    kind: 'orchestrated',
    fields: { content: 'string', quote: 'string', crossPost: 'list', pictureUrl: 'string', return: 'string' },
    run: note,
    defaultReturn: () => '/modernhaus',
  },
  draft_save: { kind: 'orchestrated', fields: WRITE_FIELDS, run: draftSave, defaultReturn: drafts },
  publish_now: { kind: 'orchestrated', fields: WRITE_FIELDS, run: publishNow, defaultReturn: drafts },
  schedule: { kind: 'orchestrated', fields: WRITE_FIELDS, run: schedule, defaultReturn: drafts },
  unschedule: {
    kind: 'simple',
    method: 'DELETE',
    fields: { draftId: 'string' },
    path: (i) => path`/drafts/${str(i.draftId)}/schedule`,
    done: 'unscheduled',
    defaultReturn: drafts,
  },
  draft_delete: {
    kind: 'simple',
    method: 'DELETE',
    fields: { draftId: 'string' },
    path: (i) => path`/drafts/${str(i.draftId)}`,
    done: 'deleted',
    defaultReturn: drafts,
  },
  upload: { kind: 'orchestrated', fields: {}, run: (ctx) => upload(ctx), defaultReturn: () => '/modernhaus/upload' },
}
