import {
  LIBRARY_TAB_RECENT,
  LIBRARY_TAB_LIBRARY,
  LIBRARY_EMPTY,
  LIBRARY_EMPTY_HINT,
  LIBRARY_LOAD_MORE,
  LIBRARY_UNKNOWN_WRITER,
  recentReadingEmpty,
  RECENT_READING_EMPTY_HINT,
  RECENT_READING_SHOW_MORE,
} from '../../content/library'
import {
  READING_LOG_TITLE,
  readingWindowPhrase,
  readingLogSentence,
  READING_CLEAR_TITLE,
  READING_CLEAR_BEFORE,
  SETTINGS_ON,
  SETTINGS_OFF,
} from '../../content/settings'
import { PREFS_LOAD_FAILED } from '../../content/networks'
import { query } from '../gateway'
import { NextLink, Time, PostForm, Hidden } from '../html'
import { PostList } from '../post'
import type { HistoryData, LibraryData } from '../settings-loaders'

// =============================================================================
// modernhaus — the two logs (READING-LOG-AND-LIBRARY-ADR): all.haus library
// (everything a read exists for, unwindowed — possession) and Recent reading
// (everything opened in a reader, on its retention window — attention).
// Neither is a filter of the other, so they are two pages linked to each
// other, as the full site's two tabs.
// =============================================================================

function Tabs(props: { on: 'library' | 'recent' }) {
  return (
    <p>
      {props.on === 'library' ? <strong>{LIBRARY_TAB_LIBRARY}</strong> : <a href="/modernhaus/library">{LIBRARY_TAB_LIBRARY}</a>}
      {' · '}
      {props.on === 'recent' ? <strong>{LIBRARY_TAB_RECENT}</strong> : <a href="/modernhaus/history">{LIBRARY_TAB_RECENT}</a>}
    </p>
  )
}

export function LibraryPage(props: { data: LibraryData }) {
  const { items, nextOffset } = props.data
  return (
    <>
      <Tabs on="library" />
      {items.length === 0 ? (
        <>
          <p>{LIBRARY_EMPTY}</p>
          <p>{LIBRARY_EMPTY_HINT}</p>
        </>
      ) : (
        <ol>
          {items.map((i) => (
            <li key={i.articleId}>
              {i.dTag ? (
                <a href={`/modernhaus/article/${encodeURIComponent(i.dTag)}`}>{i.title?.trim() || 'Untitled'}</a>
              ) : (
                i.title?.trim() || 'Untitled'
              )}
              {' · '}
              {i.writer.username ? (
                <a href={`/modernhaus/u/${encodeURIComponent(i.writer.username)}`}>
                  {i.writer.displayName?.trim() || i.writer.username}
                </a>
              ) : (
                LIBRARY_UNKNOWN_WRITER
              )}
              {' · '}
              <Time at={new Date(i.acquiredAt)} dateOnly />
            </li>
          ))}
        </ol>
      )}
      <NextLink href={nextOffset === null ? null : `/modernhaus/library${query({ offset: nextOffset })}`} label={LIBRARY_LOAD_MORE} />
    </>
  )
}

export function HistoryPage(props: { data: HistoryData; csrf: string }) {
  const { items, nextOffset, retentionDays } = props.data
  return (
    <>
      <Tabs on="recent" />
      <p>{readingLogSentence(readingWindowPhrase(retentionDays))}</p>
      {items.length === 0 ? (
        <>
          <p>{recentReadingEmpty(retentionDays)}</p>
          <p>{RECENT_READING_EMPTY_HINT}</p>
        </>
      ) : (
        <PostList posts={items.map((i) => i.post)} empty={recentReadingEmpty(retentionDays)} />
      )}
      <NextLink href={nextOffset === null ? null : `/modernhaus/history${query({ offset: nextOffset })}`} label={RECENT_READING_SHOW_MORE} />
      <h2>{READING_CLEAR_TITLE}</h2>
      <p>{READING_CLEAR_BEFORE}</p>
      <p>
        <a href={`/modernhaus/confirm/reading_log_clear${query({ confirm: '1', return: '/modernhaus/history' })}`}>
          {READING_CLEAR_TITLE}
        </a>
      </p>
      <h2>{READING_LOG_TITLE}</h2>
      {props.data.logEnabled === null ? (
        <p>{PREFS_LOAD_FAILED}</p>
      ) : (
        <PostForm action="reading_log_toggle" csrf={props.csrf}>
          <Hidden values={{ return: '/modernhaus/history' }} />
          <p>
            {props.data.logEnabled ? SETTINGS_ON : SETTINGS_OFF}{' '}
            <button name="enabled" value={props.data.logEnabled ? 'off' : 'on'}>
              {props.data.logEnabled ? `Turn ${SETTINGS_OFF.toLowerCase()}` : `Turn ${SETTINGS_ON.toLowerCase()}`}
            </button>
          </p>
        </PostForm>
      )}
    </>
  )
}
