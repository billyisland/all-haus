// =============================================================================
// The writer's dashboard — the words, in one home for both registers.
//
// The full site's dashboard is a set of client components (`DashboardPanel` —
// its Articles and Pricing tabs and the welcome-message form — `GiftLinksPanel`,
// `ProposalsTab`, `SubscribersTab`); modernhaus's no-JS twin must say the same
// things and may not import a 'use client' file, so the sentences live here and
// both read them. The reasoning behind each is in the component that renders
// it. Templated sentences take already-formatted values: the formatting (dates,
// pounds) stays with the caller.
// =============================================================================

// ---- Tabs and header actions (DashboardPanel) -----------------------------

export const DASHBOARD_TAB_LABEL = {
  articles: 'Articles',
  subscribers: 'Subscribers',
  proposals: 'Proposals',
  pricing: 'Pricing',
  analytics: 'Analytics',
} as const

export const DASHBOARD_VIEW_LEDGER = 'View ledger'
export const DASHBOARD_NEW_ARTICLE = 'New article'

// ---- Articles tab ----------------------------------------------------------

export const ARTICLES_LOAD_FAILED = 'Couldn’t load your articles and drafts. Please try again.'
export const ARTICLES_EMPTY = 'No articles or drafts yet.'
export const ARTICLES_WRITE_FIRST = 'Write your first article'

export const ARTICLES_COL_TITLE = 'Title'
export const ARTICLES_COL_STATUS = 'Status'
export const ARTICLES_COL_PRICE = 'Price'
export const ARTICLES_COL_SETTLED_READS = 'Settled reads'
export const ARTICLES_COL_EARNED = 'Earned'
export const ARTICLES_COL_REPLIES = 'Replies'
export const ARTICLES_COL_ACTIONS = 'Actions'

// What the count under "Settled reads" is (walkthrough A14) — the reasoning is
// in DashboardPanel's ArticlesTab.
export const SETTLED_READS_HINT =
  'Paid reads whose charge has gone through. A read counts once the reader’s tab has been charged, so recent reads show up later. Reads a reader’s free allowance covered count too, and earn nothing; reads under a subscription and reads of free pieces are not counted here.'

export const ARTICLE_UNTITLED = 'Untitled'
export const ARTICLE_STATUS_DRAFT = 'Draft'
export const ARTICLE_STATUS_PUBLISHED = 'Published'
export const ARTICLE_STATUS_UNPUBLISHED = 'Unpublished'
export const ARTICLE_PRICE_FREE = 'Free'
export const ARTICLE_REPLIES_ON = 'On'
export const ARTICLE_REPLIES_OFF = 'Off'
export const ARTICLE_GIFTS = 'Gifts'
export const ARTICLE_EDIT = 'Edit'
export const ARTICLE_PREVIEW = 'Preview'
export const ARTICLE_UNPUBLISH = 'Unpublish'
export const ARTICLE_DELETE = 'Delete'
export const ARTICLE_SCHEDULE = 'Schedule'
export const ARTICLE_RESCHEDULE = 'Reschedule'
export const ARTICLE_UNSCHEDULE = 'Unschedule'
export const ARTICLE_UPDATE_SCHEDULE = 'Update schedule'
export const ARTICLE_CONFIRM_SCHEDULE = 'Confirm schedule'
export const ARTICLE_SCHEDULE_CANCEL = 'Cancel'

export function draftSavedAt(date: string): string {
  return `Saved ${date}`
}
export function draftScheduledFor(date: string): string {
  return `Scheduled ${date}`
}

export const DELETE_ARTICLE_CONFIRM_TITLE = 'Delete this article?'
export const DELETE_ARTICLE_CONFIRM_BODY =
  'It is removed from the site and a deletion notice is published to the relay. This cannot be undone — use Unpublish to move it back to drafts instead.'
export const DELETE_ARTICLE_CONFIRM_LABEL = 'Delete'

export const DELETE_DRAFT_CONFIRM_TITLE = 'Delete this draft?'
export const DELETE_DRAFT_CONFIRM_BODY = 'This cannot be undone.'
export const DELETE_DRAFT_CONFIRM_LABEL = 'Delete'

export const UNPUBLISH_CONFIRM_TITLE = 'Unpublish this article?'
export const UNPUBLISH_CONFIRM_BODY =
  'It comes off your profile and out of members’ channels, and a deletion is sent to the relays. It is not deleted here — you can edit and publish it again.'
export const UNPUBLISH_CONFIRM_LABEL = 'Unpublish'
export const UNPUBLISH_DONE =
  'Unpublished. Off your profile, out of members’ channels and off the relay — edit and publish again when you are ready.'

export const ARTICLE_REPLIES_UPDATE_FAILED = 'Couldn’t change replies on this piece. Please try again.'
export const ARTICLE_DELETE_FAILED = 'Couldn’t delete this article. Please try again.'
export const DRAFT_DELETE_FAILED = 'Couldn’t delete this draft. Please try again.'
export const ARTICLE_UNPUBLISH_FAILED = 'Couldn’t unpublish this article. Please try again.'
export const DRAFT_SCHEDULE_FAILED = 'Couldn’t schedule this draft. Please try again.'
export const DRAFT_UNSCHEDULE_FAILED = 'Couldn’t unschedule this draft. Please try again.'

// ---- Pricing tab -----------------------------------------------------------

export const PRICING_SUBSCRIPTION_TITLE = 'Subscription pricing'
export const PRICING_SUBSCRIPTION_INTRO =
  'Set the monthly price readers pay to subscribe to your content. Readers can also choose an annual plan at a discount you configure.'
export const PRICING_PER_MONTH = '/month'
export const PRICING_ANNUAL_DISCOUNT = 'annual discount'

/** `monthlyPounds`/`annualPounds` are the bare figures ("3.00"), no £. */
export function pricingPreview(monthlyPounds: string, annualPounds: string, discountPct: number): string {
  return `Readers pay £${monthlyPounds}/mo or £${annualPounds}/year${discountPct > 0 ? ` (save ${discountPct}%)` : ''}`
}

export const PRICING_PER_ARTICLE_TITLE = 'Per-article pricing'
export const PRICING_PER_ARTICLE_INTRO =
  'Default price for paywalled articles. You can override this per article in the editor. Free articles are always free.'
export const PRICING_MODE_AUTO = 'Auto'
export const PRICING_MODE_AUTO_HELP = 'Price scales with article length'
export const PRICING_MODE_FIXED = 'Fixed default'
export const PRICING_MODE_FIXED_HELP = 'Same starting price for every paywalled article'
export const PRICING_PER_READ = 'per read'
export const PRICING_SAVE = 'Save pricing'
export const PRICING_SAVING = 'Saving…'

export const PRICING_INVALID_PRICE = 'Enter a valid price.'
export const PRICING_INVALID_DISCOUNT = 'Discount must be 0–30%.'
export const PRICING_INVALID_ARTICLE_PRICE = 'Enter a valid per-article price.'
export const PRICING_UPDATED = 'Pricing updated.'
export const PRICING_UPDATE_FAILED = 'Failed to update.'

// ---- Welcome message (WelcomeMessageSection) -------------------------------

export const WELCOME_TITLE = 'Welcome message'
export const WELCOME_INTRO =
  'Sent to a reader the moment they subscribe — the one time you know they are listening. Leave it empty and we send a short welcome in your name.'
export const WELCOME_PLACEHOLDER = 'Thanks for subscribing. Here is what you can expect from me…'
export const WELCOME_SAVE = 'Save welcome message'
export const WELCOME_SAVING = 'Saving…'
export const WELCOME_SAVED = 'Welcome message saved.'
export const WELCOME_CLEARED = 'Cleared — subscribers get the default welcome.'
export const WELCOME_SAVE_FAILED = 'Couldn’t save your welcome message. Please try again.'

// ---- Gift links (GiftLinksPanel) -------------------------------------------

export const GIFT_LINKS_LOAD_FAILED = 'Couldn’t load your gift links. Please try again.'
export const GIFT_LINK_CREATE_FAILED = 'Couldn’t create a gift link — nothing was made. Try again.'
export const GIFT_LINK_REVOKE_FAILED = 'Couldn’t revoke that link — it still works. Try again.'
export const GIFT_LINK_LIMIT = 'Limit'
export const GIFT_LINK_NEW = 'New gift link'
export const GIFT_LINK_CREATING = 'Creating…'
export const GIFT_LINK_COL_LINK = 'Link'
export const GIFT_LINK_COL_REDEEMED = 'Redeemed'
export const GIFT_LINK_COL_CREATED = 'Created'
export const GIFT_LINK_COPIED = 'Copied!'
export const GIFT_LINK_COPY_BY_HAND = 'Gift link — copy it by hand'
export const GIFT_LINK_REVOKE = 'Revoke'
export const GIFT_LINKS_EMPTY = 'No gift links yet.'

export const GIFT_LINK_REVOKE_CONFIRM_TITLE = 'Revoke this gift link?'
export const GIFT_LINK_REVOKE_CONFIRM_BODY =
  'Anyone holding it loses access at once, and it cannot be restored — you would have to send a new link.'
export const GIFT_LINK_REVOKE_CONFIRM_LABEL = 'Revoke'

/** The fold holding revoked gift links and revoked offers alike. */
export function revokedCount(n: number): string {
  return `${n} revoked`
}

// ---- Proposals tab: subscription offers (ProposalsTab) ---------------------

export const PROPOSALS_LOAD_FAILED = 'Failed to load proposals.'
export const PROPOSALS_FILTER_ALL = 'All'
export function proposalsFilterOffers(n: number): string {
  return `Offers (${n})`
}
export const OFFER_NEW_CODE = 'New offer code'
export const OFFER_GIFT_SUBSCRIPTION = 'Gift subscription'
export const PROPOSALS_EMPTY = 'No proposals yet.'
export const PROPOSALS_EMPTY_WITH_PLEDGES =
  'Commission requests from readers, your pledge drives, and subscription offers will appear here.'
export const PROPOSALS_EMPTY_OFFERS_ONLY = 'Your subscription offers will appear here.'

export const OFFERS_TITLE = 'Offers'
export const OFFER_COL_LABEL = 'Label'
export const OFFER_COL_TYPE = 'Type'
export const OFFER_COL_DISCOUNT = 'Discount'
export const OFFER_COL_DURATION = 'Duration'
export const OFFER_COL_REDEEMED = 'Redeemed'
export const OFFER_COL_ACTIONS = 'Actions'

export function offerTypeLabel(mode: 'code' | 'grant', recipientUsername: string | null | undefined): string {
  return mode === 'code' ? 'code' : `grant → ${recipientUsername ?? '?'}`
}
export function offerDiscount(pct: number): string {
  return `${pct}%${pct === 100 ? ' (free)' : ''}`
}
export function offerDuration(months: number | null | undefined): string {
  return months ? `${months}mo` : 'permanent'
}
export function offerRedeemedCount(n: number): string {
  return `${n} redeemed`
}

export const OFFER_COPY_LINK = 'Copy link'
export const OFFER_COPIED = 'Copied!'
export const OFFER_COPY_BY_HAND = 'Subscription offer link — copy it by hand'
export const OFFER_REVOKE = 'Revoke'
export const OFFER_REVOKE_CONFIRM_TITLE = 'Revoke this offer?'
export const OFFER_REVOKE_CONFIRM_BODY =
  "The link stops working for new sign-ups; anyone already subscribed keeps their terms. This can't be undone."
export const OFFER_REVOKE_CONFIRM_LABEL = 'Revoke'
export const OFFER_REVOKE_FAILED = "Couldn't revoke the offer — it is still live. Try again."

export const OFFER_FORM_CANCEL = 'Cancel'
export const OFFER_FORM_LABEL = 'Label'
export const OFFER_FORM_LABEL_PLACEHOLDER_CODE = 'e.g. Launch discount'
export const OFFER_FORM_LABEL_PLACEHOLDER_GRANT = 'e.g. Comp for Jane'
export const OFFER_FORM_DISCOUNT = 'Discount %'
export const OFFER_FORM_DURATION = 'Duration'
export const OFFER_FORM_DURATION_HELP = 'months (blank = permanent)'
export const OFFER_FORM_MAX_REDEMPTIONS = 'Max redemptions'
export const OFFER_FORM_MAX_REDEMPTIONS_HELP = 'blank = unlimited'
export const OFFER_FORM_EXPIRES = 'Expires'
export const OFFER_FORM_RECIPIENT = 'Recipient username'
export const OFFER_FORM_RECIPIENT_PLACEHOLDER = 'username'
export const OFFER_FORM_EMPTY_PLACEHOLDER = '—'
export const OFFER_FORM_CREATING = 'Creating…'
export const OFFER_FORM_CREATE_CODE = 'Create offer code'
export const OFFER_FORM_CREATE_GRANT = 'Grant subscription'
export const OFFER_CREATE_FAILED = 'Failed to create offer.'

// ---- Subscribers tab (SubscribersTab) --------------------------------------

export const SUBSCRIBERS_LOAD_FAILED = 'Failed to load subscribers.'
export const SUBSCRIBERS_EMPTY = 'No subscribers yet.'
export const SUBSCRIBERS_SET_UP_PRICING = 'Set up subscription pricing'
export const SUBSCRIBERS_STAT_ACTIVE = 'Active subscribers'
export const SUBSCRIBERS_STAT_REVENUE = 'Monthly revenue (est.)'
export const SUBSCRIBERS_STAT_NEW = 'New this month'
export const SUBSCRIBERS_COL_SUBSCRIBER = 'Subscriber'
export const SUBSCRIBERS_COL_SINCE = 'Since'
export const SUBSCRIBERS_COL_PLAN = 'Plan'
export const SUBSCRIBERS_COL_STATUS = 'Status'
export const SUBSCRIBERS_COL_AMOUNT = 'Amount'
export const SUBSCRIBER_PLAN_COMP = 'Comp'
export const SUBSCRIBER_PLAN_ANNUAL = 'Annual'
export const SUBSCRIBER_PLAN_MONTHLY = 'Monthly'
export const SUBSCRIBER_AMOUNT_FREE = 'Free'
/** `price` is already formatted ("£3.00"). */
export function subscriberAmount(price: string, annual: boolean): string {
  return `${price}/${annual ? 'yr' : 'mo'}`
}
export const SUBSCRIBER_STATUS_ACTIVE = 'Active'
export const SUBSCRIBER_STATUS_CANCELLED = 'Cancelled'
export function subscriberAccessUntil(date: string): string {
  return `Access until ${date}`
}
