'use client'

// =============================================================================
// PostLinkImportOffer — the post-link follow-import prompt (FOLLOW-GRAPH-
// IMPORT-ADR §7.1). Rides the same ?linked= redirect channel as the connect
// banner: the gateway appends &follows=<count> to a successful link while the
// import feature is live, the /settings shim forwards it, and SettingsPanel
// mounts this under the banner. Opt-in per run (D7) — the offer does nothing
// until the user says yes, and "Not now" costs nothing (the same import stays
// reachable from "Reach other networks" and the FeedComposer).
//
// Bluesky (1a) + Mastodon (1c). The origin identity is protocol-shaped: the
// DID for atproto, the user@instance handle for activitypub (the presence's
// external_id is a per-instance numeric id the graph reader can't use).
// =============================================================================

import { useEffect, useState } from 'react'
import {
  getNetworkCapabilities,
  type LinkedAccount,
} from '../../lib/api/linked-accounts'
import { useLinkedAccounts } from '../../hooks/useLinkedAccounts'
import { useFollowImportRun } from '../../hooks/useFollowImportRun'
import type { FollowImportProtocol } from '../../lib/api'
import { FollowImportStatus } from '../network/FollowImportStatus'

const NETWORKS: Record<
  'bluesky' | 'mastodon',
  {
    protocol: FollowImportProtocol
    label: string
    origin: (a: LinkedAccount) => string | null
  }
> = {
  bluesky: {
    protocol: 'atproto',
    label: 'Bluesky',
    origin: a => a.externalId ?? null,
  },
  mastodon: {
    protocol: 'activitypub',
    label: 'Mastodon',
    origin: a => a.externalHandle ?? null,
  },
}

export function PostLinkImportOffer({
  network,
  follows,
}: {
  network: 'bluesky' | 'mastodon'
  follows: number | null
}) {
  const [importable, setImportable] = useState<string[]>([])
  const [dismissed, setDismissed] = useState(false)
  const accounts = useLinkedAccounts()
  const followImport = useFollowImportRun()

  useEffect(() => {
    void getNetworkCapabilities().then(c =>
      setImportable(c.followImportProtocols ?? []),
    )
  }, [])

  const net = NETWORKS[network]
  const account =
    accounts?.find(a => a.protocol === net.protocol) ?? null
  const origin = account ? net.origin(account) : null
  if (dismissed || !importable.includes(net.protocol) || !origin) return null

  // The offer stays up until a run exists (an error keeps the buttons so the
  // user can retry); once started, the status line takes over.
  const inFlight = followImport.starting || followImport.run !== null

  return (
    <div className="bg-glasshouse-well/40 px-4 py-3 space-y-2">
      {followImport.run === null && (
        <>
          <p className="text-ui-sm text-black">
            {follows !== null && follows > 0
              ? `Import the ${follows} accounts you follow on ${net.label} as a new feed?`
              : `Import the accounts you follow on ${net.label} as a new feed?`}
          </p>
          <p className="text-ui-xs text-grey-600 leading-relaxed">
            It lands as an ordinary feed — retune, redistribute, or delete it
            with the usual tools. One-way: nothing changes on {net.label}. You
            can also do this later from &ldquo;Reach other networks&rdquo;.
          </p>
          <div className="flex gap-3">
            <button
              onClick={() =>
                void followImport.start({
                  protocol: net.protocol,
                  originIdentity: origin,
                })
              }
              disabled={inFlight}
              className="btn-text"
            >
              Import
            </button>
            <button onClick={() => setDismissed(true)} className="btn-text-muted">
              Not now
            </button>
          </div>
        </>
      )}
      <FollowImportStatus
        starting={followImport.starting}
        run={followImport.run}
        feed={followImport.feed}
        error={followImport.error}
      />
    </div>
  )
}
