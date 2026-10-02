// =============================================================================
// Direct messages — the words, in one home for both registers.
//
// The full site's `components/messages/MessagesInbox.tsx`,
// `ConversationList.tsx` and `MessageThread.tsx` (client components) and
// modernhaus's bare-HTML messages pages say the same things. They live here
// because modernhaus cannot import a `'use client'` file. The reasoning behind
// each sentence is in those components' comments.
// =============================================================================

// --- The inbox and the new-message form (MessagesInbox) ----------------------

export const MESSAGES_NEW_MESSAGE_TITLE = 'New message'
export const MESSAGES_TO_LABEL = 'To'
export const MESSAGES_RECIPIENT_PLACEHOLDER = 'Username, email, npub…'
export const MESSAGES_NO_ONE_FOUND = 'No one found. Try their username, email address or npub.'
export const MESSAGES_START_FAILED = 'Couldn’t start the conversation. Please try again.'
/** The desktop reading pane with nothing selected. */
export const MESSAGES_EMPTY_PANE = 'Select a conversation or start a new one.'
/** A conversation with no other member who has a name to show. */
export const MESSAGES_CONVERSATION_FALLBACK = 'Conversation'

// --- The conversation list (ConversationList) --------------------------------

export const MESSAGES_TITLE = 'Messages'
export const MESSAGES_NEW = 'New'
export const MESSAGES_NO_CONVERSATIONS = 'No conversations yet.'
/** The list did not load — not the same fact as an empty one (CA-E1). */
export const MESSAGES_LOAD_FAILED = 'Couldn’t load your conversations. Please try again.'
/** Screen-reader text beside the unread dot. */
export const MESSAGES_UNREAD = 'Unread'

// --- The thread (MessageThread) ----------------------------------------------

export const MESSAGES_LOAD_OLDER = 'Load older messages'
export const MESSAGES_THREAD_EMPTY = 'No messages yet. Start the conversation.'
/** A quoted reply whose sender has no username. */
export const MESSAGES_UNKNOWN_SENDER = 'Unknown'
/** A quoted reply (or the reply preview) whose text could not be decrypted. */
export const MESSAGES_ENCRYPTED = 'Encrypted message'
export const MESSAGES_COULD_NOT_DECRYPT = 'Couldn’t open this message'
export const MESSAGES_REPLY = 'Reply'
export const MESSAGES_LIKE = 'Like'
export const MESSAGES_UNLIKE = 'Unlike'

/** The reply preview bar above the composer. */
export function messagesReplyingTo(name: string): string {
  return `Replying to ${name}`
}

/** Replaces the send box once the viewer has blocked the other member. */
export function messagesBlockedSentence(memberName: string): string {
  return `You’ve blocked ${memberName}. Neither of you can send messages here until you unblock them.`
}

export const MESSAGES_REPLY_PLACEHOLDER = 'Write a reply…'
export const MESSAGES_MESSAGE_PLACEHOLDER = 'Write a message…'
export const MESSAGES_SEND = 'Send'
/** The send failed and the gateway sent no sentence of its own. */
export const MESSAGES_SEND_FAILED = 'That message didn’t send. It’s still in the box, so please try again.'
