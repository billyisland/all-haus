import Link from 'next/link'
import { formatPence } from '../../lib/format'

// =============================================================================
// Shared pieces for the three publication homepage templates.
//
// The templates differ in ARRANGEMENT, not in grammar: all three name an
// author the same way, date the same way, and mark a paywalled piece the same
// way. Keeping those three here is what stops a writer's choice of template
// from silently changing what a byline means.
//
// DATES ARE ABSOLUTE HERE, deliberately — `formatDateFromISO` is the feed's
// relative form ("Today", "3d ago"), which is right for a timeline you check
// hourly and wrong for a publication's front page, where a piece's date is part
// of the record.
// =============================================================================

export interface PubArticle {
  nostr_event_id?: string | null
  nostr_d_tag: string
  title: string
  summary: string | null
  cover_image_url?: string | null
  access_mode?: string | null
  price_pence?: number | null
  published_at: string | null
  author_display_name: string | null
  author_username: string
}

export function articleKey(a: PubArticle): string {
  return a.nostr_event_id ?? a.nostr_d_tag
}

/**
 * The masthead's role line, for BOTH surfaces that render one — the standalone
 * `/pub/:slug/masthead` page and the `PublicationPanel` overlay. Same argument
 * as the byline helpers above, one level up: the two surfaces had already drifted
 * (the standalone was fixed and the overlay's copy kept the broken form, which is
 * how "· undefined" reached every member's line — §0q.2), so the rule lives here
 * rather than twice.
 *
 * `contributor_type` is `permanent | one_off`, NOT NULL, defaulting to
 * `permanent`. So the suffix marks the EXCEPTION — a guest contributor — and a
 * regular member's line is just their title or role. The previous sentinel
 * compared against `'staff'`, a value the enum does not contain, which would
 * have suffixed every single member the day the column was served (§0q.8e).
 */
export function mastheadRole(m: {
  title?: string | null
  role?: string | null
  contributor_type?: string | null
}): string {
  // `title` is the member's own words; `role` is the schema's enum, and its
  // underscores are punctuation from a database, not from a masthead — rendered
  // raw through `.label-ui` an editor-in-chief was billed "EDITOR_IN_CHIEF".
  const base = m.title || m.role?.replace(/_/g, ' ') || ''
  return m.contributor_type === 'one_off' ? `${base} · one-off` : base
}

export function articleHref(slug: string, a: PubArticle): string {
  return `/pub/${slug}/${a.nostr_d_tag}`
}

export function formatPubDate(iso: string): string {
  return new Date(iso).toLocaleDateString('en-GB', {
    day: 'numeric',
    month: 'long',
    year: 'numeric',
  })
}

/**
 * The byline row — mono-caps infrastructure voice, same order as the feed card
 * chassis: author · date · optional price.
 */
export function PubByline({
  article,
  className = '',
  showDate = true,
}: {
  article: PubArticle
  className?: string
  /** Minimal already carries the date on its own rail; passing false stops the
   *  same date being printed twice on one row. */
  showDate?: boolean
}) {
  const isPaid = article.access_mode === 'paywalled'
  return (
    <p className={`label-ui text-grey-600 ${className}`}>
      <span>{article.author_display_name || article.author_username}</span>
      {showDate && article.published_at && (
        <>
          <span aria-hidden="true"> &middot; </span>
          <span>{formatPubDate(article.published_at)}</span>
        </>
      )}
      {isPaid && article.price_pence ? (
        <>
          <span aria-hidden="true"> &middot; </span>
          <span className="text-crimson">{formatPence(article.price_pence)}</span>
        </>
      ) : null}
    </p>
  )
}

/**
 * A cover image at a fixed ratio, or nothing. Never a grey placeholder box —
 * an article without a cover should read as a text piece, not as one whose
 * picture failed to load.
 */
export function PubCover({
  src,
  ratio,
}: {
  src: string | null | undefined
  ratio: string
}) {
  if (!src) return null
  return (
    <div className="w-full overflow-hidden" style={{ aspectRatio: ratio }}>
      {/* eslint-disable-next-line @next/next/no-img-element */}
      <img
        src={src}
        alt=""
        className="w-full h-full object-cover transition-transform duration-300 group-hover:scale-[1.02]"
      />
    </div>
  )
}

export function EmptyState() {
  return (
    <div className="label-ui text-grey-600 py-16 text-center">
      NO ARTICLES PUBLISHED YET
    </div>
  )
}

/**
 * An outage is NOT an empty publication.
 *
 * The public pub fetchers used to answer any non-ok response with an empty
 * list, so a gateway 500 painted "NO ARTICLES PUBLISHED YET" over a publication
 * with a full archive — and, being an ordinary render, it cached for the
 * revalidate window. A visitor was told, with total confidence, the opposite of
 * the truth: that this writer had published nothing. The failure has to say it
 * is a failure, and it has to say the thing the visitor can act on, which is
 * that trying again is worth it.
 *
 * `notFound()` is not the alternative — a 404 makes the same false claim in a
 * stronger form, that the publication does not exist.
 */
export function LoadFailed({ what = 'this page' }: { what?: string }) {
  return (
    <div className="py-16 text-center">
      <p className="label-ui text-grey-600">COULDN&rsquo;T LOAD</p>
      <p className="font-sans text-ui-sm text-grey-600 mt-3">
        Something went wrong at our end while loading {what}. Nothing is missing — please try
        again in a moment.
      </p>
    </div>
  )
}

/**
 * The shared link wrapper, and the seam that lets ONE set of templates serve
 * both registers.
 *
 * On the standalone page it is a real `<Link>` to /pub/:slug/:articleSlug —
 * SSR, new-tab, copy-link all work, which is the whole point of those routes.
 * Inside the workspace overlay it must NOT be a link: navigating there would
 * escape the overlay world, which the escape ban forbids. So `onOpen` swaps it
 * for a `<button>` that opens the reader in place.
 *
 * Doing it here rather than forking the templates is what stops the two
 * surfaces drifting — before this, the overlay ignored `homepage_layout`
 * altogether and rendered a fourth arrangement of its own, so a writer who
 * chose Magazine saw Magazine on their public page and something else in the
 * workspace.
 *
 * `group` drives every hover response in the templates (title colour, cover
 * scale), so it belongs on this one element either way.
 */
export function ArticleLink({
  slug,
  article,
  className = '',
  onOpen,
  children,
}: {
  slug: string
  article: PubArticle
  className?: string
  /** Overlay mode: open the reader in place instead of navigating. */
  onOpen?: (dTag: string) => void
  children: React.ReactNode
}) {
  const shared = `group block focus-ring ${className}`

  if (onOpen) {
    return (
      <button
        type="button"
        onClick={() => onOpen(article.nostr_d_tag)}
        className={`${shared} w-full text-left`}
      >
        {children}
      </button>
    )
  }

  return (
    <Link href={articleHref(slug, article)} className={shared}>
      {children}
    </Link>
  )
}
