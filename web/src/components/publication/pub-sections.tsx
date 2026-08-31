import { ProfileLink } from '../ui/ProfileLink'
import { formatPence } from '../../lib/format'
import { HomepageBlog } from './HomepageBlog'
import { HomepageMagazine } from './HomepageMagazine'
import { HomepageMinimal } from './HomepageMinimal'
import {
  ArticleLink,
  PubByline,
  articleKey,
  formatPubDate,
  mastheadRole,
  type PubArticle,
} from './article-shared'

// =============================================================================
// The four publication view BODIES, shared by both registers.
//
// `article-shared.tsx` holds the grammar (a byline, a date, a cover, the
// standalone-vs-overlay link seam); this file holds the four things that
// grammar is arranged into — home, archive, masthead, subscribe — so the
// standalone `/pub/:slug/**` routes and the workspace `PublicationPanel`
// overlay render the same publication rather than two publications that happen
// to share a name.
//
// THE FORK THIS CLOSES WAS NOT COSMETIC. The overlay's archive was a flat list
// dated in the feed's relative voice ("3d ago") against the standalone's
// year-grouped absolute dates — that is, the two surfaces disagreed about
// whether a publication's archive is a record or a timeline, which
// `article-shared.tsx`'s own header had already settled ("a piece's date is
// part of the record"). The overlay also had no route to the subscription
// terms at all, so a member could read a publication for a month without ever
// being shown what subscribing to it costs.
//
// Every body takes `onOpen` and threads it to `ArticleLink`: absent, rows are
// real links to /pub/:slug/:article; present, they are buttons that open the
// reader in place, which is what keeps the overlay on the right side of the
// escape ban. Nothing else in these components knows which register it is in.
//
// An outage is NOT an empty state (see `LoadFailed`), so none of these bodies
// takes a nullable collection — the caller distinguishes failure from empty
// and renders `LoadFailed` itself, exactly as the standalone pages already do.
// =============================================================================

/** Overlay mode — see `ArticleLink`. Omitted on the standalone pages. */
type OnOpen = ((dTag: string) => void) | undefined

// ---------------------------------------------------------------------------
// Home — the writer's chosen template.
//
// The fallback lives HERE rather than at each call site: the standalone page
// tested `layout === 'blog'` for its last branch, so an unrecognised value
// (a template retired, a hand-edited row) rendered the whole homepage as
// nothing, while the overlay's `if/if/return blog` shape fell back correctly.
// One home, one fallback, and Blog is it.
// ---------------------------------------------------------------------------
export function PubHomepage({
  slug,
  layout,
  articles,
  onOpen,
}: {
  slug: string
  layout: string | null | undefined
  articles: PubArticle[]
  onOpen?: OnOpen
}) {
  const props = { slug, articles, onOpen }
  if (layout === 'magazine') return <HomepageMagazine {...props} />
  if (layout === 'minimal') return <HomepageMinimal {...props} />
  return <HomepageBlog {...props} />
}

// ---------------------------------------------------------------------------
// Archive — the complete index, grouped by year.
//
// Entries are separated by rhythm, not by the bottom rule this list used to
// draw on every row. The year headings are what make a long archive navigable,
// and they are mono infrastructure voice rather than serif — they label the
// list, they are not part of the writing.
// ---------------------------------------------------------------------------

/** Group in the order the API returned (published_at DESC), so years stay descending. */
function groupByYear(articles: PubArticle[]): [string, PubArticle[]][] {
  const groups = new Map<string, PubArticle[]>()
  for (const a of articles) {
    const year = a.published_at
      ? String(new Date(a.published_at).getFullYear())
      : 'Undated'
    const bucket = groups.get(year)
    if (bucket) bucket.push(a)
    else groups.set(year, [a])
  }
  return [...groups.entries()]
}

export function PubArchive({
  slug,
  articles,
  onOpen,
}: {
  slug: string
  articles: PubArticle[]
  onOpen?: OnOpen
}) {
  return (
    <>
      {groupByYear(articles).map(([year, group], gi) => (
        <section key={year} className={gi === 0 ? '' : 'mt-14'}>
          <h2 className="label-ui text-grey-600 mb-5">{year}</h2>
          <ul>
            {group.map((a, i) => (
              <li key={articleKey(a)} className={i === 0 ? '' : 'mt-6'}>
                <ArticleLink slug={slug} article={a} onOpen={onOpen}>
                  <div className="flex items-baseline justify-between gap-6">
                    <h3 className="font-serif text-black text-[1.0625rem] leading-[1.35] group-hover:text-crimson-dark transition-colors">
                      {a.title}
                    </h3>
                    {a.published_at && (
                      <span className="font-mono text-mono-xs text-grey-600 shrink-0">
                        {formatPubDate(a.published_at)}
                      </span>
                    )}
                  </div>
                  <PubByline article={a} className="mt-1" showDate={false} />
                </ArticleLink>
              </li>
            ))}
          </ul>
        </section>
      ))}
    </>
  )
}

// ---------------------------------------------------------------------------
// Masthead — the team behind the publication. Names open the profile overlay
// (ProfileLink), which supersedes this surface per the one-Glasshouse rule.
// ---------------------------------------------------------------------------
export interface MastheadMember {
  username: string
  display_name?: string | null
  avatar_blossom_url?: string | null
  bio?: string | null
  title?: string | null
  role?: string | null
  contributor_type?: string | null
}

export function PubMastheadList({ members }: { members: MastheadMember[] }) {
  return (
    <ul className="grid grid-cols-1 sm:grid-cols-2 gap-x-10 gap-y-9">
      {members.map((m) => (
        <li key={m.username} className="flex items-start gap-4">
          {m.avatar_blossom_url ? (
            // eslint-disable-next-line @next/next/no-img-element
            <img
              src={m.avatar_blossom_url}
              alt=""
              className="w-14 h-14 rounded-full object-cover shrink-0"
            />
          ) : (
            <div className="w-14 h-14 rounded-full bg-grey-200 shrink-0" />
          )}
          <div className="min-w-0">
            <ProfileLink
              href={`/${m.username}`}
              className="font-sans font-medium text-black hover:opacity-70"
            >
              {m.display_name || m.username}
            </ProfileLink>
            <p className="label-ui text-grey-600 mt-1">{mastheadRole(m)}</p>
            {m.bio && (
              <p className="font-sans text-ui-sm text-grey-600 mt-2 leading-[1.55]">
                {m.bio}
              </p>
            )}
          </div>
        </li>
      ))}
    </ul>
  )
}

// ---------------------------------------------------------------------------
// Subscribe — the terms, and only the terms.
//
// PRICES ONLY. There is no checkout here and there never has been; wiring the
// subscribe action is CONSOLIDATED-TODO §4. That is worth saying out loud so
// the next reader does not take the absence of a button for a regression.
//
// The tiers are `bg-glasshouse-well` panels rather than outlined boxes: a
// slightly inset well reads as a card without a rule round it, and it inverts
// with the global toggle where a chosen line colour would have had to suit one
// mode and not the other.
//
// The heading is an h2 because the publication's NAME is the h1 on every
// surface that mounts this — the masthead above it.
// ---------------------------------------------------------------------------
function Tier({
  label,
  pence,
  note,
}: {
  label: string
  pence: number
  note?: string
}) {
  return (
    <div className="bg-glasshouse-well px-6 py-7 text-center">
      <p className="label-ui text-grey-600">{label}</p>
      <p className="font-sans font-medium text-black mt-2" style={{ fontSize: '2rem' }}>
        {formatPence(pence)}
        <span className="text-ui-sm text-grey-600 font-normal"> /month</span>
      </p>
      {note && <p className="text-ui-xs text-grey-600 mt-2">{note}</p>}
    </div>
  )
}

export function PubSubscribeTerms({
  name,
  monthlyPence,
  annualDiscountPct,
}: {
  name: string
  monthlyPence: number
  annualDiscountPct: number
}) {
  const annualMonthly = Math.round(monthlyPence * (1 - annualDiscountPct / 100))

  return (
    <>
      <h2
        className="font-serif font-light text-black text-center tracking-tight"
        style={{ fontSize: '2rem' }}
      >
        Subscribe
      </h2>

      {monthlyPence > 0 ? (
        <>
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-5 mt-9">
            <Tier label="Monthly" pence={monthlyPence} />
            {annualDiscountPct > 0 && (
              <Tier
                label="Annual"
                pence={annualMonthly}
                note={`${annualDiscountPct}% off, billed yearly`}
              />
            )}
          </div>
          <p className="font-sans text-ui-sm text-grey-600 mt-8 text-center">
            Full access to everything {name} publishes. Cancel any time.
          </p>
        </>
      ) : (
        <p className="label-ui text-grey-600 py-16 text-center">
          NO SUBSCRIPTION OFFERED YET
        </p>
      )}
    </>
  )
}
