import type { MySubscription, PayoutPreferences, PayoutCadence } from '../../lib/api/account'
import type { OfferLookup } from '../../lib/api/drives'
import { TERMS_PURPOSE } from '../../content/terms-consent'
import { paywallCardLink } from '../../content/paywall'
import {
  pounds,
  LEDGER_OWE_LABEL,
  LEDGER_TAB_CLEAR,
  LEDGER_TAB_OWING,
  LEDGER_OWED_LABEL,
  LEDGER_OWED_HELP,
  LEDGER_REFUND_LABEL,
  LEDGER_REFUND_HELP,
  LEDGER_ALLOWANCE_LABEL,
  ledgerAllowanceFigure,
  LEDGER_READERS_PAID_LABEL,
  LEDGER_FEE_LABEL,
  LEDGER_FEE_HELP,
  LEDGER_ALLOWANCE_GIVEN_LABEL,
  ledgerAllowanceGivenSentence,
  CARD_DECLINED_LABEL,
  CARD_DECLINED_BODY,
  CARD_DECLINED_AFTER,
  CARD_DECLINED_ACTION,
  settleNowLabel,
  LEDGER_CATEGORY_LABELS,
  LEDGER_COLUMNS,
  LEDGER_EMPTY,
  LEDGER_RECEIPT,
  LEDGER_ALL_READS,
  LEDGER_PAID_ONLY,
  ledgerAmount,
  RECEIPT_HEADING,
  RECEIPT_ITEMISED_ELSEWHERE,
  RECEIPT_FREE_ALLOWANCE,
  RECEIPT_REVERSED,
  receiptCarriedSentence,
  receiptShortfallSentence,
  DISCHARGE_SENTENCE,
  SUBSCRIPTIONS_HEADING,
  subscriptionTerm,
  subscriptionMonthly,
  SUBSCRIPTION_NOTIFY_TITLE,
  SUBSCRIPTION_VISIBILITY_TITLE,
  SUBSCRIPTION_CANCEL,
  SUBSCRIPTION_CANCELLED,
  subscribeMonthlyLabel,
  subscribeAnnualLabel,
  SUBSCRIBE_ACCEPT,
  SUBSCRIBED,
} from '../../content/ledger'
import {
  CARD_CONNECTED,
  CARD_CONNECTED_HELP,
  CARD_REMOVE,
  CARD_ADD_TITLE,
  CARD_ADD_HELP,
  CONNECT_TITLE,
  CONNECT_VERIFIED,
  CONNECT_NEEDED,
  CONNECT_SET_UP,
  PAYOUT_CADENCE_LABEL,
  PAYOUT_CADENCE_HELP,
  PAYOUT_PREFS_UNAVAILABLE,
  PAYOUT_HOW_OFTEN,
  PAYOUT_THRESHOLD_LABEL,
  payoutFloorSentence,
} from '../../content/money-settings'
import {
  OFFER_FOR_YOU_TITLE,
  OFFER_FOR_YOU_BODY,
  OFFER_FOR_YOU_ACTION,
  OFFER_UNAVAILABLE_TITLE,
  OFFER_UNAVAILABLE_FALLBACK,
  offerKind,
  offerWriterLead,
  offerWasPrice,
  offerPrice,
  offerDiscount,
  offerTerms,
  OFFER_SIGN_IN,
  offerButton,
} from '../../content/subscribe-offer'
import { query } from '../gateway'
import { PostForm, Hidden, Time, NextLink, Unavailable, type Viewer, type ViewerMoney } from '../html'
import { TermsConsentBox } from '../consent'
import { registerLink, type LedgerData, type Receipt, type StatementEntry } from '../money-loaders'

// =============================================================================
// modernhaus — the money pages (§D2.3, §D2.6 E5 rows).
//
// Money is always a TABLE: a caption, `<th scope="row">` labels, amounts where
// the browser puts them. What you owe and what you are owed are two rows that
// never meet (money.md: two figures the platform will never settle against
// each other are never subtracted), and a figure the page could not read is
// "unavailable", never £0.00. Every sentence is the full site's
// (`content/ledger.ts`, `content/money-settings.ts`, `content/subscribe-offer.ts`).
//
// Adding a card LINKS OUT to the full site (Decision 2): a card is entered in
// Stripe's own fields, which need script. `/settings` is the full site's
// address for it.
// =============================================================================

const CARD_HOME = '/settings'

// The cadences in the full site's order, off the labels' own keys: a value
// import from `lib/api/*` would pull its browser-relative client in (§D2.7).
const CADENCES = Object.keys(PAYOUT_CADENCE_LABEL) as PayoutCadence[]

function shortDate(iso: string): string {
  const d = new Date(iso)
  return Number.isNaN(d.getTime()) ? '' : d.toLocaleDateString('en-GB', { day: 'numeric', month: 'short', timeZone: 'Europe/London' })
}

/** Where a card is the fix: the full site's settings, which take it (Decision 2). */
export function CardFix(props: { money: ViewerMoney | undefined }) {
  return (
    <p>
      <a href={CARD_HOME}>{paywallCardLink(props.money?.hasPaymentMethod ?? false)}</a>
      {' — on the full site, which takes the card.'}
    </p>
  )
}

/** The declined-card notice (CardActionRequired): before the figures, because it is why they stopped moving. */
export function CardDeclined(props: { money: ViewerMoney | undefined }) {
  if (!props.money?.cardActionRequiredAt) return null
  return (
    <section>
      <h2>{CARD_DECLINED_LABEL}</h2>
      <p>{CARD_DECLINED_BODY}</p>
      <p>{CARD_DECLINED_AFTER}</p>
      <p>
        <a href={CARD_HOME}>{CARD_DECLINED_ACTION}</a>
        {' — on the full site, which takes the card.'}
      </p>
    </section>
  )
}

// ---------------------------------------------------------------------------
// /modernhaus/ledger
// ---------------------------------------------------------------------------

function Figures(props: { data: LedgerData }) {
  const { tab, earnings } = props.data
  const showEarned = !!earnings && earnings.pendingTransferPence > 0
  const showRefund = tab.refundDuePence > 0
  const showFee = !!earnings && earnings.grossPence > 0
  const showGiven = !!earnings && earnings.allowanceCoveredPence > 0
  return (
    <>
      <table>
        <caption>Your figures</caption>
        <tbody>
          <tr>
            <th scope="row">{LEDGER_OWE_LABEL}</th>
            <td>{pounds(tab.tabBalancePence)}</td>
          </tr>
          {showRefund && (
            <tr>
              <th scope="row">{LEDGER_REFUND_LABEL}</th>
              <td>{pounds(tab.refundDuePence)}</td>
            </tr>
          )}
          {showEarned && (
            <tr>
              <th scope="row">{LEDGER_OWED_LABEL}</th>
              <td>{pounds(earnings.pendingTransferPence)}</td>
            </tr>
          )}
          {tab.freeAllowanceTotalPence > 0 && (
            <tr>
              <th scope="row">{LEDGER_ALLOWANCE_LABEL}</th>
              <td>{ledgerAllowanceFigure(tab.freeAllowanceRemainingPence, tab.freeAllowanceTotalPence)}</td>
            </tr>
          )}
          {showFee && (
            <>
              <tr>
                <th scope="row">{LEDGER_READERS_PAID_LABEL}</th>
                <td>{pounds(earnings.grossPence)}</td>
              </tr>
              <tr>
                <th scope="row">{LEDGER_FEE_LABEL}</th>
                <td>{`−${pounds(earnings.feePence)}`}</td>
              </tr>
            </>
          )}
          {showGiven && (
            <tr>
              <th scope="row">{LEDGER_ALLOWANCE_GIVEN_LABEL}</th>
              <td>{pounds(earnings.allowanceCoveredPence)}</td>
            </tr>
          )}
        </tbody>
      </table>
      <p>{tab.tabBalancePence === 0 ? LEDGER_TAB_CLEAR : LEDGER_TAB_OWING}</p>
      {showRefund && <p>{LEDGER_REFUND_HELP}</p>}
      {showEarned && <p>{LEDGER_OWED_HELP}</p>}
      {showFee && <p>{LEDGER_FEE_HELP}</p>}
      {showGiven && <p>{ledgerAllowanceGivenSentence(earnings.allowanceReadCount)}</p>}
      {!earnings && <Unavailable what="Your earnings" />}
    </>
  )
}

function StatementRow(props: { entry: StatementEntry }) {
  const e = props.entry
  const href = registerLink(e.link)
  return (
    <tr>
      <td>{shortDate(e.date)}</td>
      <td>{LEDGER_CATEGORY_LABELS[e.category] ?? e.category}</td>
      <td>
        {href ? <a href={href}>{e.description}</a> : e.description}
        {e.ref_id && (
          <>
            {' · '}
            <a href={`/modernhaus/ledger/receipt/${encodeURIComponent(e.ref_id)}`}>{LEDGER_RECEIPT}</a>
          </>
        )}
      </td>
      <td>{ledgerAmount(e)}</td>
    </tr>
  )
}

function SubscriptionRow(props: { sub: MySubscription; csrf: string }) {
  const s = props.sub
  const name = s.writerDisplayName ?? s.writerUsername
  const active = s.status === 'active'
  return (
    <li>
      <p>
        <a href={`/modernhaus/u/${encodeURIComponent(s.writerUsername)}`}>{name}</a>
        {` · ${subscriptionMonthly(s.pricePence)} · ${subscriptionTerm(s)}`}
      </p>
      <PostForm action="subscription_notify" csrf={props.csrf}>
        <Hidden values={{ subscriptionId: s.id, return: '/modernhaus/ledger' }} />
        <p>
          {s.notifyOnPublish ? SUBSCRIPTION_NOTIFY_TITLE.on : SUBSCRIPTION_NOTIFY_TITLE.off}
          {active && (
            <>
              {' '}
              <button name="notify" value={s.notifyOnPublish ? 'off' : 'on'}>
                Change
              </button>
            </>
          )}
        </p>
        <p>
          {s.hidden ? SUBSCRIPTION_VISIBILITY_TITLE.hidden : SUBSCRIPTION_VISIBILITY_TITLE.public}{' '}
          <button formAction="/modernhaus/do/subscription_visibility" name="hidden" value={s.hidden ? 'no' : 'yes'}>
            Change
          </button>
          <input type="hidden" name="writerId" value={s.writerId} />
        </p>
      </PostForm>
      <p>
        {active ? (
          <a href={`/modernhaus/confirm/subscription_cancel${query({ writerId: s.writerId, return: '/modernhaus/ledger' })}`}>
            {SUBSCRIPTION_CANCEL}
          </a>
        ) : (
          SUBSCRIPTION_CANCELLED
        )}
      </p>
    </li>
  )
}

export function LedgerPage(props: { data: LedgerData; viewer: Viewer; csrf: string }) {
  const { data, viewer } = props
  const money = viewer.money
  const statement = data.statement
  const base = '/modernhaus/ledger'
  const nextOffset = statement?.hasMore ? data.offset + statement.entries.length : null
  return (
    <>
      <CardDeclined money={money} />
      <Figures data={data} />
      {data.tab.tabBalancePence > 0 && money?.hasPaymentMethod && !money.cardActionRequiredAt && (
        <PostForm action="tab_settle" csrf={props.csrf}>
          <Hidden values={{ return: base }} />
          <p>
            <button>{settleNowLabel(data.tab.tabBalancePence)}</button>
          </p>
        </PostForm>
      )}
      <p>
        <a href="/modernhaus/settings/money">Card and payouts</a>
      </p>

      <h2>Statement</h2>
      <p>
        {data.freeReads ? (
          <a href={base}>{LEDGER_PAID_ONLY}</a>
        ) : (
          <a href={`${base}${query({ free: '1' })}`}>{LEDGER_ALL_READS}</a>
        )}
        {' · '}
        <a href="/modernhaus/receipts/export">Download your read receipts</a>
      </p>
      {statement === null ? (
        <Unavailable what="Your statement" />
      ) : statement.entries.length === 0 ? (
        <p>{LEDGER_EMPTY}</p>
      ) : (
        <table>
          <caption>Statement</caption>
          <thead>
            <tr>
              <th scope="col">{LEDGER_COLUMNS.date}</th>
              <th scope="col">{LEDGER_COLUMNS.type}</th>
              <th scope="col">{LEDGER_COLUMNS.description}</th>
              <th scope="col">{LEDGER_COLUMNS.amount}</th>
            </tr>
          </thead>
          <tbody>
            {statement.entries.map((e) => (
              <StatementRow key={e.id} entry={e} />
            ))}
          </tbody>
        </table>
      )}
      <NextLink href={nextOffset === null ? null : `${base}${query({ offset: nextOffset, free: data.freeReads ? '1' : null })}`} />

      {data.subscriptions === null ? (
        <>
          <h2>{SUBSCRIPTIONS_HEADING}</h2>
          <Unavailable what="Your subscriptions" />
        </>
      ) : (
        data.subscriptions.length > 0 && (
          <>
            <h2>{SUBSCRIPTIONS_HEADING}</h2>
            <ul>
              {data.subscriptions.map((s) => (
                <SubscriptionRow key={s.id} sub={s} csrf={props.csrf} />
              ))}
            </ul>
          </>
        )
      )}
    </>
  )
}

// ---------------------------------------------------------------------------
// /modernhaus/ledger/receipt/<settlementId>
// ---------------------------------------------------------------------------

export function ReceiptPage(props: { receipt: Receipt }) {
  const r = props.receipt
  return (
    <>
      <table>
        <caption>The charge</caption>
        <tbody>
          <tr>
            <th scope="row">Charged</th>
            <td>{pounds(r.amountPence)}</td>
          </tr>
          <tr>
            <th scope="row">On</th>
            <td>
              <Time at={new Date(r.settledAt)} />
            </td>
          </tr>
        </tbody>
      </table>
      {r.reversedAt && <p>{RECEIPT_REVERSED}</p>}
      <h2>{RECEIPT_HEADING}</h2>
      {r.items.length === 0 ? (
        <p>{RECEIPT_ITEMISED_ELSEWHERE}</p>
      ) : (
        <table>
          <caption>{RECEIPT_HEADING}</caption>
          <tbody>
            {r.items.map((item, i) => {
              const href = registerLink(item.link)
              return (
                <tr key={i}>
                  <th scope="row">
                    {href ? <a href={href}>{item.description}</a> : item.description}
                    {' — '}
                    {item.writerUsername ? (
                      <a href={`/modernhaus/u/${encodeURIComponent(item.writerUsername)}`}>{item.writerName}</a>
                    ) : (
                      item.writerName
                    )}
                  </th>
                  <td>{item.pricePence === 0 ? `£0.00 ${RECEIPT_FREE_ALLOWANCE}` : pounds(item.pricePence)}</td>
                </tr>
              )
            })}
          </tbody>
        </table>
      )}
      {r.unitemisedPence > 0 && <p>{receiptCarriedSentence(r.unitemisedPence)}</p>}
      {r.unitemisedPence < 0 && <p>{receiptShortfallSentence(r.unitemisedPence)}</p>}
      <p>{DISCHARGE_SENTENCE}</p>
      <p>
        <a href="/modernhaus/ledger">Back to the Ledger</a>
      </p>
    </>
  )
}

// ---------------------------------------------------------------------------
// /modernhaus/subscribe/<code>
// ---------------------------------------------------------------------------

export function OfferSignInPage(props: { self: string }) {
  return (
    <>
      <p>{OFFER_FOR_YOU_BODY}</p>
      <p>
        <a href={`/modernhaus/signin${query({ return: props.self })}`}>{OFFER_FOR_YOU_ACTION}</a>
      </p>
    </>
  )
}
export { OFFER_FOR_YOU_TITLE, OFFER_UNAVAILABLE_TITLE }

export function OfferUnavailablePage(props: { sentence: string | null }) {
  return (
    <>
      <p>{props.sentence ?? OFFER_UNAVAILABLE_FALLBACK}</p>
      <p>
        <a href="/modernhaus">Go to the start</a>
      </p>
    </>
  )
}

export function OfferPage(props: {
  offer: OfferLookup
  code: string
  viewer: Viewer | null
  csrf: string
  self: string
  askTerms: boolean
  cardFix?: boolean
}) {
  const { offer } = props
  const name = offer.writerDisplayName ?? offer.writerUsername
  const isFree = offer.discountedPricePence === 0
  const terms = props.viewer?.terms?.reader
  return (
    <>
      <p>{offerKind(offer)}</p>
      <p>
        {offerWriterLead(offer)}
        <a href={`/modernhaus/u/${encodeURIComponent(offer.writerUsername)}`}>{name}</a>
      </p>
      <table>
        <caption>The offer</caption>
        <tbody>
          {!isFree && (
            <tr>
              <th scope="row">Usually</th>
              <td>{offerWasPrice(offer)}</td>
            </tr>
          )}
          <tr>
            <th scope="row">With this offer</th>
            <td>{offerPrice(offer)}</td>
          </tr>
          {!offer.isComp && (
            <tr>
              <th scope="row">Discount</th>
              <td>{offerDiscount(offer)}</td>
            </tr>
          )}
        </tbody>
      </table>
      <p>{offerTerms(offer)}</p>
      {!props.viewer ? (
        <p>
          <a href={`/modernhaus/signin${query({ return: props.self })}`}>{OFFER_SIGN_IN}</a>
        </p>
      ) : (
        <PostForm action="subscribe" csrf={props.csrf}>
          <Hidden
            values={{
              writerId: offer.writerId,
              offerCode: props.code,
              period: 'monthly',
              return: props.self,
              after: `/modernhaus/u/${encodeURIComponent(offer.writerUsername)}`,
            }}
          />
          {props.askTerms && terms ? (
            <>
              <TermsConsentBox kind="reader" purpose={TERMS_PURPOSE.subscribe} state={terms} />
              <p>
                <button>{SUBSCRIBE_ACCEPT}</button>
              </p>
            </>
          ) : (
            <p>
              <button>{offerButton(offer)}</button>
            </p>
          )}
        </PostForm>
      )}
      {props.cardFix && props.viewer && <CardFix money={props.viewer.money} />}
    </>
  )
}

// ---------------------------------------------------------------------------
// The profile's subscribe row (NativeProfileBody's, in this register).
// ---------------------------------------------------------------------------

export interface SubscriptionCheck {
  subscribed: boolean
  status?: string
  currentPeriodEnd?: string
}

export function SubscribeRow(props: {
  writerId: string
  monthlyPence: number
  annualDiscountPct: number
  check: SubscriptionCheck | null
  viewer: Viewer
  csrf: string
  self: string
  /** The last press was refused for want of the Reader Terms: the consent replaces the buttons. */
  askTerms: boolean
  /** The period that press asked for, so accepting resumes the same one. */
  period: 'monthly' | 'annual'
  /** The last press was refused for want of a working card. */
  cardFix?: boolean
}) {
  if (props.check === null) return <Unavailable what="Your subscription" />
  const annualPence = Math.round(props.monthlyPence * 12 * (1 - props.annualDiscountPct / 100))
  if (props.check.subscribed) {
    const cancelled = props.check.status === 'cancelled' && props.check.currentPeriodEnd
    return (
      <p>
        {cancelled
          ? subscriptionTerm({ status: 'cancelled', autoRenew: false, currentPeriodEnd: props.check.currentPeriodEnd as string })
          : SUBSCRIBED}
        {!cancelled && (
          <>
            {' · '}
            <a href={`/modernhaus/confirm/subscription_cancel${query({ writerId: props.writerId, return: props.self })}`}>
              {SUBSCRIPTION_CANCEL}
            </a>
          </>
        )}
      </p>
    )
  }
  const terms = props.viewer.terms?.reader
  return (
    <>
    {props.cardFix && <CardFix money={props.viewer.money} />}
    <PostForm action="subscribe" csrf={props.csrf}>
      <Hidden values={{ writerId: props.writerId, return: props.self }} />
      {props.askTerms && terms ? (
        <>
          <Hidden values={{ period: props.period }} />
          <TermsConsentBox kind="reader" purpose={TERMS_PURPOSE.subscribe} state={terms} />
          <p>
            <button>{SUBSCRIBE_ACCEPT}</button>
          </p>
        </>
      ) : (
        <p>
          <button name="period" value="monthly">
            {subscribeMonthlyLabel(props.monthlyPence)}
          </button>
          {props.annualDiscountPct > 0 && (
            <>
              {' '}
              <button name="period" value="annual">
                {subscribeAnnualLabel(annualPence)}
              </button>
            </>
          )}
        </p>
      )}
    </PostForm>
    </>
  )
}

// ---------------------------------------------------------------------------
// /modernhaus/settings/money
// ---------------------------------------------------------------------------

export interface PayoutFormValues {
  cadence: PayoutCadence
  threshold: string
}

export function MoneySettingsPage(props: {
  viewer: Viewer
  csrf: string
  prefs: PayoutPreferences | null
  /** A refused save re-renders with what was typed and the reason beside the field. */
  payoutValues?: PayoutFormValues
  payoutError?: string
}) {
  const money = props.viewer.money
  if (!money) return <Unavailable what="Your payment settings" />
  const prefs = props.prefs
  const values: PayoutFormValues | null =
    props.payoutValues ??
    (prefs ? { cadence: prefs.cadence, threshold: prefs.thresholdPence === null ? '' : (prefs.thresholdPence / 100).toString() } : null)
  return (
    <>
      <CardDeclined money={money} />

      <h2>Card</h2>
      {money.hasPaymentMethod ? (
        <>
          <p>{CARD_CONNECTED}</p>
          <p>{CARD_CONNECTED_HELP}</p>
          <p>
            <a href={`/modernhaus/confirm/card_remove${query({ confirm: 'card', return: '/modernhaus/settings/money' })}`}>{CARD_REMOVE}</a>
          </p>
        </>
      ) : (
        <>
          <p>{CARD_ADD_TITLE}</p>
          <p>{CARD_ADD_HELP}</p>
          <p>
            <a href={CARD_HOME}>{CARD_ADD_TITLE}</a>
            {' — on the full site, which takes the card.'}
          </p>
        </>
      )}

      {/* A writer's (READER-WRITER-SPLIT-ADR §2 item 6), as on the full site. */}
      {props.viewer.canWrite === true && (
      <>
      <h2>{CONNECT_TITLE}</h2>
      {money.stripeConnectKycComplete ? (
        <>
          <p>{CONNECT_VERIFIED}</p>
          <h3>When you are paid</h3>
          {values === null || prefs === null ? (
            <p>{PAYOUT_PREFS_UNAVAILABLE}</p>
          ) : (
            <PostForm action="payout_prefs_save" csrf={props.csrf}>
              <Hidden values={{ return: '/modernhaus/settings/money' }} />
              <fieldset>
                <legend>{PAYOUT_HOW_OFTEN}</legend>
                {CADENCES.map((c) => (
                  <p key={c}>
                    <label>
                      <input type="radio" name="cadence" value={c} defaultChecked={values.cadence === c} />
                      {` ${PAYOUT_CADENCE_LABEL[c]}. ${PAYOUT_CADENCE_HELP[c]}`}
                    </label>
                  </p>
                ))}
              </fieldset>
              <p>
                <label>
                  {`${PAYOUT_THRESHOLD_LABEL} £`}
                  <input type="text" inputMode="decimal" name="threshold" defaultValue={values.threshold} size={8} />
                </label>
              </p>
              <p>{payoutFloorSentence(prefs.platformThresholdPence)}</p>
              {props.payoutError && <p role="alert">{props.payoutError}</p>}
              <p>
                <button>Save</button>
              </p>
            </PostForm>
          )}
        </>
      ) : (
        <>
          <p>{CONNECT_NEEDED}</p>
          <PostForm action="writer_upgrade" csrf={props.csrf}>
            <Hidden values={{ return: '/modernhaus/settings/money' }} />
            <p>
              <button>{CONNECT_SET_UP}</button>
            </p>
          </PostForm>
          <p>Stripe returns you to the full site’s settings when you are done.</p>
        </>
      )}
      </>
      )}
    </>
  )
}
