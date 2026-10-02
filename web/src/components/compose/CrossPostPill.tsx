'use client'

import type { LinkedAccount } from '../../lib/api'
import { CROSS_POST_LABELS } from '../../hooks/useNoteComposer'

// One per linked network that can receive an original post, on BOTH compose
// surfaces. Its resting state is the account's own `crossPostDefault`; a press
// is the per-note override (`useNoteComposer`).
export function CrossPostPill({
  account,
  active,
  onToggle,
}: {
  account: LinkedAccount
  active: boolean
  onToggle: () => void
}) {
  const label = CROSS_POST_LABELS[account.protocol] ?? account.protocol.toUpperCase()
  return (
    <button
      type="button"
      onClick={onToggle}
      aria-pressed={active}
      data-explain="composer.crosspost"
      title={
        active
          ? `Will also post to ${label}${account.externalHandle ? ` (@${account.externalHandle})` : ''}`
          : `Not posting to ${label} this time`
      }
      className={`label-ui toggle-chip ${active ? 'toggle-chip-active' : 'toggle-chip-inactive'}`}
    >
      {label}
    </button>
  )
}
