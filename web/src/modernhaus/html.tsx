import { Fragment, type ReactNode } from 'react'
import { CSRF_FIELD } from './csrf'
import type { Outcome } from './outcomes'
import { DOB_LABEL, DOB_DAY, DOB_MONTH, DOB_YEAR, DOB_HINT, LINK_SIGN_OUT } from '../content/auth'

// =============================================================================
// modernhaus — the shell and the few primitives (MODERNHAUS-ADR §D2.2, §D2.6).
//
// Plain elements in browser defaults. No `style`, no `class`, no script, no
// event handler: D1.9's sweep renders every page and fails on any of them.
// Only the elements §D2.6 lists appear in modernhaus's own markup.
// =============================================================================

/** The signed-in member, as the shell knows them from `/auth/me`. */
export interface Viewer {
  id: string
  username: string | null
  displayName: string | null
  ageDeclaredAt: string | null
  /** The member's Nostr pubkey — what "your own post" is decided by. */
  pubkey?: string | null
  /** The money facts `/auth/me` carries (E5). Absent when the payload did not
   *  carry them in the shape expected: a page then says it could not tell,
   *  never assumes "no card" (an outage is not an empty state). */
  money?: ViewerMoney
  /** Which legal texts this member has accepted, and which are current. */
  terms?: { reader: ViewerTerms; writer: ViewerTerms }
  /** May this member publish articles and sell access (READER-WRITER-SPLIT-ADR)?
   *  Only `true` counts: absent or anything else is a reader, so a payload
   *  that stopped carrying it offers no writing control. */
  canWrite?: boolean
  /** A reader's pending application to write, off `/auth/me`. */
  writerApplication?: { appliedAt: string } | null
}

export interface ViewerMoney {
  hasPaymentMethod: boolean
  /** Non-null ⇒ a settlement declined and the tab is frozen (CardActionRequired). */
  cardActionRequiredAt: string | null
  freeAllowanceRemainingPence: number
  stripeConnectKycComplete: boolean
}

/** `TermsState` off `/auth/me`; `isCurrent` is the SERVER's comparison, never ours. */
export interface ViewerTerms {
  version: string | null
  current: string
  isCurrent: boolean
}

/** The nav's two counts (`GET /unread-counts`). Null when the read failed:
 *  the links then carry NO count, never "(0)" (§D2.2). */
export interface UnreadCounts {
  notifications: number
  messages: number
}

/** One link in the nav. Sign-out is a POST button, rendered beside them. */
export interface NavLink {
  label: string
  href: string
}

/**
 * The nav, in §D2.2's order, holding only pages that exist by this step: a
 * link to a page that is not built yet is a button that cannot do its job.
 * Each step appends what it ships.
 */
export function navLinks(
  viewer: Viewer | null | 'unknown',
  twin: string | null,
  counts: UnreadCounts | null = null,
): NavLink[] {
  // Signed in, the home IS the feed index (§D2.9 Q2), so it is called Feeds.
  const links: NavLink[] = [
    { label: viewer && viewer !== 'unknown' ? 'Channels' : 'all.haus', href: '/modernhaus' },
  ]
  // The fault page does not know who is looking, and must not dress itself as
  // either shell — a signed-out nav there would say "you are logged out" about
  // a fault of ours (root CLAUDE.md).
  if (viewer === 'unknown') return links
  if (viewer) {
    links.push({ label: 'Write', href: '/modernhaus/compose' })
    const n = counts?.notifications
    links.push({
      label: n !== undefined && n > 0 ? `Notifications (${n})` : 'Notifications',
      href: '/modernhaus/notifications',
    })
    const m = counts?.messages
    links.push({ label: m !== undefined && m > 0 ? `Messages (${m})` : 'Messages', href: '/modernhaus/messages' })
    links.push({ label: 'Ledger', href: '/modernhaus/ledger' })
    links.push({ label: 'Library', href: '/modernhaus/library' })
    // A reader has no dashboard; Settings links to what stands in its place.
    if (viewer.canWrite === true) links.push({ label: 'Dashboard', href: '/modernhaus/dashboard' })
  }
  if (viewer?.username) links.push({ label: 'Profile', href: `/modernhaus/u/${encodeURIComponent(viewer.username)}` })
  if (viewer) links.push({ label: 'Settings', href: '/modernhaus/settings' })
  links.push({ label: 'Search', href: '/modernhaus/search' })
  if (!viewer) {
    links.push({ label: 'Sign in', href: '/modernhaus/signin' })
    links.push({ label: 'About', href: '/modernhaus/about' })
  }
  return links
}

export function Document(props: {
  title: string
  /** `'unknown'` only on the fault page, where `/auth/me` itself may be what failed. */
  viewer: Viewer | null | 'unknown'
  /** The same page on the full site, where there is one. */
  twin: string | null
  outcome: Outcome | null
  /** The viewer's CSRF token, for the nav's sign-out form. Absent on the
   *  fault page, which knows no viewer and so offers no sign-out. */
  csrf?: string
  /** False for pages whose body carries its own `<h1>` (an article). */
  heading?: boolean
  /** The nav's counts, for a member; null or absent renders no count. */
  counts?: UnreadCounts | null
  children: ReactNode
}) {
  return (
    <html lang="en-GB">
      <head>
        <meta charSet="utf-8" />
        <meta name="viewport" content="width=device-width" />
        <title>{`${props.title} — all.haus`}</title>
      </head>
      <body>
        <header>
          <nav>
            <ul>
              {navLinks(props.viewer, props.twin, props.counts ?? null).map((l) => (
                <li key={l.href}>
                  <a href={l.href}>{l.label}</a>
                </li>
              ))}
              {props.viewer && props.viewer !== 'unknown' && props.csrf && (
                <li>
                  <PostForm action="signout" csrf={props.csrf}>
                    <button>{LINK_SIGN_OUT}</button>
                  </PostForm>
                </li>
              )}
              {props.twin && props.viewer !== 'unknown' && (
                <li>
                  <a href={props.twin}>Full site</a>
                </li>
              )}
            </ul>
          </nav>
        </header>
        <main>
          {props.heading !== false && <h1>{props.title}</h1>}
          {props.outcome && <p role="status">{props.outcome.sentence}</p>}
          {props.children}
        </main>
      </body>
    </html>
  )
}

/**
 * The ONLY way to write a POST form: it always carries the CSRF field, and it
 * always targets the one door.
 */
export function PostForm(props: { action: string; csrf: string; multipart?: boolean; children: ReactNode }) {
  return (
    <form
      method="post"
      action={`/modernhaus/do/${props.action}`}
      encType={props.multipart ? 'multipart/form-data' : undefined}
    >
      <input type="hidden" name={CSRF_FIELD} value={props.csrf} />
      {props.children}
    </form>
  )
}

/** Hidden inputs for the defined values only. */
export function Hidden(props: { values: Record<string, string | null | undefined> }) {
  return (
    <>
      {Object.entries(props.values).map(([name, value]) =>
        value === null || value === undefined ? null : <input key={name} type="hidden" name={name} value={value} />,
      )}
    </>
  )
}

const DATE_TIME = new Intl.DateTimeFormat('en-GB', {
  day: 'numeric',
  month: 'short',
  year: 'numeric',
  hour: '2-digit',
  minute: '2-digit',
  hourCycle: 'h23',
  timeZone: 'Europe/London',
})

const DATE_ONLY = new Intl.DateTimeFormat('en-GB', {
  day: 'numeric',
  month: 'long',
  year: 'numeric',
  timeZone: 'Europe/London',
})

/** A moment, in en-GB and London time — the one zone modernhaus speaks (§D2.9). */
export function Time(props: { at: Date; dateOnly?: boolean }) {
  if (Number.isNaN(props.at.getTime())) return null
  const text = (props.dateOnly ? DATE_ONLY : DATE_TIME).format(props.at)
  return <time dateTime={props.at.toISOString()}>{text}</time>
}

export function fromUnix(seconds: number): Date {
  return new Date(seconds * 1000)
}

/** "Older" and friends: one paragraph, one link, `rel="next"`. */
export function NextLink(props: { href: string | null; label?: string }) {
  if (!props.href) return null
  return (
    <p>
      <a href={props.href} rel="next">
        {props.label ?? 'Older'}
      </a>
    </p>
  )
}

/** A section a secondary read could not fill: said as an outage, never as empty. */
export function Unavailable(props: { what: string }) {
  return <p>{`${props.what} couldn’t be loaded just now. Please reload the page to try again.`}</p>
}

/** Plain text as paragraphs, split on blank lines, line breaks kept. */
export function TextParagraphs(props: { text: string; linkify?: boolean }) {
  const paras = props.text.split(/\n{2,}/).filter((p) => p.trim() !== '')
  return (
    <>
      {paras.map((p, i) => (
        <p key={i}>
          {p.split('\n').map((line, j) => (
            <Fragment key={j}>
              {j > 0 && <br />}
              {props.linkify ? <Linkified text={line} /> : line}
            </Fragment>
          ))}
        </p>
      ))}
    </>
  )
}

const URL_RE = /https?:\/\/[^\s<]+/g

/** Bare http(s) URLs in a line of text, as links. Never used for a DM. */
function Linkified(props: { text: string }) {
  const out: ReactNode[] = []
  let last = 0
  for (const m of props.text.matchAll(URL_RE)) {
    const start = m.index ?? 0
    // Trailing punctuation belongs to the sentence, not the address.
    const url = m[0].replace(/[.,;:!?)\]]+$/, '')
    if (start > last) out.push(props.text.slice(last, start))
    out.push(
      <a key={start} href={url} target="_blank" rel="noopener noreferrer">
        {url}
      </a>,
    )
    last = start + url.length
  }
  if (last < props.text.length) out.push(props.text.slice(last))
  return <>{out}</>
}

/** The three boxes' values, for a form re-rendered with what was typed. */
export interface DateOfBirthValues {
  day: string
  month: string
  year: string
}

export const EMPTY_DOB: DateOfBirthValues = { day: '', month: '', year: '' }

/**
 * The date of birth as three labelled boxes, Day / Month / Year — never a
 * native date picker, whose order the browser chooses (web-foundations.md,
 * *Dates are British*). The boxes post as `dob_day`, `dob_month`, `dob_year`;
 * `assembleDateOfBirth` joins them, and the gateway judges the result.
 */
export function DateOfBirthBoxes(props: { values: DateOfBirthValues }) {
  const box = (name: string, label: string, value: string, maxLength: number, autoComplete: string) => (
    <label>
      {`${label} `}
      <input
        type="text"
        inputMode="numeric"
        name={name}
        defaultValue={value}
        maxLength={maxLength}
        size={maxLength}
        autoComplete={autoComplete}
        aria-describedby="dob-hint"
        required
      />
    </label>
  )
  return (
    <fieldset>
      <legend>{DOB_LABEL}</legend>
      <p>
        {box('dob_day', DOB_DAY, props.values.day, 2, 'bday-day')}{' '}
        {box('dob_month', DOB_MONTH, props.values.month, 2, 'bday-month')}{' '}
        {box('dob_year', DOB_YEAR, props.values.year, 4, 'bday-year')}
      </p>
      <p id="dob-hint">{DOB_HINT}</p>
    </fieldset>
  )
}
