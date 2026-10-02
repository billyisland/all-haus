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
import { BlockList } from '../social/BlockList'
import { MuteList } from '../social/MuteList'
import { DmFeeSettings } from '../social/DmFeeSettings'
import { VouchList } from '../trust/VouchList'
import { trustEnabled } from '../../lib/featureFlags'
import { NotificationPreferences } from '../social/NotificationPreferences'
import { ReadingPreferences } from './ReadingPreferences'
import { TypeSizeControl } from './TypeSizeControl'
import { ColorModeControl } from './ColorModeControl'
// ThemeSection retired from Settings (GLASSHOUSE-AND-PALETTE-ADR §III.5) — the
// preset-theme picker is no longer user-facing; the file is parked, not deleted.
import { ExportPanel } from './ExportPanel'
import { DangerZone } from './DangerZone'
import { PageShell, PageHeader } from '../ui/PageShell'
import { SettingsGroup, SettingsSection, SettingsRow } from './SettingsSection'
import {
  SETTINGS_TITLE,
  SETTINGS_GROUP_ACCOUNT, SETTINGS_PROFILE_LABEL, SETTINGS_EMAIL_LABEL, SETTINGS_PAYMENT_LABEL, SETTINGS_PAYMENT_LABEL_READER,
  SETTINGS_REACH_LABEL, SETTINGS_REACH_DESCRIPTION,
  SETTINGS_GROUP_PREFERENCES, SETTINGS_NOTIFICATIONS_LABEL, SETTINGS_NOTIFICATIONS_DESCRIPTION,
  SETTINGS_BLOCKED_LABEL, SETTINGS_MUTED_LABEL, SETTINGS_READING_LABEL,
  SETTINGS_GROUP_DATA, SETTINGS_EXPORT_LABEL, SETTINGS_EXPORT_DESCRIPTION, SETTINGS_EXPORT_BUTTON,
  SETTINGS_GROUP_LEGAL, SETTINGS_LEGAL_READ,
  LEGAL_TERMS_LABEL, LEGAL_TERMS_DESCRIPTION, LEGAL_PRIVACY_LABEL, LEGAL_PRIVACY_DESCRIPTION,
  LEGAL_READER_TERMS_LABEL, LEGAL_READER_TERMS_DESCRIPTION,
  LEGAL_WRITER_AGREEMENT_LABEL, LEGAL_WRITER_AGREEMENT_DESCRIPTION,
  connectBannerFor, type ConnectBanner,
} from '../../content/settings'

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
  const [banner, setBanner] = useState<ConnectBanner | null>(
    () => connectBannerFor(initialLinked),
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
      {inOverlay && <PageHeader title={SETTINGS_TITLE} />}
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

        <SettingsGroup title={SETTINGS_GROUP_ACCOUNT}>
          <SettingsSection label={SETTINGS_PROFILE_LABEL}>
            <ProfileSection />
          </SettingsSection>
          <SettingsSection label={SETTINGS_EMAIL_LABEL}>
            <EmailChange />
          </SettingsSection>
          <SettingsSection
            label={user.canWrite ? SETTINGS_PAYMENT_LABEL : SETTINGS_PAYMENT_LABEL_READER}
            dataExplain={user.canWrite ? "settings.payment" : "settings.paymentReader"}
          >
            <PaymentSection />
          </SettingsSection>
          <SettingsSection
            dataExplain="settings.reach"
            label={SETTINGS_REACH_LABEL}
            description={SETTINGS_REACH_DESCRIPTION}
          >
            <NetworkReachPanel />
          </SettingsSection>
        </SettingsGroup>

        <SettingsGroup title={SETTINGS_GROUP_PREFERENCES}>
          <SettingsSection
            label={SETTINGS_NOTIFICATIONS_LABEL}
            description={SETTINGS_NOTIFICATIONS_DESCRIPTION}
          >
            <NotificationPreferences />
          </SettingsSection>
          {/* THE QUIET LISTS, from the dissolved Network page (2026-09-15).
              They sat behind tab pills there but had always been written in
              this register — a label over a well of rows with an undo each —
              which is why that page had to wrap each one in a second well to
              pass it off as a tab panel. Here `SettingsSection` supplies the
              label and the card and they render bare content, so there is one
              settings grammar rather than a tabbed imitation of one.

              They are two sections, not one "Blocked and muted": each is a
              self-contained list with its own empty state, and each carries
              its own Explain anchor, which a merged section could not. They
              sit beside Notifications because all four of the things in this
              run answer the same question — who reaches you, and how loudly. */}
          <SettingsSection label={SETTINGS_BLOCKED_LABEL} dataExplain="settings.blocked">
            <BlockList />
          </SettingsSection>
          <SettingsSection label={SETTINGS_MUTED_LABEL} dataExplain="settings.muted">
            <MuteList />
          </SettingsSection>
          {/* Vouches followed the same reasoning — a management list, so it
              lands in Settings rather than on the public profile — and stays
              behind the parked trust flag, which is why nothing renders here
              today. Its old address was /network?tab=vouches; the shim now
              sends that here. */}
          {trustEnabled() && (
            <SettingsSection label="Vouches">
              <VouchList />
            </SettingsSection>
          )}
          {/* Suspended, and it draws its own box — see the component. A
              `SettingsSection` around it would paint an empty well whenever it
              returns null, which is every render while priced DMs are off. */}
          <DmFeeSettings />
          <SettingsSection label={SETTINGS_READING_LABEL}>
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

        <SettingsGroup title={SETTINGS_GROUP_DATA}>
          <SettingsSection
            label={SETTINGS_EXPORT_LABEL}
            description={SETTINGS_EXPORT_DESCRIPTION}
          >
            {/* The two exports reveal IN the section (CA-E9) — there is
                nothing modal about two rows, and a pane floated over the
                settings Glasshouse was a hand-rolled scrim with a by-name
                exemption from the one-close-affordance rule. */}
            {showExport ? (
              <ExportPanel />
            ) : (
              <button onClick={() => setShowExport(true)} data-explain="settings.export" className="btn">{SETTINGS_EXPORT_BUTTON}</button>
            )}
          </SettingsSection>
        </SettingsGroup>

        {/* THE FOUR DOCUMENTS THAT BIND, reachable from inside the account
            rather than only from the logged-out register — a term you can be
            held to and cannot find is not much of a term. The order is the
            order they reach a member: the Terms and the Privacy Policy apply
            from the moment there is an account, the other two are accepted by
            version at a gesture (a card, a paid publish). They open in a
            NEW TAB: Settings is a workspace Glasshouse, and a same-tab
            navigation to a standalone page is exactly the escape the overlay
            rules exist to stop. A new tab is also what you want of a document
            you are checking something against. */}
        <SettingsGroup title={SETTINGS_GROUP_LEGAL}>
          <SettingsSection
            label={LEGAL_TERMS_LABEL}
            description={LEGAL_TERMS_DESCRIPTION}
          >
            <a
              href="/terms"
              target="_blank"
              rel="noopener noreferrer"
              className="btn"
            >
              {SETTINGS_LEGAL_READ}
            </a>
          </SettingsSection>
          <SettingsSection
            label={LEGAL_PRIVACY_LABEL}
            description={LEGAL_PRIVACY_DESCRIPTION}
          >
            <a
              href="/privacy"
              target="_blank"
              rel="noopener noreferrer"
              className="btn"
            >
              {SETTINGS_LEGAL_READ}
            </a>
          </SettingsSection>
          <SettingsSection
            label={LEGAL_READER_TERMS_LABEL}
            description={LEGAL_READER_TERMS_DESCRIPTION}
          >
            <a
              href="/reader-terms"
              target="_blank"
              rel="noopener noreferrer"
              className="btn"
            >
              {SETTINGS_LEGAL_READ}
            </a>
          </SettingsSection>
          <SettingsSection
            label={LEGAL_WRITER_AGREEMENT_LABEL}
            description={LEGAL_WRITER_AGREEMENT_DESCRIPTION}
          >
            <a
              href="/writer-agreement"
              target="_blank"
              rel="noopener noreferrer"
              className="btn"
            >
              {SETTINGS_LEGAL_READ}
            </a>
          </SettingsSection>
        </SettingsGroup>

        <DangerZone />
      </div>

    </>
  )

  if (inOverlay) return body
  return <PageShell width="article" title={SETTINGS_TITLE}>{body}</PageShell>
}
