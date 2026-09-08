'use client'

// =============================================================================
// NetworkReachPanel — "Reach other networks." (NETWORK-CONCIERGE-ADR §10)
//
// Your account *is* a Nostr identity (the custodial root). Every other network
// is a satellite presence reached one of two ways: LINK an account you already
// have (OAuth, live today) or have all.haus SET ONE UP for you (concierge —
// gated on Phase 2/3 §8.1, so its affordance renders disabled/"coming soon").
//
// Nostr is the degenerate concierge (§7): you already hold the root key, so
// "go public" is just the discovery opt-in — folded in here as the Nostr row
// (relocated from the old PrivacyPreferences panel) so the whole network-reach
// mental model lives in one place.
// =============================================================================

import { useEffect, useState } from 'react'
import { linkedAccounts, privacyPreferences, type LinkedAccount } from '../../lib/api'
import {
  ASSISTED_BLUESKY_CONSENT,
  assistedMastodonConsent,
  type NetworkCapabilities,
} from '../../lib/api/linked-accounts'
import { useFollowImportRun } from '../../hooks/useFollowImportRun'
import { FollowImportSection } from '../network/FollowImportSection'

type SatelliteKey = 'mastodon' | 'bluesky'

const SATELLITES: {
  key: SatelliteKey
  label: string
  protocol: LinkedAccount['protocol']
  conciergeHandle: string
}[] = [
  { key: 'bluesky', label: 'Bluesky', protocol: 'atproto', conciergeHandle: 'you.all.haus' },
  { key: 'mastodon', label: 'Mastodon', protocol: 'activitypub', conciergeHandle: '@you@all.haus' },
]

export function NetworkReachPanel() {
  const [accounts, setAccounts] = useState<LinkedAccount[] | null>(null)
  const [capabilities, setCapabilities] = useState<NetworkCapabilities | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [connecting, setConnecting] = useState(false)
  const [instanceUrl, setInstanceUrl] = useState('')
  const [blueskyHandle, setBlueskyHandle] = useState('')
  const [showConnect, setShowConnect] = useState<null | SatelliteKey>(null)
  // The ASSISTED consent gate (§6.1.1 S5) — distinct from the link form above.
  const [showAssisted, setShowAssisted] = useState<null | SatelliteKey>(null)
  // Mastodon ASSISTED instance choice (§9) — null ⇒ the allowlist default.
  const [assistedInstance, setAssistedInstance] = useState<string | null>(null)

  // Nostr presence (the degenerate concierge) — relocated from PrivacyPreferences.
  const [discoveryEnabled, setDiscoveryEnabled] = useState<boolean | null>(null)
  const [publishFollowGraph, setPublishFollowGraph] = useState<boolean | null>(null)

  // Follow-graph import (FOLLOW-GRAPH-IMPORT-ADR §7.2). One run at a time
  // across this panel: the per-presence "Import follows" affordance and the
  // paste-an-identity section below share this hook + its status area.
  const followImport = useFollowImportRun()
  const importable = capabilities?.followImportProtocols ?? []
  const opmlImportable = capabilities?.followImportOpml ?? false
  const importBusy =
    followImport.starting ||
    followImport.run?.status === 'pending' ||
    followImport.run?.status === 'running'

  async function load() {
    try {
      const { accounts, capabilities } = await linkedAccounts.list()
      setAccounts(accounts)
      setCapabilities(
        capabilities ?? { assistedBluesky: false, assistedMastodon: false },
      )
    } catch (err: any) {
      setError(err.message ?? 'Failed to load network presences')
    }
  }

  useEffect(() => { void load() }, [])

  useEffect(() => {
    privacyPreferences.get()
      .then(res => {
        setDiscoveryEnabled(res.discoveryEnabled)
        setPublishFollowGraph(res.publishFollowGraph)
      })
      .catch(() => {
        setDiscoveryEnabled(false)
        setPublishFollowGraph(true)
      })
  }, [])

  async function setDiscovery(value: boolean) {
    if (discoveryEnabled === value) return
    const previous = discoveryEnabled
    setDiscoveryEnabled(value)
    try {
      await privacyPreferences.update({ discoveryEnabled: value })
    } catch {
      setDiscoveryEnabled(previous)
    }
  }

  async function setFollowGraph(value: boolean) {
    if (publishFollowGraph === value) return
    const previous = publishFollowGraph
    setPublishFollowGraph(value)
    try {
      await privacyPreferences.update({ publishFollowGraph: value })
    } catch {
      setPublishFollowGraph(previous)
    }
  }

  async function handleConnectMastodon() {
    const trimmed = instanceUrl.trim().replace(/^https?:\/\//, '').replace(/\/+$/, '')
    if (!trimmed) return
    setConnecting(true)
    setError(null)
    try {
      const { authorizeUrl } = await linkedAccounts.connectMastodon(`https://${trimmed}`)
      window.location.href = authorizeUrl
    } catch (err: any) {
      setError(err.message ?? 'Failed to start connection')
      setConnecting(false)
    }
  }

  async function handleConnectBluesky() {
    const trimmed = blueskyHandle.trim().replace(/^@/, '')
    if (!trimmed) return
    setConnecting(true)
    setError(null)
    try {
      const { authorizeUrl } = await linkedAccounts.connectBluesky(trimmed)
      window.location.href = authorizeUrl
    } catch (err: any) {
      setError(err.message ?? 'Failed to start connection')
      setConnecting(false)
    }
  }

  async function handleAssistedBluesky() {
    setConnecting(true)
    setError(null)
    try {
      const { authorizeUrl } = await linkedAccounts.assistedBluesky()
      window.location.href = authorizeUrl
    } catch (err: any) {
      setError(err.message ?? 'Failed to start setup')
      setConnecting(false)
    }
  }

  async function handleAssistedMastodon() {
    setConnecting(true)
    setError(null)
    try {
      const { authorizeUrl } = await linkedAccounts.assistedMastodon(
        assistedInstance ?? undefined,
      )
      window.location.href = authorizeUrl
    } catch (err: any) {
      setError(err.message ?? 'Failed to start setup')
      setConnecting(false)
    }
  }

  async function handleDisconnect(id: string) {
    if (!confirm('Disconnect this account? Cross-posts will stop.')) return
    try {
      await linkedAccounts.remove(id)
      await load()
    } catch (err: any) {
      setError(err.message ?? 'Failed to disconnect')
    }
  }

  async function handleToggleDefault(acct: LinkedAccount) {
    try {
      await linkedAccounts.update(acct.id, { crossPostDefault: !acct.crossPostDefault })
      await load()
    } catch (err: any) {
      setError(err.message ?? 'Failed to update')
    }
  }

  // A SEPARATE consent from cross-posting (PROFILE-PANE-REDESIGN-ADR D7). The
  // presence was linked so all.haus could post through it; showing it on the
  // profile publishes the connection itself, and the profile pages are SSR'd
  // share/SEO surfaces. Default off, same shape as discovery above — identity
  // disclosure is opt-in in this house.
  async function handleToggleShowOnProfile(acct: LinkedAccount) {
    try {
      await linkedAccounts.update(acct.id, { showOnProfile: !acct.showOnProfile })
      await load()
    } catch (err: any) {
      setError(err.message ?? 'Failed to update')
    }
  }

  const linkedFor = (protocol: LinkedAccount['protocol']) =>
    accounts?.find(a => a.protocol === protocol) ?? null

  return (
    <>
        <div className="space-y-8">
          {/* Nostr — the root, always present. "Go public" is the discovery opt-in. */}
          <div data-explain="settings.discovery">
            <div className="flex items-center justify-between gap-4">
              <div className="min-w-0 pr-6">
                <p className="text-ui-sm text-black">Nostr</p>
                <p className="text-ui-xs text-grey-600 mt-1 leading-relaxed">
                  {discoveryEnabled
                    ? "Public. You've allowed all.haus to publish your profile and where to read you to the Nostr network, so people anywhere on Nostr can find and follow you."
                    : 'Your account is a Nostr identity, not published beyond all.haus. Turn on discovery to publish your profile to the public Nostr network.'}
                </p>
              </div>
              <div className="flex shrink-0">
                <button
                  onClick={() => setDiscovery(true)}
                  className={`label-ui toggle-chip ${discoveryEnabled === true ? 'toggle-chip-active' : 'toggle-chip-inactive'}`}
                  disabled={discoveryEnabled === null}
                >
                  Public
                </button>
                <button
                  onClick={() => setDiscovery(false)}
                  className={`label-ui toggle-chip ${discoveryEnabled === false ? 'toggle-chip-active' : 'toggle-chip-inactive'}`}
                  disabled={discoveryEnabled === null}
                >
                  Private
                </button>
              </div>
            </div>

            {/* Follow-graph sub-opt-out — only meaningful while public */}
            {discoveryEnabled && (
              <div className="flex items-center justify-between gap-4 mt-4 pl-4">
                <p className="text-ui-xs text-grey-600 pr-6 leading-relaxed">
                  Also publish who you follow as a public Nostr contact list. Turn off to keep
                  your follow list private.
                </p>
                <div className="flex shrink-0">
                  <button
                    onClick={() => setFollowGraph(true)}
                    className={`label-ui toggle-chip ${publishFollowGraph === true ? 'toggle-chip-active' : 'toggle-chip-inactive'}`}
                    disabled={publishFollowGraph === null}
                  >
                    On
                  </button>
                  <button
                    onClick={() => setFollowGraph(false)}
                    className={`label-ui toggle-chip ${publishFollowGraph === false ? 'toggle-chip-active' : 'toggle-chip-inactive'}`}
                    disabled={publishFollowGraph === null}
                  >
                    Off
                  </button>
                </div>
              </div>
            )}
          </div>

          {/* Satellite networks — link yours, or (soon) concierge. */}
          {accounts === null ? (
            <div className="h-12 animate-pulse bg-grey-100" />
          ) : (
            SATELLITES.map(net => {
              const acct = linkedFor(net.protocol)
              // ASSISTED: Bluesky on Phase 2 (§6.1), Mastodon on Phase 3 (§9) —
              // each behind its own server flag.
              const assistedAvailable =
                net.key === 'bluesky'
                  ? !!capabilities?.assistedBluesky
                  : !!capabilities?.assistedMastodon
              const assistedInstances = capabilities?.assistedMastodonInstances ?? []
              const chosenInstance = assistedInstance ?? assistedInstances[0] ?? 'mastodon.social'
              return (
                <div key={net.key}>
                  <div className="flex items-center justify-between gap-4">
                    <div className="min-w-0 pr-6">
                      <div className="flex items-center gap-2">
                        <p className="text-ui-sm text-black">{net.label}</p>
                        {acct && !acct.isValid && <span className="label-ui text-red-600">Invalid</span>}
                      </div>
                      {acct ? (
                        <p className="text-ui-sm text-grey-600 truncate mt-1">{acct.externalHandle ?? acct.externalId}</p>
                      ) : (
                        <p className="text-ui-xs text-grey-600 mt-1 leading-relaxed">
                          Cross-post your notes and replies to {net.label}.
                        </p>
                      )}
                    </div>

                    {acct ? (
                      <div className="flex items-center gap-4 shrink-0">
                        <label className="flex items-center gap-2 cursor-pointer">
                          <input
                            type="checkbox"
                            checked={acct.crossPostDefault}
                            onChange={() => handleToggleDefault(acct)}
                            className="cursor-pointer"
                          />
                          <span className="label-ui text-grey-600">Default on</span>
                        </label>
                        <label className="flex items-center gap-2 cursor-pointer">
                          <input
                            type="checkbox"
                            checked={acct.showOnProfile ?? false}
                            onChange={() => handleToggleShowOnProfile(acct)}
                            className="cursor-pointer"
                          />
                          <span className="label-ui text-grey-600">Show on profile</span>
                        </label>
                        {/* Follow-graph import for a linked presence (§7.2) —
                            only for protocols the server can read. Opt-in per
                            run (D7): this click is the explicit yes. Origin is
                            protocol-shaped: DID for atproto, user@instance for
                            activitypub (external_id there is a per-instance
                            numeric id the graph reader can't use). */}
                        {importable.includes(net.protocol) &&
                          (net.protocol === 'activitypub'
                            ? acct.externalHandle
                            : acct.externalId) && (
                            <button
                              onClick={() =>
                                void followImport.start({
                                  protocol: net.protocol,
                                  originIdentity:
                                    net.protocol === 'activitypub'
                                      ? acct.externalHandle!
                                      : acct.externalId,
                                })
                              }
                              disabled={importBusy}
                              className="btn-text"
                            >
                              Import follows
                            </button>
                          )}
                        <button onClick={() => handleDisconnect(acct.id)} className="btn-text-danger">
                          Disconnect
                        </button>
                      </div>
                    ) : (showConnect === net.key || showAssisted === net.key) ? null : (
                      <div className="flex items-center gap-4 shrink-0">
                        <button onClick={() => setShowConnect(net.key)} className="btn-text">
                          Link yours
                        </button>
                        {assistedAvailable ? (
                          <button onClick={() => setShowAssisted(net.key)} className="btn-text">
                            Set one up
                          </button>
                        ) : (
                          <span
                            className="label-ui text-grey-300 cursor-not-allowed"
                            title={`Coming soon: all.haus will set up a ${net.label} account for you.`}
                          >
                            Set one up · soon
                          </span>
                        )}
                      </div>
                    )}
                  </div>

                  {/* "Set one up" promise — honest about who holds the keys (§10). For
                      ASSISTED (Bluesky, Phase 2) the network custodies; the future
                      custodial branded-handle path (Phase 4) is the "soon" framing. */}
                  {!acct && showAssisted !== net.key && (
                    <p className="text-ui-xs text-grey-600 mt-2 leading-relaxed">
                      {assistedAvailable
                        ? `Don't have a ${net.label} account? all.haus can set one up for you — you'll create a normal ${net.label} account that ${net.label} holds the keys to; all.haus just connects it.`
                        : `Don't have a ${net.label} account? Soon all.haus will set one up for you — guiding you through ${net.label}'s own signup so the account is yours.`}
                    </p>
                  )}

                  {/* ASSISTED consent gate (§6.1.1 S5) — explicit acknowledgement
                      that a real network account is being created mid-redirect. */}
                  {showAssisted === net.key && (
                    <div className="pt-4">
                      <p className="text-ui-xs text-grey-600 leading-relaxed max-w-md">
                        {net.key === 'bluesky'
                          ? ASSISTED_BLUESKY_CONSENT
                          : assistedMastodonConsent(chosenInstance)}
                      </p>
                      {/* Curated instance picker (§9) — only when the operator
                          configured more than one open-registration instance. */}
                      {net.key === 'mastodon' && assistedInstances.length > 1 && (
                        <div className="flex flex-wrap mt-3">
                          {assistedInstances.map(host => (
                            <button
                              key={host}
                              onClick={() => setAssistedInstance(host)}
                              className={`label-ui toggle-chip ${chosenInstance === host ? 'toggle-chip-active' : 'toggle-chip-inactive'}`}
                            >
                              {host}
                            </button>
                          ))}
                        </div>
                      )}
                      <div className="flex gap-3 mt-3">
                        <button
                          onClick={net.key === 'bluesky' ? handleAssistedBluesky : handleAssistedMastodon}
                          disabled={connecting}
                          className="btn-text"
                        >
                          {connecting ? 'Redirecting…' : `Create ${net.label} account`}
                        </button>
                        <button onClick={() => setShowAssisted(null)} className="btn-text-muted">
                          Cancel
                        </button>
                      </div>
                    </div>
                  )}

                  {/* Link-yours OAuth form (per network) */}
                  {showConnect === net.key && net.key === 'mastodon' && (
                    <div className="pt-4">
                      <p className="label-ui text-grey-600 mb-2">Mastodon instance</p>
                      <input
                        type="text"
                        value={instanceUrl}
                        onChange={e => setInstanceUrl(e.target.value)}
                        placeholder="mastodon.social"
                        autoFocus
                        className="w-full bg-glasshouse-well px-4 py-2.5 text-sm text-black placeholder-grey-300 focus:outline-none max-w-sm"
                        onKeyDown={e => { if (e.key === 'Enter') void handleConnectMastodon() }}
                      />
                      <div className="flex gap-3 mt-3">
                        <button onClick={handleConnectMastodon} disabled={connecting || !instanceUrl.trim()} className="btn-text">
                          {connecting ? 'Redirecting…' : 'Continue'}
                        </button>
                        <button onClick={() => { setShowConnect(null); setInstanceUrl('') }} className="btn-text-muted">
                          Cancel
                        </button>
                      </div>
                    </div>
                  )}
                  {showConnect === net.key && net.key === 'bluesky' && (
                    <div className="pt-4">
                      <p className="label-ui text-grey-600 mb-2">Bluesky handle</p>
                      <input
                        type="text"
                        value={blueskyHandle}
                        onChange={e => setBlueskyHandle(e.target.value)}
                        placeholder="alice.bsky.social"
                        autoFocus
                        className="w-full bg-glasshouse-well px-4 py-2.5 text-sm text-black placeholder-grey-300 focus:outline-none max-w-sm"
                        onKeyDown={e => { if (e.key === 'Enter') void handleConnectBluesky() }}
                      />
                      <div className="flex gap-3 mt-3">
                        <button onClick={handleConnectBluesky} disabled={connecting || !blueskyHandle.trim()} className="btn-text">
                          {connecting ? 'Redirecting…' : 'Continue'}
                        </button>
                        <button onClick={() => { setShowConnect(null); setBlueskyHandle('') }} className="btn-text-muted">
                          Cancel
                        </button>
                      </div>
                    </div>
                  )}
                </div>
              )
            })
          )}

          {/* Follow-graph import (FOLLOW-GRAPH-IMPORT-ADR §7.2): the inbound
              half of network reach — paste any identity with a public graph
              (D8, no link required), or upload an OPML reader export (Phase
              1d). Hidden while the server flag is dark. */}
          {(importable.length > 0 || opmlImportable) && (
            <FollowImportSection
              importable={importable}
              opml={opmlImportable}
              followImport={followImport}
            />
          )}
        </div>

        {error && <p className="text-ui-xs text-red-600 mt-4">{error}</p>}
    </>
  )
}
