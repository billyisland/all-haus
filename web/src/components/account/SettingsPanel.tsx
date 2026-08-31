'use client'

// =============================================================================
// SettingsPanel — the account-settings body, extracted so the workspace
// Glasshouse overlay (SettingsOverlay) owns it. Email, payment, linked social
// accounts, notification / reading / privacy preferences, data export, and the
// danger zone. Mirrors LedgerPanel: a page-capable mode (`inOverlay=false`:
// wrapped in PageShell, with the auth redirect) is kept for parity, but the
// overlay is the live surface. When `inOverlay` is set the panel skips the auth
// redirect (the overlay only mounts for authenticated users) and renders a bare
// body — the overlay supplies the frame, width and title.
//
// `initialLinked` is the OAuth-callback flag (mastodon/bluesky/error) forwarded
// from the /settings shim; it drives the transient connect banner.
// =============================================================================

import { useState, useEffect } from 'react'
import { useAuth } from '../../stores/auth'
import { useRouter } from 'next/navigation'
import { invalidateLinkedAccounts } from '../../hooks/useLinkedAccounts'
import { ProfileSection } from './ProfileSection'
import { PostLinkImportOffer } from './PostLinkImportOffer'
import { PostLinkProfileOffer } from './PostLinkProfileOffer'
import { EmailChange } from './EmailChange'
import { PaymentSection } from './PaymentSection'
import { NetworkReachPanel } from './NetworkReachPanel'
import { NotificationPreferences } from '../social/NotificationPreferences'
import { ReadingPreferences } from './ReadingPreferences'
import { TypeSizeControl } from './TypeSizeControl'
import { ColorModeControl } from './ColorModeControl'
// ThemeSection retired from Settings (GLASSHOUSE-AND-PALETTE-ADR §III.5) — the
// preset-theme picker is no longer user-facing; the file is parked, not deleted.
import { ExportModal } from '../ExportModal'
import { DangerZone } from './DangerZone'
import { PageShell, PageHeader } from '../ui/PageShell'
import { SettingsGroup, SettingsSection, SettingsRow } from './SettingsSection'

function bannerFor(linked: string | null): { kind: 'ok' | 'error'; msg: string } | null {
  if (linked === 'mastodon') return { kind: 'ok', msg: 'Mastodon account connected.' }
  if (linked === 'bluesky') return { kind: 'ok', msg: 'Bluesky account connected.' }
  if (linked === 'already-linked')
    return { kind: 'error', msg: 'That account is already connected to another all.haus profile.' }
  if (linked === 'error') return { kind: 'error', msg: 'Connection failed. Please try again.' }
  return null
}

export function SettingsPanel({
  inOverlay = false,
  initialLinked = null,
  initialFollows = null,
}: {
  inOverlay?: boolean
  initialLinked?: string | null
  // Post-link follow-import offer count (FOLLOW-GRAPH-IMPORT-ADR §7.1) —
  // appended by the gateway's Bluesky callback while the import flag is live.
  initialFollows?: string | null
}) {
  const { user, loading } = useAuth()
  const router = useRouter()
  const [showExport, setShowExport] = useState(false)
  const [banner, setBanner] = useState<{ kind: 'ok' | 'error'; msg: string } | null>(
    () => bannerFor(initialLinked),
  )

  useEffect(() => { if (!inOverlay && !loading && !user) router.push('/auth?mode=login') }, [inOverlay, user, loading, router])

  // Auto-dismiss the connect banner. WorkspaceView already strips the overlay
  // params from the URL, so there's nothing to router.replace away here.
  useEffect(() => {
    if (!banner) return
    const t = setTimeout(() => setBanner(null), 5000)
    return () => clearTimeout(t)
  }, [banner])

  // A successful social connect just changed the user's network presences, but
  // useLinkedAccounts holds a module-level cache that otherwise survives until a
  // full reload — so a card's reply box would keep showing "set one up" until
  // then. Bust the cache on return so every open surface refreshes in place.
  useEffect(() => {
    if (initialLinked === 'bluesky' || initialLinked === 'mastodon') {
      invalidateLinkedAccounts()
    }
  }, [initialLinked])

  if (loading || !user) {
    const skeleton = (
      <>
        <div className="h-6 w-32 animate-pulse bg-glasshouse-well mb-8" />
        <div className="space-y-6">
          {[1, 2, 3].map(i => <div key={i} className="h-24 animate-pulse bg-glasshouse-well" />)}
        </div>
      </>
    )
    return inOverlay ? skeleton : <PageShell width="article">{skeleton}</PageShell>
  }

  const body = (
    <>
      {inOverlay && <PageHeader title="Settings" />}
      <div className="space-y-12">
        {banner && (
          <div className={`px-4 py-3 text-ui-sm ${banner.kind === 'ok' ? 'bg-green-50 text-green-800' : 'bg-red-50 text-red-800'}`}>
            {banner.msg}
          </div>
        )}

        {/* Post-link follow-import offer (FOLLOW-GRAPH-IMPORT-ADR §7.1) —
            separate from the transient banner so it outlives the auto-dismiss.
            The component gates itself on the server capability (so the
            mastodon offer stays hidden while the §6.6 AP sub-brake is on).

            The profile-consent offer beside it (PROFILE-PANE-REDESIGN-ADR D7)
            is a SEPARATE component for that very reason: folded into the import
            offer it would inherit a gate that has nothing to do with it and go
            dark whenever FOLLOW_IMPORT_ENABLED is off. Two offers, two gates. */}
        {(initialLinked === 'bluesky' || initialLinked === 'mastodon') && (
          <>
            <PostLinkProfileOffer network={initialLinked} />
            <PostLinkImportOffer
              network={initialLinked}
              follows={
                initialFollows && /^\d+$/.test(initialFollows)
                  ? parseInt(initialFollows, 10)
                  : null
              }
            />
          </>
        )}

        <SettingsGroup title="Account">
          <SettingsSection label="Profile">
            <ProfileSection />
          </SettingsSection>
          <SettingsSection label="Email">
            <EmailChange />
          </SettingsSection>
          <SettingsSection label="Payment & payouts" dataExplain="settings.payment">
            <PaymentSection />
          </SettingsSection>
          <SettingsSection
            dataExplain="settings.reach"
            label="Reach other networks"
            description="Your all.haus account is a Nostr identity. Reach outward to other networks — link an account you already have, or have all.haus set one up and run it for you."
          >
            <NetworkReachPanel />
          </SettingsSection>
        </SettingsGroup>

        <SettingsGroup title="Preferences">
          <SettingsSection
            label="Notifications"
            description="Choose which events generate notifications."
          >
            <NotificationPreferences />
          </SettingsSection>
          <SettingsSection label="Reading">
            <ReadingPreferences />
          </SettingsSection>
          <SettingsSection label="Display" description="Applies to this device.">
            <div className="space-y-4">
              <SettingsRow
                label="Theme"
                description="Light or dark across the site. System follows your device."
                dataExplain="settings.theme"
              >
                <ColorModeControl />
              </SettingsRow>
              <SettingsRow
                label="Type size"
                description="Scales text across the whole site."
                dataExplain="settings.typeSize"
              >
                <TypeSizeControl />
              </SettingsRow>
            </div>
          </SettingsSection>
        </SettingsGroup>

        <SettingsGroup title="Your data">
          <SettingsSection
            label="Export my data"
            description="Download your data, receipts, and content keys."
          >
            <button onClick={() => setShowExport(true)} data-explain="settings.export" className="btn">Export</button>
          </SettingsSection>
        </SettingsGroup>

        <DangerZone />
      </div>

      {showExport && <ExportModal onClose={() => setShowExport(false)} />}
    </>
  )

  if (inOverlay) return body
  return <PageShell width="article" title="Settings">{body}</PageShell>
}
