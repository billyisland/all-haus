import type { WorkspaceFeed } from '../../lib/api/feeds'
import { PostForm, Hidden, NextLink, Unavailable } from '../html'
import { PostList, type ItemActions } from '../post'
import type { FeedRow } from '../member-loaders'
import type { Post } from '../../lib/post/types'

// =============================================================================
// modernhaus — the feed index (the signed-in home, §D2.9 Q2) and one feed
// (§D2.3, E3).
//
// A feed's name is OPTIONAL (feeds.md), so an unnamed feed is called by its
// place in the order, as the full site numbers its vessels. Hidden feeds are
// listed with the rest and say so: `hidden` is feed character, not deletion.
// The order is moved one step at a time, and the form carries the WHOLE order
// as rendered, so a list that changed elsewhere is refused (409), never
// silently re-applied.
// =============================================================================

/** A feed's name, or its number among the VISIBLE feeds when it has none (the
 *  full site's numbering skips hidden feeds). */
export function feedLabel(feed: WorkspaceFeed, position: number | null): string {
  if (feed.name.trim() !== '') return feed.name
  return position === null ? 'Unnamed channel' : `Channel ${position}`
}

function newCount(n: number | null): string {
  if (n === null) return ' — couldn’t count new posts'
  return n > 0 ? ` — ${n} new` : ''
}

export function FeedIndexPage(props: { rows: FeedRow[]; csrf: string }) {
  const { rows, csrf } = props
  const order = rows.map((r) => r.feed.id)
  let visible = 0
  const positions = rows.map((r) => (r.feed.hidden ? null : ++visible))
  return (
    <>
      {rows.length === 0 ? (
        <p>You have no channels yet. Make one below, then fill it: follow people from their profiles, or add an RSS feed or a handle in the channel’s settings.</p>
      ) : (
        <ol>
          {rows.map((r, i) => {
            const label = feedLabel(r.feed, positions[i])
            return (
              <li key={r.feed.id}>
                <PostForm action="feed_move" csrf={csrf}>
                  <Hidden values={{ return: '/modernhaus', feedId: r.feed.id }} />
                  {order.map((id) => (
                    <input key={id} type="hidden" name="order" value={id} />
                  ))}
                  <p>
                    <a href={`/modernhaus/feed/${encodeURIComponent(r.feed.id)}`}>{label}</a>
                    {r.feed.hidden && ' (hidden)'}
                    {newCount(r.newCount)}
                  </p>
                  <p>
                    {i > 0 && (
                      <button name="direction" value="up">
                        Move up
                      </button>
                    )}{' '}
                    {i < rows.length - 1 && (
                      <button name="direction" value="down">
                        Move down
                      </button>
                    )}{' '}
                    {r.feed.hidden ? (
                      <button formAction="/modernhaus/do/feed_show">Show</button>
                    ) : (
                      <button formAction="/modernhaus/do/feed_hide">Hide</button>
                    )}
                  </p>
                </PostForm>
              </li>
            )
          })}
        </ol>
      )}
      <h2>A new channel</h2>
      <PostForm action="feed_create" csrf={csrf}>
        <Hidden values={{ return: '/modernhaus' }} />
        <p>
          <label>
            {'Name (optional) '}
            <input type="text" name="name" maxLength={80} />
          </label>{' '}
          <button>Make the channel</button>
        </p>
      </PostForm>
    </>
  )
}

export interface FeedPageProps {
  feed: WorkspaceFeed
  items: Post[]
  next: string | null
  asOf: string
  newKnown: boolean
  actions: ItemActions
}

export function FeedPage(props: FeedPageProps) {
  const { feed, actions } = props
  return (
    <>
      {feed.hidden && <p>This channel is hidden.</p>}
      {!props.newKnown && <Unavailable what="Which posts are new" />}
      <PostList posts={props.items} empty="Nothing in this channel yet." actions={actions} />
      <NextLink href={props.next} />
      {props.items.length > 0 && (
        <PostForm action="feed_mark_seen" csrf={actions.csrf}>
          <Hidden values={{ return: actions.back, feedId: feed.id, asOf: props.asOf }} />
          <p>
            <button>Mark everything up to now as seen</button>
          </p>
        </PostForm>
      )}
      <p>
        <a href={`/modernhaus/feed/${encodeURIComponent(feed.id)}/settings`}>This channel's sources and settings</a>
        {' · '}
        <a href="/modernhaus">All your channels</a>
      </p>
    </>
  )
}
