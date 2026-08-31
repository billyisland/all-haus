import Link from 'next/link'
import { PubFollowButton } from './PubFollowButton'

// =============================================================================
// PublicationMasthead — the identity block every full-page publication view
// carries (home · about · masthead · archive · subscribe).
//
// IT REPLACED A SECOND CHASSIS. These routes used to mount their own
// `PublicationNav` + `PublicationFooter` from `pub/[slug]/layout.tsx`, which
// stacked a nav bar on top of the sitewide `PublicNavRow` that `LayoutShell`
// already mounts for every non-workspace route — two chromes on one page, and
// the layout never cleared `--ah-row-band`, so the fixed row sat over the
// footer. Both are gone: the publication now sits in the public register like
// every other logged-out surface, and its identity is carried HERE, by its own
// cover and name, rather than by a bar that imitated the site's.
//
// THE COVER IS FULL-BLEED AND THE REST IS MEASURED. A cover image is the one
// element that earns the whole width — it is the publication saying what it is
// before a word is read — so it escapes the measure while the name, tagline,
// actions and nav stay centred on the body's column. The logo laps up over the
// cover's bottom edge, which is what ties the two into one block instead of a
// picture with a header under it.
//
// NO IMAGE INVERTS. Surfaces and text here are the neutral var-backed tokens,
// so they follow the global light/dark toggle; the cover and logo are
// photographs of something real and stay exactly as they are — the same call
// the landing demos make for `DemoPhoto`.
//
// IT SERVES BOTH REGISTERS, via the same seam `ArticleLink` uses. The workspace
// overlay used to hand-duplicate this block — a smaller, coverless, logoless
// echo of it — so a publication's identity was one thing on its public page and
// another inside the workspace. Passing `onNavigate`/`onSubscribe` swaps this
// header's links for buttons that switch the overlay's view in place, which is
// what lets one header serve a surface that must not navigate.
// =============================================================================

export type PubViewName = 'home' | 'about' | 'masthead' | 'archive'

export interface MastheadPub {
  id: string
  slug: string
  name: string
  tagline: string | null
  logo_blossom_url?: string | null
  cover_blossom_url?: string | null
  isFollowing?: boolean
}

const VIEWS: { view: PubViewName; label: string; href: (slug: string) => string }[] = [
  { view: 'home', label: 'Home', href: (s) => `/pub/${s}` },
  { view: 'about', label: 'About', href: (s) => `/pub/${s}/about` },
  { view: 'masthead', label: 'Masthead', href: (s) => `/pub/${s}/masthead` },
  { view: 'archive', label: 'Archive', href: (s) => `/pub/${s}/archive` },
]

export function PublicationMasthead({
  pub,
  view,
  onNavigate,
  onSubscribe,
}: {
  pub: MastheadPub
  /** Which of the four sections is current. Omitted on /subscribe, which is a
   *  leaf off the action row rather than one of them — that page still gets the
   *  nav (it is its only way back into the publication) but marks nothing
   *  current, because nothing in it is. */
  view?: PubViewName
  /** Overlay mode: switch view in place instead of navigating (the escape ban).
   *  Both handlers are passed together or not at all. */
  onNavigate?: (view: PubViewName) => void
  onSubscribe?: () => void
}) {
  const cover = pub.cover_blossom_url
  const logo = pub.logo_blossom_url

  return (
    <header>
      {cover && (
        // eslint-disable-next-line @next/next/no-img-element
        <img
          src={cover}
          alt=""
          className="w-full object-cover"
          style={{ height: 'clamp(160px, 30vw, 360px)' }}
        />
      )}

      <div className="mx-auto max-w-content px-4 sm:px-6">
        <div className="text-center">
          {logo && (
            // The lap-up is what makes cover + name read as one block. With no
            // cover there is nothing to lap over, so it just sits in the flow.
            // eslint-disable-next-line @next/next/no-img-element
            <img
              src={logo}
              alt=""
              className="mx-auto w-16 h-16 rounded-full object-cover"
              style={{ marginTop: cover ? '-32px' : '48px', position: 'relative' }}
            />
          )}

          <h1
            className="font-serif font-light tracking-tight text-black"
            style={{
              marginTop: logo ? '16px' : cover ? '40px' : '56px',
              fontSize: 'clamp(2rem, 5vw, 3rem)',
              lineHeight: 1.1,
            }}
          >
            {pub.name}
          </h1>

          {pub.tagline && (
            <p className="font-sans text-ui-sm text-grey-600 mt-3 mx-auto max-w-article">
              {pub.tagline}
            </p>
          )}

          <div className="mt-6 flex flex-wrap items-center justify-center gap-x-5 gap-y-3">
            <PubFollowButton
              publicationId={pub.id}
              initialFollowing={pub.isFollowing ?? false}
            />
            {onSubscribe ? (
              <button
                type="button"
                onClick={onSubscribe}
                className="btn-soft py-1.5 px-4 text-ui-sm"
              >
                Subscribe
              </button>
            ) : (
              <Link
                href={`/pub/${pub.slug}/subscribe`}
                className="btn-soft py-1.5 px-4 text-ui-sm"
              >
                Subscribe
              </Link>
            )}
            <a
              href={`/api/v1/pub/${pub.slug}/rss`}
              className="label-ui text-grey-600 hover:text-black focus-ring"
            >
              RSS
            </a>
          </div>
        </div>

        {/* Current view is carried by weight of colour, not by an underline —
            a thin rule under the active tab is the commonest way a tab strip
            smuggles a single-pixel line into a design that bans them. */}
        <nav
          data-explain="pub.nav"
          aria-label={`${pub.name} sections`}
          className="mt-10 flex items-center justify-center gap-6"
        >
          {VIEWS.map((n) => {
            const className = `label-ui focus-ring transition-colors ${
              view === n.view ? 'text-black' : 'text-grey-600 hover:text-black'
            }`
            const current = view === n.view ? 'page' : undefined

            return onNavigate ? (
              <button
                key={n.view}
                type="button"
                onClick={() => onNavigate(n.view)}
                aria-current={current}
                className={className}
              >
                {n.label}
              </button>
            ) : (
              <Link
                key={n.view}
                href={n.href(pub.slug)}
                aria-current={current}
                className={className}
              >
                {n.label}
              </Link>
            )
          })}
        </nav>
      </div>
    </header>
  )
}
