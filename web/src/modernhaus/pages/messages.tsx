import {
  MESSAGES_NEW_MESSAGE_TITLE,
  MESSAGES_TO_LABEL,
  MESSAGES_RECIPIENT_PLACEHOLDER,
  MESSAGES_NO_ONE_FOUND,
  MESSAGES_CONVERSATION_FALLBACK,
  MESSAGES_NEW,
  MESSAGES_NO_CONVERSATIONS,
  MESSAGES_UNREAD,
  MESSAGES_LOAD_OLDER,
  MESSAGES_THREAD_EMPTY,
  MESSAGES_UNKNOWN_SENDER,
  MESSAGES_ENCRYPTED,
  MESSAGES_COULD_NOT_DECRYPT,
  MESSAGES_LIKE,
  MESSAGES_UNLIKE,
  MESSAGES_MESSAGE_PLACEHOLDER,
  MESSAGES_SEND,
  messagesBlockedSentence,
} from '../../content/messages'
import { query } from '../gateway'
import { PostForm, Hidden, NextLink, Time, TextParagraphs, Unavailable, type Viewer } from '../html'
import type { DmLookup, InboxMember, InboxRow, MessageThreadData, Relation } from '../messages-loaders'
import { RelationControls } from './social'

// =============================================================================
// modernhaus — direct messages (MODERNHAUS-ADR §D2.3, E6): the inbox, one
// conversation, and a new message.
//
// A MESSAGE IS ESCAPED TEXT AND NEVER A LINK (security.md: DMs are text only
// in all three halves). `TextParagraphs` is called WITHOUT `linkify` here, and
// `structure.test.ts` reads this file to hold it so: the route's link detector
// is deliberately loose, and that looseness is only safe while no renderer
// turns text into a link.
//
// Opening a conversation marks nothing read — a GET writes nothing (the rule
// file) — so "Mark all as read" is its own press, as a notification's is.
// =============================================================================

export function memberName(m: InboxMember): string {
  return m.displayName?.trim() || `@${m.username}`
}

function membersLabel(members: InboxMember[]): string {
  return members.length > 0 ? members.map(memberName).join(', ') : MESSAGES_CONVERSATION_FALLBACK
}

export function threadTitle(data: MessageThreadData): string {
  return data.members ? membersLabel(data.members) : MESSAGES_CONVERSATION_FALLBACK
}

export function InboxPage(props: { rows: InboxRow[] }) {
  return (
    <>
      <p>
        <a href="/modernhaus/messages/new">{MESSAGES_NEW}</a>
      </p>
      {props.rows.length === 0 ? (
        <p>{MESSAGES_NO_CONVERSATIONS}</p>
      ) : (
        <ul>
          {props.rows.map((c) => (
            <li key={c.id}>
              <a href={`/modernhaus/messages/${encodeURIComponent(c.id)}`}>{membersLabel(c.members)}</a>
              {c.unreadCount > 0 && ` — ${MESSAGES_UNREAD} (${c.unreadCount})`}
              {(c.lastMessageAt ?? c.createdAt) && (
                <>
                  {' · '}
                  <Time at={new Date(c.lastMessageAt ?? c.createdAt)} />
                </>
              )}
            </li>
          ))}
        </ul>
      )}
    </>
  )
}

export interface MessageThreadPageProps {
  data: MessageThreadData
  viewer: Viewer
  csrf: string
  /** What the viewer has done to the other member of a two-person thread; null when unknown or a group. */
  relation: Relation | null
  /** What was typed, when a send was refused. */
  draft?: string
}

export function MessageThreadPage(props: MessageThreadPageProps) {
  const { data, viewer, csrf } = props
  const self = `/modernhaus/messages/${encodeURIComponent(data.conversationId)}`
  const other = data.members?.length === 1 ? data.members[0] : null
  const blocked = props.relation?.blocked === true
  return (
    <>
      {data.members === null && <Unavailable what="Who is in this conversation" />}
      {other && (
        <RelationControls
          userId={other.id}
          username={other.username}
          name={memberName(other)}
          relation={props.relation}
          csrf={csrf}
          back={self}
        />
      )}
      <NextLink
        href={data.before ? `${self}${query({ before: data.before })}` : null}
        label={MESSAGES_LOAD_OLDER}
      />
      {data.messages.length === 0 ? (
        <p>{MESSAGES_THREAD_EMPTY}</p>
      ) : (
        <PostForm action="message_like" csrf={csrf}>
          <Hidden values={{ return: self, conversationId: data.conversationId }} />
          <p>
            <button formAction="/modernhaus/do/messages_read_all">Mark all as read</button>
          </p>
          <ol>
            {data.messages.map((m) => (
              <li key={m.id}>
                <article id={`m-${m.id}`}>
                  <header>
                    <p>
                      {m.senderId === viewer.id ? 'You' : m.senderDisplayName?.trim() || `@${m.senderUsername}`}
                      {' · '}
                      <Time at={new Date(m.createdAt)} />
                    </p>
                  </header>
                  {m.replyTo && (
                    <blockquote>
                      <p>{m.replyTo.senderUsername ?? MESSAGES_UNKNOWN_SENDER}</p>
                      {m.replyTo.content !== null ? <TextParagraphs text={m.replyTo.content} /> : <p>{MESSAGES_ENCRYPTED}</p>}
                    </blockquote>
                  )}
                  {m.content !== null ? <TextParagraphs text={m.content} /> : <p>{MESSAGES_COULD_NOT_DECRYPT}</p>}
                  <p>
                    {m.likeCount > 0 && `${m.likeCount} · `}
                    <button name="messageId" value={m.id}>
                      {m.likedByMe ? MESSAGES_UNLIKE : MESSAGES_LIKE}
                    </button>
                  </p>
                </article>
              </li>
            ))}
          </ol>
        </PostForm>
      )}
      {blocked && other ? (
        <p>{messagesBlockedSentence(memberName(other))}</p>
      ) : (
        <PostForm action="message_send" csrf={csrf}>
          <Hidden values={{ return: self, conversationId: data.conversationId }} />
          <p>
            <label>
              {MESSAGES_MESSAGE_PLACEHOLDER}
              <br />
              <textarea name="content" rows={4} cols={60} maxLength={10000} required defaultValue={props.draft ?? ''} />
            </label>
          </p>
          <p>Messages are text only, so they can’t carry links.</p>
          <p>
            <button>{MESSAGES_SEND}</button>
          </p>
        </PostForm>
      )}
      <p>
        <a href="/modernhaus/messages">All your messages</a>
      </p>
    </>
  )
}

export function NewMessagePage(props: { csrf: string; q: string; lookup: DmLookup | null }) {
  const { lookup } = props
  return (
    <>
      <form method="get" action="/modernhaus/messages/new">
        <p>
          <label>
            {`${MESSAGES_TO_LABEL} `}
            <input type="text" name="q" defaultValue={props.q} placeholder={MESSAGES_RECIPIENT_PLACEHOLDER} required />
          </label>{' '}
          <button>Find</button>
        </p>
      </form>
      {lookup?.kind === 'none' && <p>{MESSAGES_NO_ONE_FOUND}</p>}
      {lookup?.kind === 'refused' && <p>{MESSAGES_NO_ONE_FOUND}</p>}
      {lookup?.kind === 'matches' && (
        <PostForm action="conversation_start" csrf={props.csrf}>
          <ul>
            {lookup.accounts.map((a) => (
              <li key={a.id}>
                {`${a.displayName || a.username} (@${a.username}) `}
                <button name="memberId" value={a.id}>
                  {MESSAGES_NEW_MESSAGE_TITLE}
                </button>
              </li>
            ))}
          </ul>
        </PostForm>
      )}
    </>
  )
}
