import { describe, it, expect, vi, beforeEach } from 'vitest'

// =============================================================================
// A ROLLBACK MUST NOT SPEAK OVER THE ERROR IT IS ROLLING BACK
// (MIRROR-AUDIT §4, correctness papercuts).
//
// WHAT WAS WRONG. The catch was a bare `await client.query('ROLLBACK'); throw
// err`. If ROLLBACK itself rejects, ITS error is what leaves the function and
// the original is lost — so the caller sees `Connection terminated
// unexpectedly` where the ledger failure, the Stripe classifier's input or the
// constraint name was.
//
// And the two are not independent. ROLLBACK fails almost exclusively when the
// connection is already gone, which is the same event that raised the original
// error — so the substitution happens precisely when the original is most worth
// having, and it happens on every money path in the platform, since they all run
// through here. It is also invisible: nothing is swallowed, the shape of the
// failure is unchanged, and the wrong error is a perfectly plausible one.
//
// WHAT IS UNDER TEST. That the ORIGINAL error is what propagates, and that the
// rollback failure is not simply dropped either — it is our fault rather than
// the caller's, so it goes to the log with the original attached. Plus the two
// controls that stop a fix passing for the wrong reason: an ordinary failure
// (ROLLBACK fine) still throws its own error and still rolls back, and the happy
// path still commits.
// =============================================================================

interface Issued { sql: string }
let issued: Issued[] = []
let rollbackFails = false
let unlockFails = false
let lockHeldElsewhere = false
let released = 0
let releasedWith: Array<Error | undefined> = []

const logged: Array<{ payload: Record<string, unknown>; msg: string }> = []

vi.mock('../src/lib/logger.js', () => ({
  default: {
    info: vi.fn(),
    warn: vi.fn(),
    debug: vi.fn(),
    error: (payload: Record<string, unknown>, msg: string) => {
      logged.push({ payload, msg })
    },
  },
}))

vi.mock('pg', () => {
  class Pool {
    connect() {
      return Promise.resolve({
        query: (sql: string) => {
          issued.push({ sql })
          if (sql === 'ROLLBACK' && rollbackFails) {
            return Promise.reject(new Error('Connection terminated unexpectedly'))
          }
          if (sql.includes('pg_try_advisory_lock')) {
            return Promise.resolve({ rows: [{ locked: !lockHeldElsewhere }], rowCount: 1 })
          }
          if (sql.includes('pg_advisory_unlock') && unlockFails) {
            return Promise.reject(new Error('Query read timeout'))
          }
          return Promise.resolve({ rows: [], rowCount: 0 })
        },
        release: (err?: Error) => {
          released += 1
          releasedWith.push(err)
        },
      })
    }
    on() {}
  }
  return { default: { Pool }, Pool }
})

process.env.DATABASE_URL = 'postgresql://u:p@localhost:5432/db'

const { withTransaction, withAdvisoryLock } = await import('../src/db/client.js')

beforeEach(() => {
  issued = []
  logged.length = 0
  rollbackFails = false
  unlockFails = false
  lockHeldElsewhere = false
  released = 0
  releasedWith = []
})

describe('withTransaction', () => {
  it('rethrows the CALLER\'S error when ROLLBACK also fails', async () => {
    rollbackFails = true
    const original = new Error('insert into ledger_entries violates fk')

    await expect(
      withTransaction(async () => {
        throw original
      })
    ).rejects.toBe(original)

    // Identity, not message: a fix that wraps or re-creates the error breaks
    // every `instanceof` classifier downstream (isTerminalChargeError and the
    // rest all branch on the error's own type).
    expect(issued.map((q) => q.sql)).toEqual(['BEGIN', 'ROLLBACK'])
  })

  it('does not simply swallow the rollback failure — it is logged, with the original', async () => {
    rollbackFails = true
    const original = new Error('the real cause')

    await expect(withTransaction(async () => { throw original })).rejects.toBe(original)

    // A failed ROLLBACK is a fault of ours, so it belongs in the log rather
    // than in the caller's hands. Dropping it entirely would trade one silence
    // for another.
    expect(logged).toHaveLength(1)
    expect(logged[0].payload.cause).toBe(original)
    expect(String((logged[0].payload.err as Error).message)).toContain(
      'Connection terminated'
    )
  })

  it('CONTROL — an ordinary failure still rolls back and still throws its own error', async () => {
    const original = new Error('ordinary failure')

    await expect(withTransaction(async () => { throw original })).rejects.toBe(original)

    expect(issued.map((q) => q.sql)).toEqual(['BEGIN', 'ROLLBACK'])
    // Nothing to report: the rollback worked.
    expect(logged).toHaveLength(0)
  })

  it('CONTROL — the happy path still commits and returns', async () => {
    const result = await withTransaction(async (client) => {
      await client.query('INSERT INTO t VALUES (1)')
      return 'done'
    })

    expect(result).toBe('done')
    expect(issued.map((q) => q.sql)).toEqual([
      'BEGIN',
      'INSERT INTO t VALUES (1)',
      'COMMIT',
    ])
  })

  it('releases the client even when ROLLBACK fails', async () => {
    rollbackFails = true
    await expect(withTransaction(async () => { throw new Error('x') })).rejects.toThrow()

    // The `finally` must still run: a client leaked on this path exhausts the
    // pool one connection per failure, which presents as the platform hanging.
    expect(released).toBe(1)
  })

  it('hands a client whose ROLLBACK failed back WITH the error, so the pool destroys it (CA-F6)', async () => {
    rollbackFails = true
    await expect(withTransaction(async () => { throw new Error('x') })).rejects.toThrow('x')

    // pg-pool drops a dead connection by itself, but one whose ROLLBACK timed
    // out is still queryable — released bare, it re-enters the pool inside an
    // aborted transaction and fails the next borrower's first statement.
    expect(releasedWith).toHaveLength(1)
    expect(releasedWith[0]?.message).toContain('Connection terminated')
  })

  it('CONTROL — an ordinary failure releases the client for reuse', async () => {
    await expect(withTransaction(async () => { throw new Error('x') })).rejects.toThrow('x')
    expect(releasedWith).toEqual([undefined])
  })
})

// =============================================================================
// withAdvisoryLock (CA-D2) — the same rule for the unlock, plus the lock itself:
// an unlock that fails on a SURVIVING session must not return a lock-holding
// connection to the pool, or every later tick skips as "another instance holds
// the lock" until the process restarts.
// =============================================================================

describe('withAdvisoryLock', () => {
  it('rethrows the JOB\'S error when the unlock also fails, and destroys the client', async () => {
    unlockFails = true
    const original = new Error('the sweep failed')

    await expect(withAdvisoryLock(42, async () => { throw original })).rejects.toBe(original)

    expect(logged).toHaveLength(1)
    expect(logged[0].payload.cause).toBe(original)
    // Released WITH an error: pg-pool closes it, and a closed session frees
    // its advisory locks. A bare release() is the stranded lock.
    expect(releasedWith).toHaveLength(1)
    expect(releasedWith[0]?.message).toContain('read timeout')
  })

  it('an unlock failure after a SUCCESSFUL job is logged and the client destroyed, not thrown', async () => {
    unlockFails = true
    let ran = false

    await expect(withAdvisoryLock(42, async () => { ran = true })).resolves.toBe(true)

    expect(ran).toBe(true)
    expect(logged).toHaveLength(1)
    expect(releasedWith[0]).toBeInstanceOf(Error)
  })

  it('CONTROL — the happy path unlocks and releases the client for reuse', async () => {
    let ran = false
    await expect(withAdvisoryLock(42, async () => { ran = true })).resolves.toBe(true)

    expect(ran).toBe(true)
    expect(issued.map((q) => q.sql)).toEqual([
      'SELECT pg_try_advisory_lock($1) AS locked',
      'SELECT pg_advisory_unlock($1)',
    ])
    expect(releasedWith).toEqual([undefined])
  })

  it('CONTROL — a job that throws still unlocks, and its own error propagates', async () => {
    const original = new Error('ordinary job failure')
    await expect(withAdvisoryLock(42, async () => { throw original })).rejects.toBe(original)

    expect(issued.map((q) => q.sql)).toContain('SELECT pg_advisory_unlock($1)')
    expect(logged).toHaveLength(0)
    expect(releasedWith).toEqual([undefined])
  })

  it('runs nothing and answers false when another session holds the lock', async () => {
    lockHeldElsewhere = true
    let ran = false

    await expect(withAdvisoryLock(42, async () => { ran = true })).resolves.toBe(false)

    expect(ran).toBe(false)
    // Never unlock a lock we did not take.
    expect(issued.map((q) => q.sql)).toEqual(['SELECT pg_try_advisory_lock($1) AS locked'])
    expect(released).toBe(1)
  })
})
