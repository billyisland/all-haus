import type { Post } from '../../lib/post/types'
import type { LinkedAccount } from '../../lib/api/linked-accounts'
import { NOTE_CHAR_LIMIT, CROSS_POST_LABELS } from '../../lib/note-compose'
import { PAYWALL_GATE_MARKER } from '../../lib/gate-marker'
import { formatPrice } from '../../lib/format'
import { safeHttpUrl } from '../../lib/external-links'
import { PostForm, Hidden, Time, Unavailable, type ViewerTerms } from '../html'
import { TermsConsentBox } from '../consent'
import { TERMS_PURPOSE, WRITER_TERMS_LEAD, TERMS_ACCEPT_AND_CONTINUE } from '../../content/terms-consent'
import { authorName } from '../post'

// =============================================================================
// modernhaus — writing (MODERNHAUS-ADR §D2.3 *Writing*, E4): a note, an
// article in a markdown textarea, the drafts list, a draft's preview and the
// picture upload.
//
// The register's two named exceptions to the compose rules are these forms
// (web-modernhaus.md: its own note form, a markdown `<textarea>` beside the ONE
// editor). What they DO share with the full site is below them: the note's
// ceiling and its event (`lib/note-compose.ts`), where the gate falls
// (`lib/gate-marker.ts`), and the gateway routes, which stay the guard.
//
// A BUTTON THAT CANNOT DO ITS JOB IS NOT OFFERED: a scheduled draft offers no
// Publish now (the route refuses it) and says how to get it back; a
// publication's draft offers neither publish nor schedule.
// =============================================================================

const IMAGE_TYPES = 'image/jpeg,image/png,image/gif,image/webp'

/** The quoted post, drawn as a short excerpt — one post per item, never a second post. */
function QuotedExcerpt(props: { post: Post }) {
  const { post } = props
  const text = post.body.title ?? post.body.summary ?? post.body.text ?? ''
  return (
    <blockquote>
      <p>{`${authorName(post)}: ${text.length > 280 ? `${text.slice(0, 280)}…` : text}`}</p>
    </blockquote>
  )
}

export interface ComposeProps {
  csrf: string
  /** The post being quoted, or null for a plain note. */
  quote: Post | null
  /** The accounts a note can be cross-posted through; null when they could not be read. */
  crossPost: LinkedAccount[] | null
  back: string | null
  draft?: string
  /** A picture already uploaded by an earlier press that was refused. */
  pictureUrl?: string | null
  /** The cross-posts ticked on that press; absent means each account's own default. */
  ticked?: readonly string[]
  /** Only a writer is pointed at articles and drafts (READER-WRITER-SPLIT-ADR §6.3). */
  canWrite?: boolean
}

export function ComposePage(props: ComposeProps) {
  const { quote } = props
  const picture = props.pictureUrl ? safeHttpUrl(props.pictureUrl) : undefined
  const accounts = quote ? [] : (props.crossPost ?? [])
  return (
    <>
      {quote && (
        <>
          <p>Quoting:</p>
          <QuotedExcerpt post={quote} />
        </>
      )}
      <PostForm action="note" csrf={props.csrf} multipart>
        <Hidden values={{ quote: quote?.id, return: props.back, pictureUrl: picture }} />
        <p>
          <label>
            {quote ? 'What you want to say about it' : 'Your note'}
            <br />
            <textarea name="content" rows={6} cols={60} defaultValue={props.draft} />
          </label>
        </p>
        <p>{`At most ${NOTE_CHAR_LIMIT.toLocaleString('en-GB')} characters, a picture's address included.`}</p>
        {picture ? (
          <p>
            {'Your picture is kept: '}
            <a href={picture}>{picture}</a>
          </p>
        ) : (
          <p>
            <label>
              {'A picture (optional) '}
              <input type="file" name="picture" accept={IMAGE_TYPES} />
            </label>
          </p>
        )}
        {!quote && props.crossPost === null && (
          <p>We couldn’t load your other networks just now, so this note will go to all.haus only.</p>
        )}
        {accounts.length > 0 && (
          <fieldset>
            <legend>Also post it to</legend>
            {accounts.map((a) => (
              <p key={a.id}>
                <label>
                  <input
                    type="checkbox"
                    name="crossPost"
                    value={a.id}
                    defaultChecked={props.ticked ? props.ticked.includes(a.id) : a.crossPostDefault}
                  />
                  {` ${CROSS_POST_LABELS[a.protocol] ?? a.protocol.toUpperCase()}${a.externalHandle ? ` (${a.externalHandle})` : ''}`}
                </label>
              </p>
            ))}
          </fieldset>
        )}
        <p>
          <button>Post</button>
        </p>
      </PostForm>
      {!quote && (
        <p>
          {props.canWrite === true && (
            <>
              <a href="/modernhaus/write">Write an article instead</a>
              {' · '}
              <a href="/modernhaus/write/drafts">Your drafts</a>
              {' · '}
            </>
          )}
          <a href="/modernhaus/upload">Upload a picture</a>
        </p>
      )}
      {props.back && (
        <p>
          <a href={props.back}>Back</a>
        </p>
      )}
    </>
  )
}

// ---------------------------------------------------------------------------
// The article form.
// ---------------------------------------------------------------------------

export interface ScheduleBoxes {
  day: string
  month: string
  year: string
  hour: string
  minute: string
}

export const EMPTY_SCHEDULE: ScheduleBoxes = { day: '', month: '', year: '', hour: '', minute: '' }

export interface WriteValues {
  title: string
  dek: string
  content: string
  /** Pounds, as typed ("0.40"). */
  price: string
  commentsEnabled: boolean
  tags: string
  sendEmail: boolean
  schedule: ScheduleBoxes
}

export interface WriteDraft {
  draftId: string | null
  /** Set when this is (or will publish as) an edit of a published piece. */
  dTag: string | null
  cover: string | null
  /** When the draft is waiting to publish. */
  scheduledAt: string | null
  publicationId: string | null
  savedAt: string | null
  /** Editing a live piece: an edit emails nobody, so the choice is not offered. */
  isEdit: boolean
}

export const NEW_DRAFT: WriteDraft = {
  draftId: null,
  dTag: null,
  cover: null,
  scheduledAt: null,
  publicationId: null,
  savedAt: null,
  isEdit: false,
}

/** Pence as the pounds a writer types, "" for none. */
export function penceToPounds(pence: number | null | undefined): string {
  if (!pence || pence < 1) return ''
  return `${Math.floor(pence / 100)}.${String(pence % 100).padStart(2, '0')}`
}

function ScheduleFields(props: { values: ScheduleBoxes }) {
  const box = (name: keyof ScheduleBoxes, label: string, size: number) => (
    <label>
      {`${label} `}
      <input type="text" inputMode="numeric" name={`schedule_${name}`} defaultValue={props.values[name]} maxLength={size} size={size} />
    </label>
  )
  return (
    <>
      <p>
        {box('day', 'Day', 2)} {box('month', 'Month', 2)} {box('year', 'Year', 4)}
      </p>
      <p>
        {box('hour', 'Hour', 2)} {box('minute', 'Minute', 2)}
      </p>
      <p>London time, on the 24-hour clock: for example 1 10 2026, 9 30.</p>
    </>
  )
}

function WritingHelp() {
  return (
    <details>
      <summary>How to write a piece here</summary>
      <p>
        The piece is written in Markdown. A blank line starts a new paragraph. A line starting with # is a
        heading. **Two stars** make bold, *one star* makes italics, and [words](https://address) makes a link.
      </p>
      <p>
        A picture is ![what it shows](https://address &quot;a caption&quot;), on a line of its own; the caption
        is optional. <a href="/modernhaus/upload">Upload a picture</a> to get its address. A video or post
        address on a line of its own is shown as an embed on the full site.
      </p>
      <p>
        {`To charge for part of the piece, put this line where the free part ends: ${PAYWALL_GATE_MARKER} — then
        set a price below. Everything after it is what readers pay for.`}
      </p>
    </details>
  )
}

export function WritePage(props: {
  csrf: string
  values: WriteValues
  draft: WriteDraft
  /** The last press was refused for want of the Writer Agreement. */
  termsRefused?: boolean
  /** Which press met it, so the consent stands in for THAT button (E5). */
  refusedPress?: 'publish' | 'schedule'
  /** The member's Writer Agreement state, for the consent's version. */
  writerTerms?: ViewerTerms
}) {
  const { values, draft } = props
  // THE CONSENT REPLACES THE PRESS IT GATES, and the other paid press is not
  // offered beside it: both would meet the same refusal (web-foundations.md).
  const consentAt = props.termsRefused && props.writerTerms ? (props.refusedPress ?? 'publish') : null
  const consent = (press: 'publish' | 'schedule') =>
    props.writerTerms ? (
      <>
        <p>{WRITER_TERMS_LEAD}</p>
        <TermsConsentBox kind="writer" purpose={TERMS_PURPOSE.sell} state={props.writerTerms} />
        <p>
          <button formAction={`/modernhaus/do/${press === 'publish' ? 'publish_now' : 'schedule'}`}>{TERMS_ACCEPT_AND_CONTINUE}</button>
        </p>
      </>
    ) : null
  const scheduled = draft.scheduledAt !== null
  const publication = draft.publicationId !== null
  const canPublish = !scheduled && !publication
  return (
    <>
      {draft.isEdit && draft.dTag && (
        <p>
          {'You are editing a published piece. '}
          <a href={`/modernhaus/article/${encodeURIComponent(draft.dTag)}`}>Read it as it stands</a>
        </p>
      )}
      {scheduled && (
        <p>
          {'This draft is scheduled to publish on '}
          <Time at={new Date(draft.scheduledAt as string)} />
          {' (London time). Unschedule it below to publish it now or choose another time.'}
        </p>
      )}
      {publication && <p>This draft belongs to a publication. Publish it from the full site.</p>}
      {props.termsRefused && !props.writerTerms && (
        <p>
          <a href="/modernhaus/writer-agreement">Read the Writer Agreement</a>
          {'. Your acceptance could not be asked for here just now; reload to try again, or accept it on the full site. A free piece needs no agreement.'}
        </p>
      )}
      <PostForm action="draft_save" csrf={props.csrf}>
        <Hidden
          values={{
            draftId: draft.draftId,
            dTag: draft.dTag,
            cover: draft.cover,
            emailOffered: canPublish && !draft.isEdit ? '1' : null,
          }}
        />
        <p>
          <label>
            Title
            <br />
            <input type="text" name="title" defaultValue={values.title} size={60} maxLength={500} />
          </label>
        </p>
        <p>
          <label>
            Standfirst (optional)
            <br />
            <textarea name="dek" rows={2} cols={60} maxLength={1000} defaultValue={values.dek} />
          </label>
        </p>
        <p>
          <label>
            The piece
            <br />
            <textarea name="content" rows={24} cols={72} defaultValue={values.content} />
          </label>
        </p>
        <WritingHelp />
        <p>
          <label>
            {'Price of the part after the gate, in pounds '}
            <input type="text" inputMode="decimal" name="price" defaultValue={values.price} size={7} />
          </label>
          {' — only a piece with a gate line is paid for.'}
        </p>
        <p>
          <label>
            <input type="checkbox" name="commentsEnabled" defaultChecked={values.commentsEnabled} />
            {' Allow replies'}
          </label>
        </p>
        <p>
          <button>Save draft</button>
          {draft.draftId && (
            <>
              {' · '}
              <a href={`/modernhaus/preview/${encodeURIComponent(draft.draftId)}`}>Preview the saved draft</a>
            </>
          )}
        </p>
        {canPublish && (
          <fieldset>
            <legend>Publish now</legend>
            <p>
              <label>
                {'Tags, separated by commas (up to five) '}
                <input type="text" name="tags" defaultValue={values.tags} size={40} />
              </label>
            </p>
            {!draft.isEdit && (
              <p>
                <label>
                  <input type="checkbox" name="sendEmail" defaultChecked={values.sendEmail} />
                  {' Email my subscribers about it'}
                </label>
              </p>
            )}
            <p>Tags and the email to subscribers are only sent with Publish now. Saving the draft doesn’t keep them.</p>
            {consentAt === 'publish' ? (
              consent('publish')
            ) : consentAt === null ? (
              <p>
                <button formAction="/modernhaus/do/publish_now">{draft.isEdit ? 'Publish the changes' : 'Publish now'}</button>
              </p>
            ) : null}
          </fieldset>
        )}
        {canPublish && (
          <fieldset>
            <legend>Or publish it later</legend>
            <ScheduleFields values={values.schedule} />
            {consentAt === 'schedule' ? (
              consent('schedule')
            ) : consentAt === null ? (
              <p>
                <button formAction="/modernhaus/do/schedule">Schedule</button>
              </p>
            ) : null}
          </fieldset>
        )}
      </PostForm>
      {scheduled && draft.draftId && (
        <PostForm action="unschedule" csrf={props.csrf}>
          <Hidden values={{ draftId: draft.draftId, return: `/modernhaus/write/${draft.draftId}` }} />
          <p>
            <button>Unschedule</button>
          </p>
        </PostForm>
      )}
      <p>
        <a href="/modernhaus/write/drafts">Your drafts</a>
      </p>
    </>
  )
}

// ---------------------------------------------------------------------------
// The drafts list, a preview and the upload.
// ---------------------------------------------------------------------------

export interface DraftRow {
  draftId: string
  title: string | null
  dTag: string | null
  publicationId: string | null
  autoSavedAt: string
  scheduledAt: string | null
}

export function DraftsPage(props: { csrf: string; drafts: DraftRow[] }) {
  return (
    <>
      <p>
        <a href="/modernhaus/write">Start a new piece</a>
      </p>
      {props.drafts.length === 0 ? (
        <p>You have no drafts.</p>
      ) : (
        <ol>
          {props.drafts.map((d) => (
            <li key={d.draftId}>
              <article>
                <h2>
                  <a href={`/modernhaus/write/${encodeURIComponent(d.draftId)}`}>{d.title?.trim() || 'Untitled'}</a>
                </h2>
                <p>
                  {'Saved '}
                  <Time at={new Date(d.autoSavedAt)} />
                  {d.scheduledAt && (
                    <>
                      {' · scheduled for '}
                      <Time at={new Date(d.scheduledAt)} />
                    </>
                  )}
                  {d.dTag && ' · changes to a published piece'}
                  {d.publicationId && ' · for a publication'}
                </p>
                <PostForm action="unschedule" csrf={props.csrf}>
                  <Hidden values={{ draftId: d.draftId, return: '/modernhaus/write/drafts' }} />
                  <p>
                    <a href={`/modernhaus/preview/${encodeURIComponent(d.draftId)}`}>Preview</a>
                    {' · '}
                    <a
                      href={`/modernhaus/confirm/draft_delete?draftId=${encodeURIComponent(d.draftId)}&return=${encodeURIComponent('/modernhaus/write/drafts')}`}
                    >
                      Delete
                    </a>
                    {d.scheduledAt && (
                      <>
                        {' · '}
                        <button>Unschedule</button>
                      </>
                    )}
                  </p>
                </PostForm>
              </article>
            </li>
          ))}
        </ol>
      )}
    </>
  )
}

export function PreviewPage(props: {
  draftId: string
  title: string
  dek: string | null
  savedAt: string
  byline: string
  freeHtml: string
  /** The part behind the gate, when there is one. */
  paid: { html: string; pricePence: number | null } | null
}) {
  const { paid } = props
  return (
    <>
      <p>
        {'This is a preview of your draft as it was last saved. '}
        <a href={`/modernhaus/write/${encodeURIComponent(props.draftId)}`}>Back to writing</a>
      </p>
      <article>
        <header>
          <h1>{props.title}</h1>
          {props.dek && <p>{props.dek}</p>}
          <p>
            {`By ${props.byline} · saved `}
            <Time at={new Date(props.savedAt)} />
          </p>
        </header>
        <div dangerouslySetInnerHTML={{ __html: props.freeHtml }} />
        {paid && (
          <>
            <h2>
              {paid.pricePence && paid.pricePence > 0
                ? `The gate: readers pay ${formatPrice(paid.pricePence)} to read on`
                : 'The gate — set a price before this piece can publish'}
            </h2>
            <div dangerouslySetInnerHTML={{ __html: paid.html }} />
          </>
        )}
      </article>
    </>
  )
}

export function UploadPage(props: { csrf: string; url?: string | null; refused?: string | null; canWrite?: boolean }) {
  const url = props.url ? safeHttpUrl(props.url) : undefined
  return (
    <>
      {props.refused && <p role="status">{props.refused}</p>}
      {url && (
        <>
          <p>
            <img src={url} alt="The picture you uploaded" loading="lazy" />
          </p>
          <p>To put it in a piece, copy this line into the piece where the picture goes:</p>
          <p>
            <label>
              {'Picture line '}
              <input type="text" readOnly value={`![](${url})`} size={80} />
            </label>
          </p>
          <p>
            {'Its address: '}
            <a href={url}>{url}</a>
          </p>
        </>
      )}
      <PostForm action="upload" csrf={props.csrf} multipart>
        <p>
          <label>
            {url ? 'Upload another ' : 'A picture: JPEG, PNG, GIF or WebP '}
            <input type="file" name="file" accept={IMAGE_TYPES} required />
          </label>
        </p>
        <p>
          <button>Upload</button>
        </p>
      </PostForm>
      {props.canWrite === true && (
        <p>
          <a href="/modernhaus/write">Write a piece</a>
        </p>
      )}
    </>
  )
}

/** The paid part of a draft could not be read, so editing it here would lose it. */
export function PaidHalfUnavailable() {
  return <Unavailable what="The paid part of this piece" />
}
