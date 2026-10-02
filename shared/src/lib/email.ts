import logger from '../lib/logger.js'
import { notePostmarkResponse, trackSend } from './email-health.js'
import { requireEnv } from './env.js'
import { renderEmail } from './email/layout.js'
import {
  keyExportNoticeEmail,
  keyExportStepUpEmail,
  magicLinkEmail,
} from './email/templates/auth.js'
import { waitlistInviteEmail, writerAccessGrantedEmail } from './email/templates/waitlist.js'

// =============================================================================
// Email Service
//
// The TRANSPORT: sends transactional and broadcast email. What an email SAYS
// and how it LOOKS is `./email/` — a template per family under
// `./email/templates/`, one layout in `./email/layout.ts`. Nothing here or in
// any caller writes an email's markup by hand.
//
// Provider selection via EMAIL_PROVIDER env var:
//   - 'postmark'  → Postmark API (recommended for transactional)
//   - 'resend'    → Resend API
//   - 'console'   → Logs to stdout (dev default)
//
// In dev, EMAIL_PROVIDER defaults to 'console' so magic link tokens appear
// in the terminal. In production, set EMAIL_PROVIDER and the relevant API key.
//
// EVERY SEND GOES THROUGH `trackSend`, and the two Postmark paths additionally
// report their HTTP status to `notePostmarkResponse`. Both belong to
// `email-health.ts` — read its header for why: for seventeen days in 2026 every
// send here threw, every caller caught it, and no surface anywhere carried the
// fact. A send is also the best possible test of the credential it uses, so its
// own response is fed back as proof rather than being thrown away with the
// error. New send paths must be wrapped the same way; an unwrapped one is
// invisible on the admin overview, which is where this is now read.
// =============================================================================

interface EmailParams {
  to: string
  subject: string
  textBody: string
  htmlBody: string
  /** From `renderEmail` — `List-Unsubscribe` and its one-click partner. */
  headers?: Record<string, string>
}

function postmarkHeaders(params: EmailParams): { Headers?: Array<{ Name: string; Value: string }> } {
  if (!params.headers) return {}
  return { Headers: Object.entries(params.headers).map(([Name, Value]) => ({ Name, Value })) }
}

// UNSET AND EXPLICITLY `console` ARE DIFFERENT FACTS, and only the first is a
// deployment that never chose anything. `console` sends nothing and prints the
// magic link, so a production process that reached this default has every
// login link going to a log file — the outage `email-health.ts` exists to make
// visible, arriving before a single send has been attempted. It is a WARN and
// not a throw for that module's own reason: email dying must not take reading
// and auth down with it. Once, because it is a fact about the process.
let warnedProviderUnset = false
function resolveProvider(): string {
  const configured = process.env.EMAIL_PROVIDER
  if (!configured && !warnedProviderUnset) {
    warnedProviderUnset = true
    logger.warn(
      { provider: 'console' },
      'EMAIL_PROVIDER is not set, so nothing is being emailed: every magic link, receipt and notification is being written to this log instead. Expected in dev; in production set EMAIL_PROVIDER and the matching API key.',
    )
  }
  return configured ?? 'console'
}

/**
 * Can a send here reach anybody? `console` resolves normally and delivers
 * nothing, so a caller that stamps a record on "the send did not throw" is
 * recording a delivery that did not happen. Most sends do not care — a lost
 * receipt is a lesser harm than a blocked read — but a notice that is the
 * PRECONDITION of something being taken away (the unpayable withdrawal, Writer
 * 9.3) must ask this before it counts itself sent (§0z item 7). A provider
 * whose credential is missing still answers true here: its send THROWS, which
 * the caller already treats as not sent.
 */
export function emailDeliverable(): boolean {
  return resolveProvider() !== 'console'
}

export async function sendEmail(params: EmailParams): Promise<void> {
  const provider = resolveProvider()

  return trackSend(() => {
    switch (provider) {
      case 'postmark':
        return sendViaPostmark(params)
      case 'resend':
        return sendViaResend(params)
      case 'console':
      default:
        return sendViaConsole(params)
    }
  })
}

// ---------------------------------------------------------------------------
// Magic link — the one email every member depends on
// ---------------------------------------------------------------------------

/**
 * `arrivalDTag` carries a paywall-arrival intent through the ONE auth terminus
 * that may be opened on a different device (PAYWALL-ARRIVAL-ADR §5). It is the
 * article's IDENTIFIER, never a path or a URL: `/auth/verify` reconstructs
 * `/article/<dTag>` from it rather than navigating to a string it was handed,
 * which is what keeps an emailed value out of the classic open-redirect shape.
 *
 * `surface` says WHICH verify page the link opens, for the same reason: it is
 * a closed identifier, never a path. `'modernhaus'` is the no-script register
 * (MODERNHAUS-ADR §D1.8.1), whose verify page renders a button rather than
 * spending the token on a page load.
 */
export type MagicLinkSurface = 'modernhaus'

export function magicLinkUrl(
  appUrl: string,
  token: string,
  arrivalDTag: string | null,
  surface: MagicLinkSurface | null,
): string {
  const verifyPath = surface === 'modernhaus' ? '/modernhaus/auth/verify' : '/auth/verify'
  return (
    `${appUrl}${verifyPath}?token=${encodeURIComponent(token)}` +
    (arrivalDTag ? `&arrival=${encodeURIComponent(arrivalDTag)}` : '')
  )
}

export async function sendMagicLinkEmail(
  to: string,
  token: string,
  expiresAt: Date,
  arrivalDTag: string | null = null,
  surface: MagicLinkSurface | null = null
): Promise<void> {
  const verifyUrl = magicLinkUrl(requireEnv('APP_URL'), token, arrivalDTag, surface)
  const expiresInMinutes = Math.round((expiresAt.getTime() - Date.now()) / 60000)

  await sendEmail({ to, ...renderEmail(magicLinkEmail({ verifyUrl, expiresInMinutes })) })
}

// ---------------------------------------------------------------------------
// Key export — the step-up, and the notice (MIRROR-AUDIT §2.6)
//
// Two emails, and the second is the one that matters most. The export ships the
// account's root Nostr secret key, which IS the identity and cannot be rotated,
// so a session compromise was a permanent one and nothing anywhere recorded
// that it had happened.
//
// The step-up is a CONFIRMATION, never a refusal: the export is mandated by the
// custodial-identity rule, so nothing here may become a way to withhold a
// member's own key from them. The notice is unconditional and goes out on the
// EXPORT, not on the request — an attacker holding the session may well hold
// the inbox too, but the notice is what turns a silent theft into a dated event
// the member can point at.
// ---------------------------------------------------------------------------

export async function sendKeyExportStepUpEmail(
  to: string,
  token: string,
  expiresAt: Date
): Promise<void> {
  const appUrl = requireEnv('APP_URL')
  // Same rule as the magic link: the email carries an IDENTIFIER and the page
  // builds the path, never a URL handed over for the browser to follow.
  const confirmUrl = `${appUrl}/account/export?token=${encodeURIComponent(token)}`
  const expiresInMinutes = Math.round((expiresAt.getTime() - Date.now()) / 60000)

  await sendEmail({ to, ...renderEmail(keyExportStepUpEmail({ confirmUrl, expiresInMinutes })) })
}

export async function sendKeyExportNoticeEmail(
  to: string,
  exportedAt: Date
): Promise<void> {
  await sendEmail({ to, ...renderEmail(keyExportNoticeEmail({ exportedAt })) })
}

// ---------------------------------------------------------------------------
// Waitlist invitation — "we're ready for you now" (CLOSED-BETA-ADR §XI, D8)
//
// Sent once, by the operator's Admit action, after the account exists. It is
// the third of the section's three emails and the only one that is a reply to
// a specific human decision about a specific person.
//
// IT CARRIES NO LOGIN TOKEN, ON PURPOSE. A magic link expires in 15 minutes
// (TOKEN_EXPIRY_MINUTES, shared/auth/magic-links.ts) and an invitation is read
// hours or days after it lands — so an embedded link would be dead on arrival
// for almost everyone who received it, and its most likely observable is a
// prospect clicking "log in", being told the link is invalid, and concluding
// the invitation was a mistake. It points at the login page instead and names
// the address to enter; the link they need is the one they ask for, seconds
// before they use it. That also keeps a long-lived credential out of an inbox
// we don't control.
//
// TRANSACTIONAL STREAM, NOT BROADCAST. The ADR flags this one as "arguably
// bulk", and it would be if it were a cohort blast. It isn't: it is one message
// per operator click, to a named person, in response to their own request to
// join — which is what the transactional stream is for. If admission ever
// becomes a batch action over a selected cohort, that is the point to move it
// to the broadcast stream, and DEPLOYMENT.md records that a new one wants 2–4
// weeks of warming before it carries real volume.
// ---------------------------------------------------------------------------

export async function sendWaitlistInviteEmail(to: string): Promise<void> {
  const appUrl = requireEnv('APP_URL')
  const loginUrl = `${appUrl}/auth`

  await sendEmail({ to, ...renderEmail(waitlistInviteEmail({ to, loginUrl })) })
}

/** "You can now publish" — after a writer-access grant commits. */
export async function sendWriterAccessGrantedEmail(to: string): Promise<void> {
  const appUrl = requireEnv('APP_URL')
  await sendEmail({ to, ...renderEmail(writerAccessGrantedEmail({ writeUrl: `${appUrl}/write` })) })
}

// ---------------------------------------------------------------------------
// Broadcast email — for publish notifications (separate Postmark stream)
// ---------------------------------------------------------------------------

interface BroadcastEmailParams extends EmailParams {
  /** Override the From address (defaults to EMAIL_FROM_BROADCAST) */
  from?: string
}

export async function sendBroadcastEmail(params: BroadcastEmailParams): Promise<void> {
  const provider = resolveProvider()

  return trackSend(() => {
    switch (provider) {
      case 'postmark':
        return sendBroadcastViaPostmark(params)
      case 'resend':
        return sendViaResend(params) // Resend has no separate broadcast concept
      case 'console':
      default:
        return sendBroadcastViaConsole(params)
    }
  })
}

// =============================================================================
// Provider implementations
// =============================================================================

async function sendViaPostmark(params: EmailParams): Promise<void> {
  const apiKey = process.env.POSTMARK_API_KEY
  if (!apiKey) throw new Error('POSTMARK_API_KEY not set')

  const fromAddress = process.env.EMAIL_FROM ?? 'login@all.haus'

  const res = await fetch('https://api.postmarkapp.com/email', {
    method: 'POST',
    headers: {
      'Accept': 'application/json',
      'Content-Type': 'application/json',
      'X-Postmark-Server-Token': apiKey,
    },
    body: JSON.stringify({
      From: fromAddress,
      To: params.to,
      Subject: params.subject,
      TextBody: params.textBody,
      HtmlBody: params.htmlBody,
      ...postmarkHeaders(params),
      MessageStream: 'outbound',
    }),
  })

  if (!res.ok) {
    const body = await res.text()
    // The send's own answer is the freshest evidence there is about the token —
    // a 401 here is the incident, caught on its first occurrence instead of at
    // the next probe. Ambiguous statuses are ignored by the classifier.
    notePostmarkResponse(res.status, body)
    logger.error({ status: res.status, body }, 'Postmark email failed')
    throw new Error(`Postmark API error: ${res.status}`)
  }

  notePostmarkResponse(res.status)
  logger.info({ to: params.to, subject: params.subject }, 'Email sent via Postmark')
}

async function sendViaResend(params: EmailParams): Promise<void> {
  const apiKey = process.env.RESEND_API_KEY
  if (!apiKey) throw new Error('RESEND_API_KEY not set')

  const fromAddress = process.env.EMAIL_FROM ?? 'login@all.haus'

  const res = await fetch('https://api.resend.com/emails', {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${apiKey}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      from: fromAddress,
      to: [params.to],
      subject: params.subject,
      text: params.textBody,
      html: params.htmlBody,
      ...(params.headers ? { headers: params.headers } : {}),
    }),
  })

  if (!res.ok) {
    const body = await res.text()
    logger.error({ status: res.status, body }, 'Resend email failed')
    throw new Error(`Resend API error: ${res.status}`)
  }

  logger.info({ to: params.to, subject: params.subject }, 'Email sent via Resend')
}

async function sendViaConsole(params: EmailParams): Promise<void> {
  logger.info(
    {
      to: params.to,
      subject: params.subject,
      body: params.textBody,
    },
    '📧 Email (console provider — dev mode)'
  )
}

async function sendBroadcastViaPostmark(params: BroadcastEmailParams): Promise<void> {
  const apiKey = process.env.POSTMARK_API_KEY
  if (!apiKey) throw new Error('POSTMARK_API_KEY not set')

  const fromAddress = params.from ?? process.env.EMAIL_FROM_BROADCAST ?? 'posts@all.haus'
  const stream = process.env.POSTMARK_BROADCAST_STREAM ?? 'broadcast'

  const res = await fetch('https://api.postmarkapp.com/email', {
    method: 'POST',
    headers: {
      'Accept': 'application/json',
      'Content-Type': 'application/json',
      'X-Postmark-Server-Token': apiKey,
    },
    body: JSON.stringify({
      From: fromAddress,
      To: params.to,
      Subject: params.subject,
      TextBody: params.textBody,
      HtmlBody: params.htmlBody,
      ...postmarkHeaders(params),
      MessageStream: stream,
    }),
  })

  if (!res.ok) {
    const body = await res.text()
    // Same token, same evidence — the broadcast stream is a MessageStream on the
    // same server, so a rejection here says exactly what one on the transactional
    // path says.
    notePostmarkResponse(res.status, body)
    logger.error({ status: res.status, body }, 'Postmark broadcast email failed')
    throw new Error(`Postmark API error: ${res.status}`)
  }

  notePostmarkResponse(res.status)
  logger.info({ to: params.to, subject: params.subject, stream }, 'Broadcast email sent via Postmark')
}

async function sendBroadcastViaConsole(params: BroadcastEmailParams): Promise<void> {
  logger.info(
    {
      to: params.to,
      subject: params.subject,
      body: params.textBody,
    },
    '📧 Broadcast email (console provider — dev mode)'
  )
}
