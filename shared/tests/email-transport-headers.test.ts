import { describe, it, expect, vi, afterEach } from 'vitest'

// =============================================================================
// THE HEADERS REACH THE PROVIDER (CA-D4). `renderEmail` putting
// `List-Unsubscribe` on a RenderedEmail proves nothing if the transport drops
// it on the way to Postmark — and the publish email is the one that goes out on
// the BROADCAST stream, a separate function from the transactional send. So
// this drives `sendBroadcastEmail` with a stubbed fetch and reads the body it
// posted.
// =============================================================================

vi.mock('../src/lib/logger.js', () => ({
  default: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}))

const { sendBroadcastEmail, sendEmail } = await import('../src/lib/email.js')

const HEADERS = {
  'List-Unsubscribe': '<https://all.haus/u?t=1>',
  'List-Unsubscribe-Post': 'List-Unsubscribe=One-Click',
}

function stubPostmark(): Array<Record<string, unknown>> {
  const bodies: Array<Record<string, unknown>> = []
  vi.stubGlobal('fetch', vi.fn(async (_url: string, init: RequestInit) => {
    bodies.push(JSON.parse(String(init.body)))
    return new Response('{}', { status: 200 })
  }))
  process.env.EMAIL_PROVIDER = 'postmark'
  process.env.POSTMARK_API_KEY = 'k'
  return bodies
}

afterEach(() => {
  vi.unstubAllGlobals()
  delete process.env.EMAIL_PROVIDER
  delete process.env.POSTMARK_API_KEY
})

const email = { to: 'r@example.com', subject: 's', textBody: 't', htmlBody: '<p>h</p>' }

describe('Postmark carries the message headers', () => {
  it('on the broadcast stream', async () => {
    const bodies = stubPostmark()
    await sendBroadcastEmail({ ...email, headers: HEADERS })
    expect(bodies[0].Headers).toEqual([
      { Name: 'List-Unsubscribe', Value: '<https://all.haus/u?t=1>' },
      { Name: 'List-Unsubscribe-Post', Value: 'List-Unsubscribe=One-Click' },
    ])
  })

  it('on the transactional stream', async () => {
    const bodies = stubPostmark()
    await sendEmail({ ...email, headers: HEADERS })
    expect(bodies[0].Headers).toHaveLength(2)
  })

  it('and sends no Headers field for an email that has none', async () => {
    const bodies = stubPostmark()
    await sendEmail(email)
    expect(bodies[0]).not.toHaveProperty('Headers')
  })
})
