import type { WorkspaceFeed, WorkspaceFeedSource } from '../../lib/api/feeds'
import { resolveMatches, partitionMatchOptions, type MatchOption } from '../../lib/workspace/resolve'
import { VOLUME_THROUGHPUT, stepPercent, throughputToStep } from '../../lib/volume-scale'
import {
  FEED_NAME_PLACEHOLDER,
  FEED_RENAME,
  FEED_SOURCES_LABEL,
  FEED_SOURCES_EMPTY,
  FEED_ADD_SOURCE_LABEL,
  FEED_RESOLVER_PLACEHOLDER,
  FEED_RESOLVER_NO_MATCH,
  FEED_RESOLVER_MATCHES,
  FEED_RESOLVER_SUGGESTIONS,
  FEED_SOURCE_MUTE,
  feedSourceVolume,
  FEED_SOURCE_SAMPLING_LABEL,
  FEED_SOURCE_SAMPLING_RECENT,
  FEED_SOURCE_NO_SIGNAL_TITLE,
  FEED_SOURCE_NO_REPLIES,
  FEED_SOURCE_NO_REPLIES_TITLE,
  feedSourceRemove,
  FEED_SOURCE_MOVE,
  FEED_SOURCE_MOVE_TO,
  FEED_HIDE,
  FEED_UNHIDE,
  FEED_DELETE_BLOCKED,
  FEED_DELETE_FEED,
  FEED_MERGE,
  FEED_SHARE,
  FEED_SHARE_STOP,
  feedShareCaveat,
} from '../../content/feed-settings'
import { query } from '../gateway'
import { PostForm, Hidden, Unavailable } from '../html'
import type { FeedSettingsData, SourceLookup } from '../feed-settings-loaders'
import { feedLabel } from './feeds'

// =============================================================================
// modernhaus — one feed's settings (MODERNHAUS-ADR §D2.3, E6): the full
// site's feed composer as a page, in its words (`content/feed-settings.ts`).
//
// Each source is one form: its volume (mute is step 0, and rides `muted`
// alone — mute never spends the level, feeds.md), its sampling, and whether
// replies come through. Taking a source out is a press, as the composer's ×
// is. Adding one goes through the resolver page, and the ROUTE writes any
// follow that implies; this register only reports what it did.
// =============================================================================

/** A source's in-app destination, mapped onto this register; null where there is none here. */
export function sourceHref(href: string | null): string | null {
  if (!href) return null
  const m = href.match(/^\/(source|tag)\/([^/?#]+)$/)
  if (m) return `/modernhaus/${m[1]}/${m[2]}`
  const u = href.match(/^\/([^/?#]+)$/)
  if (u) return `/modernhaus/u/${u[1]}`
  return null
}

function SourceRow(props: { source: WorkspaceFeedSource; feed: WorkspaceFeed; others: WorkspaceFeed[]; csrf: string; self: string }) {
  const { source: s } = props
  const muted = s.mutedAt !== null
  const step = muted ? 0 : throughputToStep(s.throughput)
  const href = sourceHref(s.display.href)
  return (
    <li>
      <PostForm action="source_update" csrf={props.csrf}>
        <Hidden values={{ return: props.self, feedId: props.feed.id, sourceId: s.id }} />
        <p>
          {href ? <a href={href}>{s.display.label}</a> : s.display.label}
          {s.display.sublabel && ` (${s.display.sublabel})`}
        </p>
        <p>
          <label>
            {'Volume '}
            <select name="step" defaultValue={String(step)}>
              {VOLUME_THROUGHPUT.map((_, i) => (
                <option key={i} value={String(i)}>
                  {i === 0 ? FEED_SOURCE_MUTE : feedSourceVolume(stepPercent(i))}
                </option>
              ))}
            </select>
          </label>{' '}
          <label>
            <input type="radio" name="sampling" value="random" defaultChecked={s.samplingMode === 'random'} />{' '}
            {FEED_SOURCE_SAMPLING_LABEL.random}
          </label>{' '}
          <label>
            <input type="radio" name="sampling" value="top" defaultChecked={s.samplingMode === 'top'} />{' '}
            {s.hasEngagementSignal ? FEED_SOURCE_SAMPLING_LABEL.top : FEED_SOURCE_SAMPLING_RECENT}
          </label>{' '}
          <label>
            <input type="checkbox" name="excludeReplies" value="1" defaultChecked={s.excludeReplies} /> {FEED_SOURCE_NO_REPLIES}
          </label>
        </p>
        {!s.hasEngagementSignal && <p>{FEED_SOURCE_NO_SIGNAL_TITLE}</p>}
        <p>{FEED_SOURCE_NO_REPLIES_TITLE}</p>
        <p>
          <button>Save</button>{' '}
          <button formAction="/modernhaus/do/source_remove">{feedSourceRemove(s.display.label)}</button>
          {props.others.length > 0 && (
            <>
              {' '}
              <label>
                {`${FEED_SOURCE_MOVE_TO} `}
                <select name="targetFeedId">
                  {props.others.map((f) => (
                    <option key={f.id} value={f.id}>
                      {feedLabel(f, null)}
                    </option>
                  ))}
                </select>
              </label>{' '}
              <button formAction="/modernhaus/do/source_move">{FEED_SOURCE_MOVE}</button>
            </>
          )}
        </p>
      </PostForm>
    </li>
  )
}

export function FeedSettingsPage(props: { data: FeedSettingsData; csrf: string }) {
  const { feed, feeds, sources, formula } = props.data
  const self = `/modernhaus/feed/${encodeURIComponent(feed.id)}/settings`
  const others = feeds.filter((f) => f.id !== feed.id)
  return (
    <>
      <p>
        <a href={`/modernhaus/feed/${encodeURIComponent(feed.id)}`}>Back to the channel</a>
      </p>
      <PostForm action="feed_rename" csrf={props.csrf}>
        <Hidden values={{ return: self, feedId: feed.id }} />
        <p>
          <input type="text" name="name" defaultValue={feed.name} maxLength={80} placeholder={FEED_NAME_PLACEHOLDER} aria-label={FEED_RENAME} />{' '}
          <button>{FEED_RENAME}</button>
        </p>
      </PostForm>

      <h2>{FEED_SOURCES_LABEL}</h2>
      {sources.length === 0 ? (
        <p>{FEED_SOURCES_EMPTY}</p>
      ) : (
        <ul>
          {sources.map((s) => (
            <SourceRow key={s.id} source={s} feed={feed} others={others} csrf={props.csrf} self={self} />
          ))}
        </ul>
      )}
      <form method="get" action="/modernhaus/resolve">
        <input type="hidden" name="feed" value={feed.id} />
        <p>
          <label>
            {`${FEED_ADD_SOURCE_LABEL} `}
            <input type="text" name="q" required placeholder={FEED_RESOLVER_PLACEHOLDER} />
          </label>{' '}
          <button>Find</button>
        </p>
      </form>

      {formula.kind === 'unavailable' && <Unavailable what="Whether this channel is shared" />}
      {formula.kind === 'status' && (
        <section>
          <h2>{FEED_SHARE}</h2>
          {formula.status.link && !formula.status.link.revoked ? (
            <PostForm action="formula_revoke" csrf={props.csrf}>
              <Hidden values={{ return: self, formulaId: formula.status.link.id }} />
              <p>{formula.status.link.url}</p>
              {feedShareCaveat(formula.status) && <p>{feedShareCaveat(formula.status)}</p>}
              <p>
                <button>{FEED_SHARE_STOP}</button>
              </p>
            </PostForm>
          ) : (
            <PostForm action="formula_freeze" csrf={props.csrf}>
              <Hidden values={{ return: self, feedId: feed.id }} />
              <p>
                <button>{FEED_SHARE}</button>
              </p>
            </PostForm>
          )}
        </section>
      )}

      <h2>This channel</h2>
      <PostForm action={feed.hidden ? 'feed_show' : 'feed_hide'} csrf={props.csrf}>
        <Hidden values={{ return: self, feedId: feed.id }} />
        <p>
          <button>{feed.hidden ? FEED_UNHIDE : FEED_HIDE}</button>
        </p>
      </PostForm>
      {others.length > 0 && (
        <form method="get" action="/modernhaus/confirm/feed_merge">
          <input type="hidden" name="sourceFeedId" value={feed.id} />
          <input type="hidden" name="return" value="/modernhaus" />
          <p>
            <label>
              {`${FEED_MERGE} into `}
              <select name="feedId">
                {others.map((f) => (
                  <option key={f.id} value={f.id}>
                    {feedLabel(f, null)}
                  </option>
                ))}
              </select>
            </label>{' '}
            <button>{FEED_MERGE}…</button>
          </p>
        </form>
      )}
      {others.length === 0 ? (
        <p>{FEED_DELETE_BLOCKED}</p>
      ) : (
        <p>
          <a href={`/modernhaus/confirm/feed_delete${query({ feedId: feed.id, return: '/modernhaus' })}`}>{FEED_DELETE_FEED}</a>
        </p>
      )}
    </>
  )
}

// ---------------------------------------------------------------------------
// Add a source: the resolver's candidates, each one press.
// ---------------------------------------------------------------------------

function Candidates(props: { options: MatchOption[]; csrf: string; feedId: string; back: string }) {
  return (
    <PostForm action="source_add" csrf={props.csrf}>
      <Hidden values={{ return: props.back, feedId: props.feedId }} />
      <ul>
        {props.options.map((o) => (
          <li key={o.key}>
            {`${o.label}${o.sublabel ? ` (${o.sublabel})` : ''} `}
            {/* The composer's own add body, as the browser would hold it; the route judges it. */}
            <button name="add" value={JSON.stringify(o.add)}>
              Add
            </button>
          </li>
        ))}
      </ul>
    </PostForm>
  )
}

export function ResolvePage(props: {
  csrf: string
  feed: WorkspaceFeed
  q: string
  lookup: SourceLookup
  requestId?: string
}) {
  const { lookup, feed } = props
  const settings = `/modernhaus/feed/${encodeURIComponent(feed.id)}/settings`
  const again = (
    <form method="get" action="/modernhaus/resolve">
      <input type="hidden" name="feed" value={feed.id} />
      <p>
        <label>
          {`${FEED_ADD_SOURCE_LABEL} `}
          <input type="text" name="q" required defaultValue={props.q} placeholder={FEED_RESOLVER_PLACEHOLDER} />
        </label>{' '}
        <button>Find</button>
      </p>
    </form>
  )
  if (lookup.kind === 'expired') {
    return (
      <>
        <p>That search has expired. Please search again.</p>
        {again}
      </>
    )
  }
  if (lookup.kind === 'refused') {
    return (
      <>
        <p>{FEED_RESOLVER_NO_MATCH}</p>
        {again}
      </>
    )
  }
  const options = resolveMatches(props.q, lookup.result.matches)
  const { matches, suggestions } = partitionMatchOptions(options)
  const pending = lookup.result.status === 'pending' && lookup.result.requestId
  return (
    <>
      <p>
        {'Into '}
        <a href={settings}>{feedLabel(feed, null)}</a>
      </p>
      {again}
      {options.length === 0 && !pending && <p>{FEED_RESOLVER_NO_MATCH}</p>}
      {matches.length > 0 && (
        <>
          <h2>{FEED_RESOLVER_MATCHES}</h2>
          <Candidates options={matches} csrf={props.csrf} feedId={feed.id} back={settings} />
        </>
      )}
      {suggestions.length > 0 && (
        <>
          <h2>{FEED_RESOLVER_SUGGESTIONS}</h2>
          <Candidates options={suggestions} csrf={props.csrf} feedId={feed.id} back={settings} />
        </>
      )}
      {pending && (
        <p>
          {'Still looking further afield. '}
          <a href={`/modernhaus/resolve/${encodeURIComponent(lookup.result.requestId!)}${query({ feed: feed.id, q: props.q })}`}>
            Check again
          </a>
        </p>
      )}
    </>
  )
}
