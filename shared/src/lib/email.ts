import logger from '../lib/logger.js'
import { notePostmarkResponse, trackSend } from './email-health.js'

// =============================================================================
// Email Service
//
// Sends transactional emails. At launch, the only email is the magic link.
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
}

export async function sendEmail(params: EmailParams): Promise<void> {
  const provider = process.env.EMAIL_PROVIDER ?? 'console'

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
// Magic link email — the specific email template
// ---------------------------------------------------------------------------

export async function sendMagicLinkEmail(
  to: string,
  token: string,
  expiresAt: Date
): Promise<void> {
  const appUrl = process.env.APP_URL ?? 'http://localhost:3000'
  const verifyUrl = `${appUrl}/auth/verify?token=${encodeURIComponent(token)}`
  const expiresInMinutes = Math.round((expiresAt.getTime() - Date.now()) / 60000)

  await sendEmail({
    to,
    subject: 'Your all.haus login link',
    textBody: [
      'Click this link to log in to all.haus:',
      '',
      verifyUrl,
      '',
      `This link expires in ${expiresInMinutes} minutes.`,
      '',
      'If you didn\'t request this, you can ignore this email.',
    ].join('\n'),
    htmlBody: `
      <div style="font-family: -apple-system, system-ui, sans-serif; max-width: 480px; margin: 0 auto; padding: 32px 0;">
        <h2 style="font-size: 20px; font-weight: 600; color: #1c1917; margin-bottom: 16px;">
          Log in to all.haus
        </h2>
        <p style="font-size: 15px; color: #57534e; line-height: 1.6; margin-bottom: 24px;">
          Click the button below to log in. This link expires in ${expiresInMinutes} minutes.
        </p>
        <a href="${verifyUrl}"
           style="display: inline-block; background: #1c1917; color: #ffffff; font-size: 14px; font-weight: 500; padding: 12px 28px; border-radius: 6px; text-decoration: none;">
          Log in
        </a>
        <p style="font-size: 13px; color: #a8a29e; margin-top: 32px; line-height: 1.5;">
          If you didn't request this email, you can safely ignore it.
        </p>
        <p style="font-size: 12px; color: #d6d3d1; margin-top: 24px;">
          all.haus — writing worth reading
        </p>
      </div>
    `.trim(),
  })
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
  const appUrl = process.env.APP_URL ?? 'http://localhost:3000'
  const loginUrl = `${appUrl}/auth`

  await sendEmail({
    to,
    // The page promises "we'll write when we're ready for you", so this is the
    // sentence that keeps it. Changed together on 2026-07-27 — if the page's
    // wording moves again, move this with it: a promise and its fulfilment
    // reading differently is how a real message starts to sound like a template.
    subject: "We're ready for you on all.haus",
    textBody: [
      "You asked to be told when we were ready for you on all.haus. We are.",
      '',
      `Your account is ready. Log in at ${loginUrl} with this address (${to})`,
      'and we will email you a link to get in — no password to remember.',
      '',
      'all.haus is a place to read and write without an algorithm deciding what',
      'you see. You build your own feeds, from here and from anywhere else you',
      'already read.',
      '',
      "We're still small and still fixing things. If something is broken or",
      'wrong, reply to this email — it reaches a person.',
    ].join('\n'),
    htmlBody: `
      <div style="font-family: -apple-system, system-ui, sans-serif; max-width: 480px; margin: 0 auto; padding: 32px 0;">
        <h2 style="font-size: 20px; font-weight: 600; color: #1c1917; margin-bottom: 16px;">
          We're ready for you on all.haus
        </h2>
        <p style="font-size: 15px; color: #57534e; line-height: 1.6; margin-bottom: 24px;">
          You asked to be told when we were ready for you. We are — your account is
          ready. Log in with this address (<strong>${to}</strong>) and we'll email you a link
          to get in. There's no password to remember.
        </p>
        <a href="${loginUrl}"
           style="display: inline-block; background: #1c1917; color: #ffffff; font-size: 14px; font-weight: 500; padding: 12px 28px; border-radius: 6px; text-decoration: none;">
          Log in
        </a>
        <p style="font-size: 15px; color: #57534e; line-height: 1.6; margin-top: 32px;">
          all.haus is a place to read and write without an algorithm deciding what you
          see. You build your own feeds, from here and from anywhere else you already read.
        </p>
        <p style="font-size: 13px; color: #a8a29e; margin-top: 32px; line-height: 1.5;">
          We're still small and still fixing things. If something is broken or wrong,
          reply to this email — it reaches a person.
        </p>
        <p style="font-size: 12px; color: #d6d3d1; margin-top: 24px;">
          all.haus — writing worth reading
        </p>
      </div>
    `.trim(),
  })
}

// ---------------------------------------------------------------------------
// Broadcast email — for publish notifications (separate Postmark stream)
// ---------------------------------------------------------------------------

interface BroadcastEmailParams extends EmailParams {
  /** Override the From address (defaults to EMAIL_FROM_BROADCAST) */
  from?: string
}

export async function sendBroadcastEmail(params: BroadcastEmailParams): Promise<void> {
  const provider = process.env.EMAIL_PROVIDER ?? 'console'

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
