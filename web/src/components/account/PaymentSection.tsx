'use client'

import { useState } from 'react'
import { useAuth } from '../../stores/auth'
import { auth } from '../../lib/api'
import { apiErrorMessage } from '../../lib/api/client'
import { CardSetup } from '../payment/CardSetup'
import { CardActionRequired } from './CardActionRequired'
import { PayoutPreferences } from './PayoutPreferences'
import {
  CARD_CONNECTED,
  CARD_CONNECTED_HELP,
  CARD_ACTIVE,
  CARD_REMOVE,
  CARD_REMOVE_CONSEQUENCE,
  CARD_REMOVE_CONFIRM,
  CARD_REMOVE_KEEP,
  CARD_REMOVE_FAILED,
  CARD_ADD_TITLE,
  CARD_ADD_HELP,
  CONNECT_TITLE,
  CONNECT_VERIFIED,
  CONNECT_VERIFIED_LABEL,
  CONNECT_NEEDED,
  CONNECT_SET_UP,
  CONNECT_FAILED,
} from '../../content/money-settings'

export function PaymentSection() {
  const { user, fetchMe } = useAuth()
  const [connecting, setConnecting] = useState(false)
  const [connectError, setConnectError] = useState<string | null>(null)
  const [removing, setRemoving] = useState(false)
  const [confirmingRemove, setConfirmingRemove] = useState(false)
  const [removeError, setRemoveError] = useState<string | null>(null)

  if (!user) return null

  async function handleConnectStripe() {
    setConnecting(true); setConnectError(null)
    try {
      const result = await auth.connectStripe()
      window.location.href = result.stripeConnectUrl
    } catch {
      setConnectError(CONNECT_FAILED)
      setConnecting(false)
    }
  }

  async function handleRemoveCard() {
    setRemoving(true); setRemoveError(null)
    try {
      await auth.removeCard()
      setConfirmingRemove(false)
      // The card is the session's own `hasPaymentMethod`, and several surfaces
      // read it; one fetchMe moves all of them.
      await fetchMe()
    } catch (err) {
      setRemoveError(apiErrorMessage(err) ?? CARD_REMOVE_FAILED)
    } finally {
      setRemoving(false)
    }
  }

  return (
    <div className="space-y-5">
        {/* A frozen tab outranks everything else on this section: the reader is
            here precisely because something is wrong with their card, and the
            "Card connected" row below would otherwise reassure them that all is
            well while settlement has stopped. */}
        <CardActionRequired since={user.cardActionRequiredAt} />

        {/* Card on file */}
        <div>
          {user.hasPaymentMethod ? (
            <>
              <div className="flex items-center justify-between">
                <div>
                  <p className="text-ui-sm text-black">{CARD_CONNECTED}</p>
                  <p className="text-ui-xs text-grey-300 mt-0.5">{CARD_CONNECTED_HELP}</p>
                </div>
                <span className="label-ui text-grey-400">{CARD_ACTIVE}</span>
              </div>

              {/* Reader Terms 2.4 — the sentence is the Terms', near enough
                  word for word, because this is the one control whose effect a
                  reader is most likely to misread: removing the card pauses
                  paid reading and does NOT clear what is already owed. Saying
                  only "remove" would leave them to discover the second half
                  from a tab that would not go away. */}
              <div className="mt-4">
                {confirmingRemove ? (
                  <div>
                    <p className="text-ui-xs text-grey-600 mb-3 leading-relaxed">
                      {CARD_REMOVE_CONSEQUENCE}
                    </p>
                    <div className="flex items-center gap-4">
                      <button
                        type="button"
                        onClick={() => void handleRemoveCard()}
                        disabled={removing}
                        className="btn-text-danger disabled:opacity-50"
                      >
                        {removing ? 'Removing…' : CARD_REMOVE_CONFIRM}
                      </button>
                      <button
                        type="button"
                        onClick={() => { setConfirmingRemove(false); setRemoveError(null) }}
                        className="btn-text-muted"
                      >
                        {CARD_REMOVE_KEEP}
                      </button>
                    </div>
                  </div>
                ) : (
                  <button
                    type="button"
                    onClick={() => setConfirmingRemove(true)}
                    className="btn-text-muted"
                  >
                    {CARD_REMOVE}
                  </button>
                )}
                {removeError && <p className="text-ui-xs text-crimson mt-2">{removeError}</p>}
              </div>
            </>
          ) : (
            <div>
              <p className="text-ui-sm text-black mb-2">{CARD_ADD_TITLE}</p>
              <p className="text-ui-xs text-grey-400 mb-3">{CARD_ADD_HELP}</p>
              <CardSetup onSuccess={() => fetchMe()} />
            </div>
          )}
        </div>

        {/* Stripe Connect — a WRITER's (READER-WRITER-SPLIT-ADR §2 item 6).
            A reader has nothing to be paid: the backfill made every earner a
            writer and the recipient side stops new ones, so `canWrite` alone
            decides. The server still lets a reader holding earnings onboard;
            anything that un-darks a way to pay a reader reopens this gate. */}
        {user.canWrite && (
        <div>
          {user.stripeConnectKycComplete ? (
            <>
              <div className="flex items-center justify-between">
                <div>
                  <p className="text-ui-sm text-black">{CONNECT_TITLE}</p>
                  <p className="text-ui-xs text-grey-300 mt-0.5">{CONNECT_VERIFIED}</p>
                </div>
                <span className="label-ui text-grey-400">{CONNECT_VERIFIED_LABEL}</span>
              </div>

              {/* When and how much (L5.3; Writer 6.3). Gated on the same column
                  the payout cycle reads: a writer who cannot be paid has no
                  schedule to choose, and offering the control would be a
                  setting that changes nothing. It appears the moment Connect
                  verifies, which is the moment it starts to mean something. */}
              <div className="mt-5">
                <PayoutPreferences />
              </div>
            </>
          ) : (
            <div>
              <div className="flex items-center justify-between">
                <div>
                  <p className="text-ui-sm text-black">{CONNECT_TITLE}</p>
                  <p className="text-ui-xs text-grey-300 mt-0.5">{CONNECT_NEEDED}</p>
                </div>
                <button
                  onClick={handleConnectStripe}
                  disabled={connecting}
                  className="text-ui-xs text-crimson hover:text-crimson-dark underline underline-offset-4 disabled:opacity-50"
                >
                  {connecting ? 'Setting up…' : CONNECT_SET_UP}
                </button>
              </div>
              {connectError && <p className="text-ui-xs text-red-600 mt-2">{connectError}</p>}
            </div>
          )}
        </div>
        )}
    </div>
  )
}
