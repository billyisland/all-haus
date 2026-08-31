import { describe, it, expect, vi, beforeEach } from 'vitest'

// =============================================================================
// The subscription welcome email (§4.2, migration 180).
//
// Two halves, tested differently. `welcomeParagraphs` and `defaultWelcomeText`
// are pure and are driven directly. `sendSubscriptionWelcomeEmail` needs the
// DB and the sender, so both are mocked — and per the repo's standing rule the
// mocked `pool.query` must ANSWER FROM WHAT IT IS HANDED rather than return a
// fixture regardless.
//
// Here that means the PARAMS, not the SQL, and finding out cost a mutation.
// The function issues two SELECTs against `accounts` — the reader's contact
// details, then the writer's row carrying the message — and they differ only in
// their column list and their id. Keying the mock off "does the SQL name the
// message column" answers with the writer's row *whichever id was passed*, so
// transposing the two ids in the function under test left all fifteen tests
// green, including the one written to catch exactly that. Keyed by id, the same
// mutation fails. The rule's own warning, arriving against the test that quoted
// it.
// =============================================================================

const sendEmail = vi.fn(async () => {})
const query = vi.fn()

vi.mock('../src/lib/email.js', () => ({ sendEmail: (...a: unknown[]) => sendEmail(...(a as [])) }))
vi.mock('../src/db/client.js', () => ({ pool: { query: (...a: unknown[]) => query(...(a as [])) } }))

const {
  welcomeParagraphs,
  defaultWelcomeText,
  sendSubscriptionWelcomeEmail,
} = await import('../src/lib/subscription-emails.js')

type WriterRow = {
  email: string | null
  display_name: string | null
  username: string
  subscription_welcome_message: string | null
}

const READER_ID = 'reader-id'
const WRITER_ID = 'writer-id'

/**
 * Answer from the PARAMS, not from the SQL text.
 *
 * Dispatching on the SQL alone was the first version of this and it was
 * useless for the question that matters most here: both statements select
 * `FROM accounts WHERE id = $1`, so keying off "does the SQL name the message
 * column" returns the writer's row *whichever id was passed*. Transposing the
 * two ids in the function under test left all fifteen tests green — the mock
 * was answering the test's question instead of the query's. Keyed by id, the
 * same mutation fails, which is the only reason to trust the last case below.
 *
 * Rows are handed out as COPIES, never the live fixture objects.
 */
function stubAccounts(reader: Partial<WriterRow> | null, writer: WriterRow | null) {
  query.mockImplementation(async (sql: string, params: unknown[]) => {
    if (!/FROM accounts/.test(sql)) throw new Error(`unexpected SQL: ${sql}`)
    const id = params?.[0]
    if (id === WRITER_ID) return { rows: writer ? [{ ...writer }] : [] }
    if (id === READER_ID) return { rows: reader ? [{ ...reader }] : [] }
    throw new Error(`unexpected account id: ${String(id)}`)
  })
}

const READER = { email: 'reader@example.com', display_name: 'A Reader', username: 'areader' }
const WRITER: WriterRow = {
  email: 'writer@example.com',
  display_name: 'A Writer',
  username: 'awriter',
  subscription_welcome_message: null,
}

beforeEach(() => {
  sendEmail.mockClear()
  query.mockReset()
})

// ---------------------------------------------------------------------------

describe('welcomeParagraphs', () => {
  it('escapes HTML in the writer’s message', () => {
    const out = welcomeParagraphs('<script>alert(1)</script>')
    expect(out).not.toContain('<script>')
    expect(out).toContain('&lt;script&gt;')
  })

  it('splits on blank lines into separate paragraphs', () => {
    const out = welcomeParagraphs('First para.\n\nSecond para.')
    expect(out.match(/<p /g)).toHaveLength(2)
    expect(out).toContain('First para.')
    expect(out).toContain('Second para.')
  })

  it('keeps a single newline as a line break, so a list does not run together', () => {
    const out = welcomeParagraphs('one\ntwo\nthree')
    expect(out.match(/<p /g)).toHaveLength(1)
    expect(out).toContain('one<br>two<br>three')
  })

  it('treats three or more newlines as one break, not as empty paragraphs', () => {
    const out = welcomeParagraphs('a\n\n\n\nb')
    expect(out.match(/<p /g)).toHaveLength(2)
  })

  it('normalises CRLF, so a message pasted from a mail client is not doubled', () => {
    const out = welcomeParagraphs('a\r\n\r\nb')
    expect(out.match(/<p /g)).toHaveLength(2)
    expect(out).not.toContain('\r')
  })

  it('drops whitespace-only paragraphs', () => {
    expect(welcomeParagraphs('a\n\n   \n\nb').match(/<p /g)).toHaveLength(2)
  })
})

describe('defaultWelcomeText', () => {
  it('names the writer', () => {
    expect(defaultWelcomeText('A Writer')).toContain('A Writer')
  })
})

// ---------------------------------------------------------------------------

describe('sendSubscriptionWelcomeEmail', () => {
  it('sends the writer’s own message when they have set one', async () => {
    stubAccounts(READER, { ...WRITER, subscription_welcome_message: 'Hello from me.' })
    await sendSubscriptionWelcomeEmail(READER_ID, WRITER_ID)

    expect(sendEmail).toHaveBeenCalledTimes(1)
    const sent = sendEmail.mock.calls[0][0] as { to: string; subject: string; textBody: string; htmlBody: string }
    expect(sent.to).toBe('reader@example.com')
    expect(sent.subject).toBe("You're subscribed to A Writer")
    expect(sent.textBody).toContain('Hello from me.')
    expect(sent.htmlBody).toContain('Hello from me.')
    // and NOT the default
    expect(sent.textBody).not.toContain('Thanks for subscribing')
  })

  it('falls back to the default when the writer has never set one', async () => {
    stubAccounts(READER, { ...WRITER, subscription_welcome_message: null })
    await sendSubscriptionWelcomeEmail(READER_ID, WRITER_ID)

    const sent = sendEmail.mock.calls[0][0] as { textBody: string }
    expect(sent.textBody).toContain('Thanks for subscribing to A Writer')
  })

  it('falls back to the default when the box was cleared to whitespace', async () => {
    stubAccounts(READER, { ...WRITER, subscription_welcome_message: '   \n  ' })
    await sendSubscriptionWelcomeEmail(READER_ID, WRITER_ID)

    const sent = sendEmail.mock.calls[0][0] as { textBody: string }
    expect(sent.textBody).toContain('Thanks for subscribing to A Writer')
  })

  it('escapes the writer’s display name in the button label', async () => {
    // `button()` interpolates its label RAW, so an unescaped name here is an
    // injection into every subscriber's inbox. Mutation-proof: drop the
    // escapeHtml around the label and this is the assertion that fails.
    stubAccounts(READER, {
      ...WRITER,
      display_name: '<img src=x onerror=alert(1)>',
      subscription_welcome_message: 'hi',
    })
    await sendSubscriptionWelcomeEmail(READER_ID, WRITER_ID)

    const sent = sendEmail.mock.calls[0][0] as { htmlBody: string; subject: string }
    expect(sent.htmlBody).not.toContain('<img src=x')
    expect(sent.htmlBody).toContain('&lt;img')
    // the subject is plain text and carries the name unescaped, by design
    expect(sent.subject).toContain('<img src=x onerror=alert(1)>')
  })

  it('links to the writer’s profile by username', async () => {
    stubAccounts(READER, { ...WRITER, subscription_welcome_message: 'hi' })
    await sendSubscriptionWelcomeEmail(READER_ID, WRITER_ID)

    const sent = sendEmail.mock.calls[0][0] as { htmlBody: string; textBody: string }
    expect(sent.htmlBody).toContain('/awriter"')
    expect(sent.textBody).toContain('/awriter')
  })

  it('sends nothing when the reader has no email on file', async () => {
    stubAccounts({ ...READER, email: null }, WRITER)
    await sendSubscriptionWelcomeEmail(READER_ID, WRITER_ID)
    expect(sendEmail).not.toHaveBeenCalled()
  })

  it('sends nothing when the writer row is missing', async () => {
    stubAccounts(READER, null)
    await sendSubscriptionWelcomeEmail(READER_ID, WRITER_ID)
    expect(sendEmail).not.toHaveBeenCalled()
  })

  it('reads the message from the WRITER’s row, not the reader’s', async () => {
    // The transposition this whole dispatch-on-SQL setup exists to catch: if
    // the two ids were swapped, the reader's row would supply the message and
    // the writer's name. Give the reader a message and prove it is not used.
    stubAccounts(
      { ...READER, subscription_welcome_message: 'READER MESSAGE' } as Partial<WriterRow>,
      { ...WRITER, subscription_welcome_message: 'WRITER MESSAGE' },
    )
    await sendSubscriptionWelcomeEmail(READER_ID, WRITER_ID)

    const sent = sendEmail.mock.calls[0][0] as { textBody: string; to: string }
    expect(sent.textBody).toContain('WRITER MESSAGE')
    expect(sent.textBody).not.toContain('READER MESSAGE')
    expect(sent.to).toBe('reader@example.com')
  })
})
