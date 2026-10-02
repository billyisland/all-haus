'use client'

import { useCallback, useEffect, useState } from 'react'
import { admin as adminApi, type PlatformBlock } from '../../lib/api'
import { apiErrorMessage, ApiError } from '../../lib/api/client'

// =============================================================================
// What all.haus will not carry (L6.5; D1 §9.6, D5 §5, D7 §5/§7)
//
// D7 §7 is why this exists. For ingested content in client-mode we assert no
// takedown duty — the item sits in one follower's own feed, we did not host it
// and we did not publish it — but the guidance is explicit that "source
// blocking is applied on the same judgement tests where content would fail
// them". There was no mechanism for that at all: `blocks` and `mutes` are
// rows a MEMBER writes about a MEMBER, and per-feed `muted_at` is the feed
// owner's own preference on their own feed. Nothing the operator could press
// reached the platform.
//
// TWO KINDS, BECAUSE THEY ARE TWO JUDGEMENTS. A SOURCE block says we will not
// poll this endpoint for anybody. An IDENTITY block says we will not carry
// this person's posts however they reach us — their own source, a reply
// hydrated into somebody else's thread, a repost.
//
// IT IS NOT A SUSPENSION, and the panel says so where it would otherwise be
// guessed at: a native member is suspended from the Users tab, which writes
// their account status and tombstones their work. These are identities that
// are not ours, and a block neither creates nor implies an account.
//
// THE COUNT IS WHAT MAKES THIS A LIST OF FACTS. `matchedSources` is how many
// `external_sources` rows the block currently matches — the difference between
// a live refusal and a typo, which is otherwise invisible for exactly as long
// as it matters.
// =============================================================================

/** The protocols a source block can name — `external_protocol`'s public half. */
const PROTOCOLS = ['rss', 'nostr_external', 'atproto', 'activitypub', 'email'] as const

export function PlatformBlocksPanel() {
  const [blocks, setBlocks] = useState<PlatformBlock[] | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [kind, setKind] = useState<'source' | 'npub'>('npub')
  const [target, setTarget] = useState('')
  const [protocol, setProtocol] = useState<string>('rss')
  const [reason, setReason] = useState('')
  const [busy, setBusy] = useState(false)
  const [note, setNote] = useState<{ text: string; warn: boolean } | null>(null)
  // A lift is armed with its reason (§0z item 12): the gateway refuses one
  // without, and writes it to the audit beside the block it removes.
  const [lifting, setLifting] = useState<string | null>(null)
  const [liftReason, setLiftReason] = useState('')

  const load = useCallback(async () => {
    try {
      const data = await adminApi.listBlocks()
      setBlocks(data.blocks)
      setError(null)
    } catch {
      // An outage renders as an outage, never as an empty state — an empty
      // block list is a claim that we are refusing nothing.
      setError('Couldn’t load the block list. Please reload the page to try again.')
    }
  }, [])

  useEffect(() => {
    void load()
  }, [load])

  async function add() {
    if (target.trim() === '' || reason.trim() === '') return
    setBusy(true)
    setNote(null)
    try {
      await adminApi.addBlock({
        kind,
        target: target.trim(),
        protocol: kind === 'npub' ? undefined : protocol,
        reason: reason.trim(),
      })
      setTarget('')
      setReason('')
      setNote({ text: 'Blocked.', warn: false })
      await load()
    } catch (err) {
      const code =
        err instanceof ApiError && typeof err.body?.error === 'string' ? err.body.error : ''
      const standing =
        err instanceof ApiError && code === 'already_blocked'
          ? (err.body?.block as { reason?: string; blockedByUsername?: string | null } | null)
          : null
      setNote({
        text:
          code === 'invalid_npub'
            ? 'That is not an npub or a 64-character hex pubkey.'
            : code === 'unknown_protocol'
              ? 'That is not a protocol this platform ingests.'
              : code === 'already_blocked'
                ? `Already blocked${standing?.blockedByUsername ? ` by @${standing.blockedByUsername}` : ''}: ${standing?.reason ?? 'the standing reason is on its row'}. The first decision is the record; lift it first if it is wrong.`
                : code === 'invalid_source'
                  ? (apiErrorMessage(err) ?? 'That is not a source this platform can resolve.')
                  : code === 'source_unresolvable'
                    ? (apiErrorMessage(err) ?? 'That source could not be resolved to its canonical form.')
                    : (apiErrorMessage(err) ?? 'Couldn’t add that block.'),
        warn: true,
      })
    } finally {
      setBusy(false)
    }
  }

  async function remove(id: string) {
    if (liftReason.trim() === '') return
    setBusy(true)
    try {
      await adminApi.removeBlock(id, liftReason.trim())
      setLifting(null)
      setLiftReason('')
      await load()
    } catch {
      setNote({ text: 'Couldn’t lift that block.', warn: true })
    } finally {
      setBusy(false)
    }
  }

  return (
    <section className="mt-12">
      <h2 className="label-ui text-grey-400 mb-2">What we will not carry</h2>
      <p className="text-ui-xs text-grey-600 mb-4 max-w-prose">
        A <strong>source</strong> block stops us polling an endpoint for anybody.
        An <strong>identity</strong> block stops us carrying that person&rsquo;s
        posts however they reach us. Neither is a suspension — a member of
        all.haus is suspended from the Users tab.
      </p>

      <div className="bg-glasshouse-well px-6 py-5 space-y-3">
        <div className="flex flex-wrap items-center gap-2">
          <button
            type="button"
            onClick={() => setKind('npub')}
            className={`toggle-chip ${kind === 'npub' ? 'toggle-chip-active' : 'toggle-chip-inactive'}`}
          >
            Identity (npub)
          </button>
          <button
            type="button"
            onClick={() => setKind('source')}
            className={`toggle-chip ${kind === 'source' ? 'toggle-chip-active' : 'toggle-chip-inactive'}`}
          >
            Source
          </button>
          {kind === 'source' && (
            <select
              value={protocol}
              onChange={(e) => setProtocol(e.target.value)}
              aria-label="Protocol"
              className="bg-white px-3 py-1 text-ui-xs text-black focus-ring"
            >
              {PROTOCOLS.map((p) => (
                <option key={p} value={p}>
                  {p}
                </option>
              ))}
            </select>
          )}
        </div>

        <input
          type="text"
          value={target}
          onChange={(e) => setTarget(e.target.value)}
          placeholder={
            kind === 'npub'
              ? 'npub1… or a 64-character hex pubkey'
              : 'The source URI exactly as we store it'
          }
          aria-label="Block target"
          className="w-full bg-white px-3 py-1 text-ui-xs text-black focus-ring"
        />
        <input
          type="text"
          value={reason}
          onChange={(e) => setReason(e.target.value)}
          placeholder="Why — required, and kept"
          aria-label="Block reason"
          className="w-full bg-white px-3 py-1 text-ui-xs text-black focus-ring"
        />
        <div className="flex items-center gap-4">
          <button
            type="button"
            onClick={() => void add()}
            disabled={busy || target.trim() === '' || reason.trim() === ''}
            className="btn-text-danger"
          >
            {busy ? 'Working…' : 'Block'}
          </button>
          {note && (
            <span className={`text-ui-xs ${note.warn ? 'text-crimson' : 'text-black'}`}>
              {note.text}
            </span>
          )}
        </div>
      </div>

      {error ? (
        <p className="mt-4 text-ui-xs text-crimson">{error}</p>
      ) : blocks === null ? null : blocks.length === 0 ? (
        <p className="mt-4 text-ui-xs text-grey-400">Nothing is blocked.</p>
      ) : (
        <div className="mt-4 space-y-2">
          {blocks.map((b) => (
            <div
              key={b.id}
              className="bg-glasshouse-well px-6 py-4 flex flex-wrap items-start gap-x-4 gap-y-1"
            >
              <span className="label-ui text-grey-300">
                {b.kind === 'npub' ? 'Identity' : b.protocol}
              </span>
              <span className="font-mono text-mono-xs text-black break-all min-w-0 flex-1">
                {b.target}
              </span>
              {b.kind === 'source' && (
                <span className="text-ui-xs text-grey-400">
                  {b.matchedSources === 0
                    ? 'matches no source we hold'
                    : `${b.matchedSources} source${b.matchedSources === 1 ? '' : 's'}`}
                </span>
              )}
              {lifting === b.id ? (
                <span className="flex flex-wrap items-center gap-3 w-full">
                  <input
                    type="text"
                    value={liftReason}
                    onChange={(e) => setLiftReason(e.target.value)}
                    placeholder="Why it is lifted — kept on the audit…"
                    aria-label="Lift reason"
                    className="flex-1 min-w-[200px] bg-white px-3 py-1 text-ui-xs text-black focus-ring"
                  />
                  <button
                    type="button"
                    onClick={() => void remove(b.id)}
                    disabled={busy || liftReason.trim() === ''}
                    className="btn-text-danger"
                  >
                    {busy ? 'Working…' : 'Lift'}
                  </button>
                  <button
                    type="button"
                    onClick={() => {
                      setLifting(null)
                      setLiftReason('')
                    }}
                    disabled={busy}
                    className="btn-text-muted"
                  >
                    Cancel
                  </button>
                </span>
              ) : (
                <button
                  type="button"
                  onClick={() => {
                    setLifting(b.id)
                    setLiftReason('')
                  }}
                  disabled={busy}
                  className="btn-text-muted"
                >
                  Lift
                </button>
              )}
              <p className="w-full text-ui-xs text-grey-600">{b.reason}</p>
            </div>
          ))}
        </div>
      )}
    </section>
  )
}
