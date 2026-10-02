import { describe, it, expect, beforeAll, afterAll, afterEach } from 'vitest'
import pg from 'pg'

// =============================================================================
// A login token and a key-export token are not interchangeable (migration 192,
// MIRROR-AUDIT §2.6).
//
// The nsec export's step-up reuses the magic-link primitive rather than growing
// a second one — 32 random bytes, only the hash stored, one atomic single-use
// claim, all of it already audited clean. What that reuse introduces is the
// possibility of confusing the two kinds, and the confusion is dangerous in
// BOTH directions: a login link forwarded to a phisher must not authorise a key
// export, and an export link must not be a way in. Both readers therefore
// filter on `purpose`, and a filter missing from either side silently re-merges
// them — with the token that gets misused being, by construction, the one that
// is already in somebody else's hands.
//
// DB-BACKED BECAUSE THE RULE IS ENTIRELY IN THE SQL. Both claims are one
// `UPDATE … WHERE` and the difference between them is a predicate; a mocked
// client dispatching on the query text would be told the answer it is meant to
// be checking. Only Postgres can say whether `purpose = 'login'` actually
// excludes the export token, and whether the CHECK constraint holds the set
// closed.
//
// Run locally:
//   POSTGRES_PASSWORD=$(grep -E '^POSTGRES_PASSWORD=' .env | cut -d= -f2-) \
//   DATABASE_URL=postgresql://platformpub:$POSTGRES_PASSWORD@localhost:5432/platformpub \
//     npx vitest run tests/step-up-token-purpose.test.ts
// =============================================================================

const DB_URL = process.env.TEST_DATABASE_URL ?? process.env.DATABASE_URL

describe.skipIf(!DB_URL)('step-up tokens vs login tokens', () => {
  let client: pg.Client
  let magic: typeof import('../src/auth/magic-links.js')
  let accountId: string
  let otherId: string
  const email = `stepup-${Date.now().toString(36)}@test.local`

  beforeAll(async () => {
    process.env.DATABASE_URL = DB_URL
    client = new pg.Client({ connectionString: DB_URL })
    await client.connect()
    magic = await import('../src/auth/magic-links.js')

    const mk = async (suffix: string, withEmail: boolean) => {
      const { rows } = await client.query<{ id: string }>(
        `INSERT INTO accounts (nostr_pubkey, email) VALUES ($1, $2) RETURNING id`,
        [`stepup${suffix}`.padEnd(64, '0'), withEmail ? email : null],
      )
      return rows[0].id
    }
    accountId = await mk('a', true)
    otherId = await mk('b', false)
  })

  afterAll(async () => {
    await client.query(`DELETE FROM magic_links WHERE account_id = ANY($1::uuid[])`, [
      [accountId, otherId],
    ])
    await client.query(`DELETE FROM accounts WHERE id = ANY($1::uuid[])`, [
      [accountId, otherId],
    ])
    await client.end()
    const { pool } = await import('../src/db/client.js')
    await pool.end()
  })

  afterEach(async () => {
    await client.query(`DELETE FROM magic_links WHERE account_id = ANY($1::uuid[])`, [
      [accountId, otherId],
    ])
  })

  it('will not let a key-export token log anybody in', async () => {
    const { token } = await magic.requestStepUpToken(accountId, 'key_export')

    // The dangerous direction, and the reason the login reader had to change:
    // an export link sits in an inbox for fifteen minutes looking exactly like
    // a login link.
    expect(await magic.verifyMagicLink(token)).toBeNull()

    // And it is still unspent afterwards — a failed claim must not consume it,
    // or a stray click on the wrong reader silently costs the member their
    // export and they cannot tell why.
    const { rows } = await client.query<{ used_at: Date | null }>(
      `SELECT used_at FROM magic_links WHERE account_id = $1`,
      [accountId],
    )
    expect(rows).toHaveLength(1)
    expect(rows[0].used_at).toBeNull()
  })

  it('will not let a login token authorise a key export', async () => {
    const link = await magic.requestMagicLink(email)
    expect(link).not.toBeNull()

    const claimed = await magic.claimStepUpToken(
      client,
      link!.token,
      accountId,
      'key_export',
    )
    expect(claimed).toBe(false)
  })

  it('claims a real step-up token exactly once', async () => {
    const { token } = await magic.requestStepUpToken(accountId, 'key_export')

    expect(await magic.claimStepUpToken(client, token, accountId, 'key_export')).toBe(true)
    // Single use is the defence against a link read in transit — the second
    // claim has to lose, not merely be discouraged.
    expect(await magic.claimStepUpToken(client, token, accountId, 'key_export')).toBe(false)
  })

  it('will not claim another account’s token', async () => {
    const { token } = await magic.requestStepUpToken(accountId, 'key_export')

    expect(await magic.claimStepUpToken(client, token, otherId, 'key_export')).toBe(false)
    // Unspent, so the member it was minted for can still use it.
    expect(await magic.claimStepUpToken(client, token, accountId, 'key_export')).toBe(true)
  })

  it('will not claim an expired token', async () => {
    const { token } = await magic.requestStepUpToken(accountId, 'key_export')
    await client.query(
      `UPDATE magic_links SET expires_at = now() - interval '1 minute'
        WHERE account_id = $1`,
      [accountId],
    )

    expect(await magic.claimStepUpToken(client, token, accountId, 'key_export')).toBe(false)
  })

  it('holds the purpose set closed in the schema', async () => {
    // The CHECK is what stops a third kind arriving by typo and being claimable
    // by neither reader — a token that can never be spent, which presents to
    // the member as an email that simply does not work.
    await expect(
      client.query(
        `INSERT INTO magic_links (account_id, token_hash, expires_at, purpose)
         VALUES ($1, 'x', now() + interval '1 hour', 'not_a_purpose')`,
        [accountId],
      ),
    ).rejects.toThrow(/magic_links_purpose_check/)
  })

  it('defaults an unmarked row to login, so every historical row still works', async () => {
    await client.query(
      `INSERT INTO magic_links (account_id, token_hash, expires_at)
       VALUES ($1, 'y', now() + interval '1 hour')`,
      [accountId],
    )
    const { rows } = await client.query<{ purpose: string }>(
      `SELECT purpose FROM magic_links WHERE token_hash = 'y'`,
    )
    expect(rows[0].purpose).toBe('login')
  })
})
