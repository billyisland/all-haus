// =============================================================================
// Pre-publish validation for paywalled setups. Returns a human-readable
// message, or null when publishable. Mirrors the server-side rules
// (IndexArticleSchema / the key-service PublishVaultSchema): a paywall gate
// needs real paywalled content and a chargeable price, and publications have
// no vault pipeline yet. The editor runs this before signing anything, so a
// bad setup is a message next to the publish button, never a half-published
// article.
// =============================================================================

export function validatePaywalledPublish(params: {
  isPaywalled: boolean
  paywallContent: string
  pricePence: number
  publicationId: string | null
}): string | null {
  if (!params.isPaywalled) return null
  if (params.publicationId) {
    return "Paywalled articles aren't supported in publications yet — remove the paywall gate, or publish on your personal profile."
  }
  if (!params.paywallContent.trim()) {
    return 'There is no content after the paywall gate — move the gate up, or remove it.'
  }
  if (!Number.isInteger(params.pricePence) || params.pricePence < 1) {
    return 'Set a price of at least £0.01 for the paywalled section.'
  }
  return null
}
