import type { MyArticle } from '../../lib/api/articles'
import type { SubscriptionOffer } from '../../lib/api/drives'
import type { Subscriber } from '../../lib/api/account'
import { formatPence } from '../../lib/format'
import * as C from '../../content/dashboard'
import { CONNECT_TITLE, CONNECT_VERIFIED, CONNECT_NEEDED, CONNECT_SET_UP } from '../../content/money-settings'
import { query } from '../gateway'
import { PostForm, Hidden, Time, Unavailable } from '../html'
import type { ArticleManage } from '../dashboard-loaders'
import type { AccountFacts } from '../settings-loaders'

// =============================================================================
// modernhaus — the writer's dashboard (MODERNHAUS-ADR §D2.3, E6). The full
// site's four tabs are four pages here, each in the dashboard's own words
// (`content/dashboard.ts`). Money is a `<table>` (§D2.6).
//
// A LINK THAT IS THE PRODUCT IS SHOWN AS TEXT. Without script nothing can put
// it on a clipboard, so the gift link and the offer link are printed for the
// writer to copy by hand — the full site's own fallback when a copy fails.
// =============================================================================

const D = '/modernhaus/dashboard'

function Tabs(props: { on: 'articles' | 'subscribers' | 'proposals' | 'pricing' }) {
  const tabs = [
    ['articles', D],
    ['subscribers', `${D}/subscribers`],
    ['proposals', `${D}/offers`],
    ['pricing', `${D}/pricing`],
  ] as const
  return (
    <p>
      {tabs.map(([key, href], i) => (
        <span key={key}>
          {i > 0 && ' · '}
          {props.on === key ? <strong>{C.DASHBOARD_TAB_LABEL[key]}</strong> : <a href={href}>{C.DASHBOARD_TAB_LABEL[key]}</a>}
        </span>
      ))}
      {' · '}
      <a href="/modernhaus/ledger">{C.DASHBOARD_VIEW_LEDGER}</a>
      {' · '}
      <a href="/modernhaus/write">{C.DASHBOARD_NEW_ARTICLE}</a>
    </p>
  )
}

export function DashboardPage(props: { articles: MyArticle[]; csrf: string }) {
  const { articles, csrf } = props
  return (
    <>
      <Tabs on="articles" />
      <p>
        <a href="/modernhaus/write/drafts">Your drafts</a>
      </p>
      {articles.length === 0 ? (
        <p>
          {`${C.ARTICLES_EMPTY} `}
          <a href="/modernhaus/write">{C.ARTICLES_WRITE_FIRST}</a>
        </p>
      ) : (
        <PostForm action="article_replies" csrf={csrf}>
          <Hidden values={{ return: D }} />
          <table>
            <thead>
              <tr>
                <th scope="col">{C.ARTICLES_COL_TITLE}</th>
                <th scope="col">{C.ARTICLES_COL_STATUS}</th>
                <th scope="col">{C.ARTICLES_COL_PRICE}</th>
                <th scope="col">{C.ARTICLES_COL_SETTLED_READS}</th>
                <th scope="col">{C.ARTICLES_COL_EARNED}</th>
                <th scope="col">{C.ARTICLES_COL_REPLIES}</th>
                <th scope="col">{C.ARTICLES_COL_ACTIONS}</th>
              </tr>
            </thead>
            <tbody>
              {articles.map((a) => {
                const published = a.publishedAt !== null
                return (
                  <tr key={a.id}>
                    <th scope="row">
                      {published ? (
                        <a href={`/modernhaus/article/${encodeURIComponent(a.dTag)}`}>{a.title?.trim() || C.ARTICLE_UNTITLED}</a>
                      ) : (
                        a.title?.trim() || C.ARTICLE_UNTITLED
                      )}
                    </th>
                    <td>{published ? C.ARTICLE_STATUS_PUBLISHED : C.ARTICLE_STATUS_UNPUBLISHED}</td>
                    <td>{a.isPaywalled && a.pricePence ? formatPence(a.pricePence) : C.ARTICLE_PRICE_FREE}</td>
                    <td>{a.readCount}</td>
                    <td>{formatPence(a.netEarningsPence)}</td>
                    <td>
                      {`${a.repliesEnabled ? C.ARTICLE_REPLIES_ON : C.ARTICLE_REPLIES_OFF} `}
                      <button name="toggle" value={`${a.id}:${a.repliesEnabled ? "off" : "on"}`}>
                        {a.repliesEnabled ? `Turn ${C.ARTICLE_REPLIES_OFF.toLowerCase()}` : `Turn ${C.ARTICLE_REPLIES_ON.toLowerCase()}`}
                      </button>
                    </td>
                    <td>
                      {published && <a href={`/modernhaus/write${query({ edit: a.dTag })}`}>{C.ARTICLE_EDIT}</a>}
                      {' · '}
                      <a href={`${D}/article/${encodeURIComponent(a.id)}`}>{a.isPaywalled ? `${C.ARTICLE_GIFTS}, tags` : 'Tags'}</a>
                      {published && (
                        <>
                          {' · '}
                          <a href={`/modernhaus/confirm/article_unpublish${query({ articleId: a.id, return: D })}`}>{C.ARTICLE_UNPUBLISH}</a>
                        </>
                      )}
                      {' · '}
                      <a href={`/modernhaus/confirm/article_delete${query({ articleId: a.id, return: D })}`}>{C.ARTICLE_DELETE}</a>
                    </td>
                  </tr>
                )
              })}
            </tbody>
          </table>
          <p>{C.SETTLED_READS_HINT}</p>
        </PostForm>
      )}
    </>
  )
}

/** One piece: its gift links (paywalled only) and its tags. */
export function ArticleManagePage(props: { data: ArticleManage; csrf: string; origin: string; tagsValue?: string }) {
  const { article, giftLinks, tags } = props.data
  const self = `${D}/article/${encodeURIComponent(article.id)}`
  const live = giftLinks?.filter((g) => !g.revoked) ?? []
  const revoked = (giftLinks?.length ?? 0) - live.length
  return (
    <>
      <p>
        <a href={D}>{C.DASHBOARD_TAB_LABEL.articles}</a>
      </p>
      {article.isPaywalled && (
        <section>
          <h2>{C.ARTICLE_GIFTS}</h2>
          {giftLinks === null ? (
            <p>{C.GIFT_LINKS_LOAD_FAILED}</p>
          ) : live.length === 0 ? (
            <p>{C.GIFT_LINKS_EMPTY}</p>
          ) : (
            <table>
              <thead>
                <tr>
                  <th scope="col">{C.GIFT_LINK_COL_LINK}</th>
                  <th scope="col">{C.GIFT_LINK_COL_REDEEMED}</th>
                  <th scope="col">{C.GIFT_LINK_COL_CREATED}</th>
                  <th scope="col" />
                </tr>
              </thead>
              <tbody>
                {live.map((g) => (
                  <tr key={g.id}>
                    <td>{`${props.origin}/article/${encodeURIComponent(article.dTag)}?gift=${encodeURIComponent(g.token)}`}</td>
                    <td>{`${g.redemptionCount}/${g.maxRedemptions}`}</td>
                    <td>
                      <Time at={new Date(g.createdAt)} dateOnly />
                    </td>
                    <td>
                      <a href={`/modernhaus/confirm/gift_link_revoke${query({ articleId: article.id, linkId: g.id, return: self })}`}>
                        {C.GIFT_LINK_REVOKE}
                      </a>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
          {revoked > 0 && <p>{C.revokedCount(revoked)}</p>}
          <PostForm action="gift_link_create" csrf={props.csrf}>
            <Hidden values={{ return: self, articleId: article.id }} />
            <p>
              <label>
                {`${C.GIFT_LINK_LIMIT} `}
                <input type="number" name="maxRedemptions" min={1} max={1000} defaultValue={5} />
              </label>{' '}
              <button>{C.GIFT_LINK_NEW}</button>
            </p>
          </PostForm>
        </section>
      )}
      <section>
        <h2>Tags</h2>
        {tags === null ? (
          <Unavailable what="This piece's tags" />
        ) : (
          <PostForm action="article_tags" csrf={props.csrf}>
            <Hidden values={{ return: self, articleId: article.id }} />
            <p>
              <label>
                {'Tags, separated by commas (up to five) '}
                <input type="text" name="tags" defaultValue={props.tagsValue ?? tags.join(', ')} />
              </label>{' '}
              <button>Save tags</button>
            </p>
            <p>Leave it empty and save to take every tag off.</p>
          </PostForm>
        )}
      </section>
    </>
  )
}

// ---------------------------------------------------------------------------
// Pricing and the welcome message.
// ---------------------------------------------------------------------------

export interface PricingValues {
  price: string
  discount: string
  mode: 'auto' | 'fixed'
  fixed: string
}

export function pricingValues(facts: AccountFacts): PricingValues {
  return {
    price: facts.subscriptionPricePence !== null ? (facts.subscriptionPricePence / 100).toFixed(2) : '',
    discount: facts.annualDiscountPct !== null ? String(facts.annualDiscountPct) : '15',
    mode: facts.defaultArticlePricePence !== null ? 'fixed' : 'auto',
    fixed: facts.defaultArticlePricePence !== null ? (facts.defaultArticlePricePence / 100).toFixed(2) : '',
  }
}

export function PricingPage(props: {
  facts: AccountFacts
  kycComplete: boolean | null
  welcome: string | null
  csrf: string
  values?: PricingValues
  error?: string | null
  welcomeValue?: string
  welcomeError?: string | null
}) {
  const v = props.values ?? pricingValues(props.facts)
  const monthlyPence = Math.round(parseFloat(v.price || '0') * 100)
  const discountPct = parseInt(v.discount || '0', 10)
  const annualPence = Math.round(monthlyPence * 12 * (1 - discountPct / 100))
  const self = `${D}/pricing`
  return (
    <>
      <Tabs on="pricing" />
      <h2>{C.PRICING_SUBSCRIPTION_TITLE}</h2>
      <p>{C.PRICING_SUBSCRIPTION_INTRO}</p>
      {props.error && <p role="alert">{props.error}</p>}
      <PostForm action="price_save" csrf={props.csrf}>
        <Hidden values={{ return: self }} />
        <p>
          <label>
            {'£ '}
            <input type="text" inputMode="decimal" name="price" defaultValue={v.price} size={8} required />
            {` ${C.PRICING_PER_MONTH}`}
          </label>
        </p>
        <p>
          <label>
            <input type="number" name="discount" min={0} max={30} defaultValue={v.discount} />
            {`% ${C.PRICING_ANNUAL_DISCOUNT}`}
          </label>
        </p>
        {Number.isFinite(monthlyPence) && monthlyPence > 0 && Number.isFinite(discountPct) && (
          <p>{C.pricingPreview((monthlyPence / 100).toFixed(2), (annualPence / 100).toFixed(2), discountPct)}</p>
        )}
        <h3>{C.PRICING_PER_ARTICLE_TITLE}</h3>
        <p>{C.PRICING_PER_ARTICLE_INTRO}</p>
        <p>
          <label>
            <input type="radio" name="mode" value="auto" defaultChecked={v.mode === 'auto'} />
            {` ${C.PRICING_MODE_AUTO} — ${C.PRICING_MODE_AUTO_HELP}`}
          </label>
        </p>
        <p>
          <label>
            <input type="radio" name="mode" value="fixed" defaultChecked={v.mode === 'fixed'} />
            {` ${C.PRICING_MODE_FIXED} — ${C.PRICING_MODE_FIXED_HELP}`}
          </label>{' '}
          <label>
            {'£ '}
            <input type="text" inputMode="decimal" name="fixed" defaultValue={v.fixed} size={8} aria-label={C.PRICING_MODE_FIXED} />
            {` ${C.PRICING_PER_READ}`}
          </label>
        </p>
        <p>
          <button>{C.PRICING_SAVE}</button>
        </p>
      </PostForm>

      <h2>{C.WELCOME_TITLE}</h2>
      <p>{C.WELCOME_INTRO}</p>
      {props.welcome === null ? (
        <Unavailable what="Your welcome message" />
      ) : (
        <PostForm action="welcome_save" csrf={props.csrf}>
          <Hidden values={{ return: self }} />
          {props.welcomeError && <p role="alert">{props.welcomeError}</p>}
          <p>
            <textarea
              name="message"
              rows={5}
              cols={60}
              maxLength={2000}
              placeholder={C.WELCOME_PLACEHOLDER}
              defaultValue={props.welcomeValue ?? props.welcome}
              aria-label={C.WELCOME_TITLE}
            />
          </p>
          <p>
            <button>{C.WELCOME_SAVE}</button>
          </p>
        </PostForm>
      )}

      <h2>{CONNECT_TITLE}</h2>
      {props.kycComplete === null ? (
        <Unavailable what="Your payout account" />
      ) : props.kycComplete ? (
        <p>{CONNECT_VERIFIED}</p>
      ) : (
        <PostForm action="writer_upgrade" csrf={props.csrf}>
          <p>
            {`${CONNECT_NEEDED} `}
            <button>{CONNECT_SET_UP}</button>
          </p>
        </PostForm>
      )}
    </>
  )
}

// ---------------------------------------------------------------------------
// Offers, and gifts of a subscription (a comp is a `grant` offer).
// ---------------------------------------------------------------------------

export interface OfferValues {
  mode: 'code' | 'grant'
  label: string
  discountPct: string
  durationMonths: string
  maxRedemptions: string
  recipientUsername: string
}

export const EMPTY_OFFER = (mode: 'code' | 'grant'): OfferValues => ({
  mode,
  label: '',
  discountPct: mode === 'grant' ? '100' : '',
  durationMonths: '',
  maxRedemptions: '',
  recipientUsername: '',
})

export function OffersPage(props: {
  offers: SubscriptionOffer[]
  csrf: string
  origin: string
  values?: OfferValues
  error?: string | null
}) {
  const live = props.offers.filter((o) => !o.revoked)
  const revoked = props.offers.length - live.length
  const self = `${D}/offers`
  return (
    <>
      <Tabs on="proposals" />
      <h2>{C.OFFERS_TITLE}</h2>
      {live.length === 0 ? (
        <p>{`${C.PROPOSALS_EMPTY} ${C.PROPOSALS_EMPTY_OFFERS_ONLY}`}</p>
      ) : (
        <table>
          <thead>
            <tr>
              <th scope="col">{C.OFFER_COL_LABEL}</th>
              <th scope="col">{C.OFFER_COL_TYPE}</th>
              <th scope="col">{C.OFFER_COL_DISCOUNT}</th>
              <th scope="col">{C.OFFER_COL_DURATION}</th>
              <th scope="col">{C.OFFER_COL_REDEEMED}</th>
              <th scope="col">{C.OFFER_COL_ACTIONS}</th>
            </tr>
          </thead>
          <tbody>
            {live.map((o) => (
              <tr key={o.id}>
                <th scope="row">
                  {o.label}
                  {o.code && (
                    <>
                      <br />
                      {`${props.origin}/subscribe/${encodeURIComponent(o.code)}`}
                    </>
                  )}
                </th>
                <td>{C.offerTypeLabel(o.mode, o.recipientUsername)}</td>
                <td>{C.offerDiscount(o.discountPct)}</td>
                <td>{C.offerDuration(o.durationMonths)}</td>
                <td>{C.offerRedeemedCount(o.redemptionCount)}</td>
                <td>
                  <a href={`/modernhaus/confirm/offer_revoke${query({ offerId: o.id, return: self })}`}>{C.OFFER_REVOKE}</a>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
      {revoked > 0 && <p>{C.revokedCount(revoked)}</p>}
      {props.error && <p role="alert">{props.error}</p>}
      <OfferForm csrf={props.csrf} values={props.values?.mode === 'code' ? props.values : EMPTY_OFFER('code')} />
      <OfferForm csrf={props.csrf} values={props.values?.mode === 'grant' ? props.values : EMPTY_OFFER('grant')} />
    </>
  )
}

function OfferForm(props: { csrf: string; values: OfferValues }) {
  const v = props.values
  const grant = v.mode === 'grant'
  return (
    <PostForm action="offer_create" csrf={props.csrf}>
      <Hidden values={{ return: `${D}/offers`, mode: v.mode }} />
      <fieldset>
        <legend>{grant ? C.OFFER_GIFT_SUBSCRIPTION : C.OFFER_NEW_CODE}</legend>
        <p>
          <label>
            {`${C.OFFER_FORM_LABEL} `}
            <input
              type="text"
              name="label"
              maxLength={200}
              required
              defaultValue={v.label}
              placeholder={grant ? C.OFFER_FORM_LABEL_PLACEHOLDER_GRANT : C.OFFER_FORM_LABEL_PLACEHOLDER_CODE}
            />
          </label>
        </p>
        {grant && (
          <p>
            <label>
              {`${C.OFFER_FORM_RECIPIENT} `}
              <input
                type="text"
                name="recipientUsername"
                required
                defaultValue={v.recipientUsername}
                placeholder={C.OFFER_FORM_RECIPIENT_PLACEHOLDER}
              />
            </label>
          </p>
        )}
        <p>
          <label>
            {`${C.OFFER_FORM_DISCOUNT} `}
            <input type="number" name="discountPct" min={0} max={100} required defaultValue={v.discountPct} />
          </label>
        </p>
        <p>
          <label>
            {`${C.OFFER_FORM_DURATION} `}
            <input type="number" name="durationMonths" min={1} max={120} defaultValue={v.durationMonths} />
            {` ${C.OFFER_FORM_DURATION_HELP}`}
          </label>
        </p>
        {!grant && (
          <p>
            <label>
              {`${C.OFFER_FORM_MAX_REDEMPTIONS} `}
              <input type="number" name="maxRedemptions" min={1} defaultValue={v.maxRedemptions} />
              {` ${C.OFFER_FORM_MAX_REDEMPTIONS_HELP}`}
            </label>
          </p>
        )}
        <p>
          <button>{grant ? C.OFFER_FORM_CREATE_GRANT : C.OFFER_FORM_CREATE_CODE}</button>
        </p>
      </fieldset>
    </PostForm>
  )
}

// ---------------------------------------------------------------------------
// Subscribers.
// ---------------------------------------------------------------------------

export function SubscribersPage(props: { subscribers: Subscriber[] }) {
  const subs = props.subscribers
  return (
    <>
      <Tabs on="subscribers" />
      {subs.length === 0 ? (
        <p>
          {`${C.SUBSCRIBERS_EMPTY} `}
          <a href={`${D}/pricing`}>{C.SUBSCRIBERS_SET_UP_PRICING}</a>
        </p>
      ) : (
        <table>
          <thead>
            <tr>
              <th scope="col">{C.SUBSCRIBERS_COL_SUBSCRIBER}</th>
              <th scope="col">{C.SUBSCRIBERS_COL_SINCE}</th>
              <th scope="col">{C.SUBSCRIBERS_COL_PLAN}</th>
              <th scope="col">{C.SUBSCRIBERS_COL_STATUS}</th>
              <th scope="col">{C.SUBSCRIBERS_COL_AMOUNT}</th>
            </tr>
          </thead>
          <tbody>
            {subs.map((s) => {
              const annual = s.subscriptionPeriod === 'annual'
              return (
                <tr key={s.subscriptionId}>
                  <th scope="row">
                    <a href={`/modernhaus/u/${encodeURIComponent(s.readerUsername)}`}>{s.readerDisplayName?.trim() || s.readerUsername}</a>
                  </th>
                  <td>
                    <Time at={new Date(s.startedAt)} dateOnly />
                  </td>
                  <td>{s.isComp ? C.SUBSCRIBER_PLAN_COMP : annual ? C.SUBSCRIBER_PLAN_ANNUAL : C.SUBSCRIBER_PLAN_MONTHLY}</td>
                  <td>
                    {s.status === 'active' ? C.SUBSCRIBER_STATUS_ACTIVE : C.SUBSCRIBER_STATUS_CANCELLED}
                    {s.status !== 'active' && (
                      <>
                        {' — '}
                        {C.subscriberAccessUntil(new Intl.DateTimeFormat('en-GB', { day: 'numeric', month: 'short', year: 'numeric', timeZone: 'Europe/London' }).format(new Date(s.currentPeriodEnd)))}
                      </>
                    )}
                  </td>
                  <td>{s.isComp ? C.SUBSCRIBER_AMOUNT_FREE : C.subscriberAmount(formatPence(s.pricePence), annual)}</td>
                </tr>
              )
            })}
          </tbody>
        </table>
      )}
    </>
  )
}
