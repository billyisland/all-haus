import type { MyArticle } from '../lib/api/articles'
import type { GiftLink, SubscriptionOffer } from '../lib/api/drives'
import type { Subscriber } from '../lib/api/account'
import { call, okBody, path, GatewayFault, type GatewayContext } from './gateway'
import { secondary } from './member-loaders'

// =============================================================================
// modernhaus — the writer's dashboard (MODERNHAUS-ADR §D2.3, E6): the pieces,
// one piece's gift links and tags, pricing and the welcome message, offers,
// subscribers. Every read is scoped to the writer by the gateway.
// =============================================================================

/** `netEarningsPence` and friends are integers on the wire; coerced here, at the edge. */
function coerceArticle(a: MyArticle): MyArticle {
  return {
    ...a,
    pricePence: a.pricePence === null ? null : Number(a.pricePence),
    replyCount: Number(a.replyCount) || 0,
    readCount: Number(a.readCount) || 0,
    netEarningsPence: Number(a.netEarningsPence) || 0,
  }
}

export async function loadMyArticles(gw: GatewayContext): Promise<MyArticle[]> {
  const b = okBody(await call<{ articles: MyArticle[] }>(gw, 'GET', '/my/articles'), 'my articles')
  if (!Array.isArray(b.articles)) throw new GatewayFault('my articles: no list')
  return b.articles.map(coerceArticle)
}

export interface ArticleManage {
  article: MyArticle
  /** Null when the list could not be read — said, never shown as "none". */
  giftLinks: GiftLink[] | null
  tags: string[] | null
}

/** One of the writer's own pieces, or null when it is not theirs. */
export async function loadArticleManage(gw: GatewayContext, articleId: string): Promise<ArticleManage | null> {
  const article = (await loadMyArticles(gw)).find((a) => a.id === articleId)
  if (!article) return null
  const [gifts, tags] = await Promise.all([
    article.isPaywalled
      ? secondary<{ giftLinks: GiftLink[] }>(gw, 'GET', path`/articles/${articleId}/gift-links`, 'gift links')
      : Promise.resolve({ giftLinks: [] }),
    secondary<{ tags: string[] }>(gw, 'GET', path`/articles/${articleId}/tags`, 'article tags'),
  ])
  return {
    article,
    giftLinks: Array.isArray(gifts?.giftLinks) ? gifts.giftLinks : null,
    tags: Array.isArray(tags?.tags) ? tags.tags : null,
  }
}

/** The welcome message: the text, '' for none, or null when it could not be read. */
export async function loadWelcome(gw: GatewayContext): Promise<string | null> {
  const b = await secondary<{ message: string | null }>(gw, 'GET', '/settings/subscription-welcome', 'welcome message')
  if (!b) return null
  return typeof b.message === 'string' ? b.message : ''
}

export async function loadOffers(gw: GatewayContext): Promise<SubscriptionOffer[]> {
  const b = okBody(await call<{ offers: SubscriptionOffer[] }>(gw, 'GET', '/subscription-offers'), 'offers')
  if (!Array.isArray(b.offers)) throw new GatewayFault('offers: no list')
  return b.offers.map((o) => ({ ...o, redemptionCount: Number(o.redemptionCount) || 0 }))
}

export async function loadSubscribers(gw: GatewayContext): Promise<Subscriber[]> {
  const b = okBody(await call<{ subscribers: Subscriber[] }>(gw, 'GET', '/subscribers'), 'subscribers')
  if (!Array.isArray(b.subscribers)) throw new GatewayFault('subscribers: no list')
  return b.subscribers.map((s) => ({ ...s, pricePence: Number(s.pricePence) || 0 }))
}
