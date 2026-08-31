'use client'

// =============================================================================
// PostLinkProfileOffer — the invitation to set `show_on_profile` on a presence
// that has just been linked (PROFILE-PANE-REDESIGN-ADR D7 / §8: "nothing
// invites a member to set it", so the `verified` identity tier renders for
// nobody until someone goes looking for the checkbox in settings).
//
// It rides the same ?linked= redirect channel as the connect banner and the
// follow-import offer, and sits beside the latter rather than inside it: the
// import offer gates itself on `followImportProtocols`, which is EMPTY while
// FOLLOW_IMPORT_ENABLED is dark — a consent folded into it would go dark with
// a brake that has nothing to do with it. Two offers, two gates, one moment.
//
// A PURE OFFER, like every D7 surface: nothing is published until the click.
// The trigger is the link event itself (the redirect param), so it is once per
// link with no seen-key to keep — the shape the once-per-member invariant asks
// for, one level down. Declining costs nothing: the checkbox stays in
// settings › network, which is also where it is turned back off.
// =============================================================================

import { useState } from 'react'
import { linkedAccounts, type LinkedAccount } from '../../lib/api/linked-accounts'
import {
  useLinkedAccounts,
  invalidateLinkedAccounts,
} from '../../hooks/useLinkedAccounts'

const PROTOCOL: Record<'bluesky' | 'mastodon', LinkedAccount['protocol']> = {
  bluesky: 'atproto',
  mastodon: 'activitypub',
}

const LABEL: Record<'bluesky' | 'mastodon', string> = {
  bluesky: 'Bluesky',
  mastodon: 'Mastodon',
}

export function PostLinkProfileOffer({
  network,
}: {
  network: 'bluesky' | 'mastodon'
}) {
  const accounts = useLinkedAccounts()
  const [done, setDone] = useState(false)
  const [busy, setBusy] = useState(false)
  const [dismissed, setDismissed] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const account =
    accounts?.find(a => a.protocol === PROTOCOL[network]) ?? null

  // Nothing to ask for if the presence isn't there, the consent is already
  // given, or the gateway is old enough not to know the field (undefined, not
  // false — the api type says so, and treating "absent" as "off" would offer a
  // consent the server would then drop on the floor).
  if (
    dismissed ||
    !account ||
    account.showOnProfile === undefined ||
    (account.showOnProfile && !done)
  )
    return null

  async function accept() {
    if (!account) return
    setBusy(true)
    setError(null)
    try {
      await linkedAccounts.update(account.id, { showOnProfile: true })
      invalidateLinkedAccounts()
      setDone(true)
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to update')
    } finally {
      setBusy(false)
    }
  }

  if (done) {
    return (
      <div className="bg-glasshouse-well/40 px-4 py-3">
        <p className="text-ui-sm text-black">
          Your {LABEL[network]} handle now appears on your profile. Turn it off
          any time in &ldquo;Reach other networks&rdquo;.
        </p>
      </div>
    )
  }

  return (
    <div className="bg-glasshouse-well/40 px-4 py-3 space-y-2">
      <p className="text-ui-sm text-black">
        Show your {LABEL[network]} handle on your all.haus profile?
      </p>
      {/* Says what the display DOES, because the profile pages are SSR'd
          share/SEO surfaces: this publishes the connection to anyone who opens
          the profile, which is a different act from letting us post through it
          (that consent is `Default on`, and it was not asked for here). */}
      <p className="text-ui-xs text-grey-600 leading-relaxed">
        It joins the &ldquo;also known as&rdquo; row as a{' '}
        <span className="label-ui">VERIFIED</span> identity — you proved it, so
        anyone reading your profile can see it is yours. Public, including to
        logged-out visitors. Separate from cross-posting, and reversible.
      </p>
      {error && <p className="text-ui-xs text-red-600">{error}</p>}
      <div className="flex gap-3">
        <button onClick={() => void accept()} disabled={busy} className="btn-text">
          Show it
        </button>
        <button onClick={() => setDismissed(true)} className="btn-text-muted">
          Keep it private
        </button>
      </div>
    </div>
  )
}
