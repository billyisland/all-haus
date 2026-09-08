import { pool, loadConfig } from '../db/client.js'

// =============================================================================
// The arrival gift — one home for "what is this piece worth to a stranger?"
// (PAYWALL-ARRIVAL-ADR D1/D2, §11.2.)
//
// A logged-out reader who meets a paywall and makes an account there is given an
// ENLARGED grant: the ordinary `free_allowance_pence` dial PLUS the price of the
// piece they came for, when that price is at or below `arrival_gift_cap_pence`. The arrival read then consumes exactly that price on the
// ordinary card-less path (`min(remaining, amount)`), leaving precisely the
// dial. That is what makes "This one's on the haus. And as a thank-you for
// signing up, here's another £5 of reading on us" literally true rather than
// nearly true — and it does it with NO NEW MONEY PATH: no second allowance
// column, no platform-funded read, no new ledger entry type. The read is a gift
// in the existing sense (charged to nobody, earning nobody, `chargeable_pence`
// 0), exactly as any allowance-covered read is.
//
// THREE RULES LIVE HERE BECAUSE THEY MUST NOT BE STATED TWICE.
//
// 1. `p` IS READ FROM THE DATABASE, NEVER FROM THE REQUEST. The carried intent
//    is the article's IDENTITY. A client-supplied price is a free-money
//    endpoint, and it would be one on the single route that has to accept
//    unauthenticated input by definition.
//
// 2. THE CAP IS A DIAL, NOT A LITERAL — AND IT IS ITS OWN DIAL
//    (`arrival_gift_cap_pence`, £2), NOT THE ALLOWANCE. It was
//    `free_allowance_pence` until 2026-09-06, on the reasoning that one dial
//    cannot drift from itself. What that missed is that the two answer different
//    questions: the allowance is what a newcomer is GIVEN, the cap is how much of
//    a single piece the arrival will absorb — and because the grant is
//    `allowance + p` and the money is FUNGIBLE, tying them made the priciest
//    covered piece double what a signup is worth, spendable anywhere. Allowance
//    reads earn writers nothing, so that doubling is a cost to WRITERS.
//    Splitting them bounds it without touching the ordinary welcome (operator
//    decision, CONSOLIDATED-TODO §0v).
//
//    Above the cap there is no free unlock: a writer pricing above what the
//    arrival will absorb is addressing a niche rather than a wide paying
//    audience, and a newcomer's sampling money is worth more spread across the
//    latter. The reader meets the ordinary gate and presses the button, which is
//    what D4 Path C's copy already says.
//
//    THE TWO NUMBERS ARE BOTH ON THE WIRE AND THEY ARE NOT INTERCHANGEABLE.
//    `GET /auth/open` sends both, because the logged-out gate needs each for a
//    different sentence: `freeAllowancePence` is the figure it NAMES ("another
//    £5 of reading on us") and `arrivalGiftCapPence` is what it TESTS the price
//    against to decide whether it may promise the piece is free at all. A gate
//    that tests against the allowance promises "on the haus" for a £4 piece the
//    server will then refuse — the silent half of a capability held in two
//    places, and the reason both cross the wire rather than one being inferred
//    from the other.
//
// 3. AN UNDELIVERABLE PIECE IS GIVEN NOTHING. `performGatePass` refuses a
//    paywalled article with no vault key or `price_pence < 1` before any money
//    moves (Step 1b). Granting `p` for a piece that then refuses to open would
//    hand out the enlargement for nothing, so the same two conditions are
//    checked here — the gift and the unlock have to agree about what is
//    readable.
//
// THE ARTICLE ID IS RECORDED EVEN WHEN THE GIFT IS ZERO. Above the cap and
// misconfigured are ARRIVALS THAT WERE GIVEN NOTHING (D4 paths C and D): they
// still land on the piece, still get a welcome that says the gate is still
// there, and still need to be distinguishable from a member signing in at the
// same gate (§11.5). `arrival_gift_pence > 0` cannot make that distinction;
// `arrival_article_id IS NOT NULL` is the fact that can.
// =============================================================================

export interface ArrivalGift {
  /** The piece this account arrived for, or NULL if the intent didn't resolve
   *  to a paywalled article. This is the discriminator for "created by an
   *  arrival", so it is set for above-cap and misconfigured pieces too. */
  articleId: string | null
  /** What to ADD to the ordinary dial. 0 unless the piece is at or below the
   *  cap AND deliverable. */
  giftPence: number
  /** The piece's list price, for the caller that wants to word something about
   *  it. NULL when nothing resolved. */
  pricePence: number | null
}

const NO_GIFT: ArrivalGift = {
  articleId: null,
  giftPence: 0,
  pricePence: null,
}

/**
 * Resolve a carried arrival intent (a `nostr_d_tag`) into what the account row
 * should be stamped with.
 *
 * Never throws for a bad d-tag: an intent that doesn't resolve is simply not an
 * arrival, and a signup must not fail because the piece it came from was
 * deleted between the gate and the form.
 */
export async function resolveArrivalGift(
  arrivalDTag: string | null,
): Promise<ArrivalGift> {
  if (!arrivalDTag) return NO_GIFT

  const { rows } = await pool.query<{
    id: string
    price_pence: number | null
    access_mode: string
    has_vault_key: boolean
  }>(
    `SELECT a.id,
            a.price_pence,
            a.access_mode,
            EXISTS (SELECT 1 FROM vault_keys vk WHERE vk.article_id = a.id) AS has_vault_key
     FROM articles a
     WHERE a.nostr_d_tag = $1
       AND a.deleted_at IS NULL
       AND a.published_at IS NOT NULL`,
    [arrivalDTag],
  )

  const article = rows[0]
  // Only a PAYWALLED piece has a gate to have arrived from. A free article is
  // not an arrival, and `invitation_only` has no purchase path at all.
  if (!article || article.access_mode !== 'paywalled') return NO_GIFT

  const { arrivalGiftCapPence } = await loadConfig()
  const price = article.price_pence

  const deliverable = article.has_vault_key && price !== null && price >= 1
  const withinCap = price !== null && price <= arrivalGiftCapPence

  return {
    articleId: article.id,
    giftPence: deliverable && withinCap ? price : 0,
    pricePence: price,
  }
}
