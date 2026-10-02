import type { Post } from "./types";

// =============================================================================
// replyTargetFromPost — the ONE way a card raises a reply.
//
// A reply and a quote are different acts with different wire formats: a reply
// is a kind-1111 comment (`publishReply` → POST /replies), a quote is a NIP-18
// note that q-tags what it quotes (`publishNote`). The compose store carries
// both, and they must not be built by the same literal — five card surfaces had
// each hand-rolled a QuoteTarget and handed it to the store's REPLY channel,
// so every one of them would have published a quote had the surface they sat on
// mounted a composer at all (none did; see LayoutShell's mount gate).
//
// Native-only, and the `null` is the affordance's own gate: `authorPubkey` is
// the NIP-10 `p` tag, and an external post has none — a card offers Reply iff
// this returns a target (`.claude/rules/web-cards-and-threads.md`).
//
// PURE, so both registers build the target here, the full site's card and
// modernhaus's server-rendered conversation alike.
// =============================================================================

export interface ReplyTarget {
  // The event being threaded under. For a reply to a top-level note/article this
  // is that event; for a reply to a comment this is the conversation ROOT (so
  // target_event_id stays the root and the comment is linked via the parent
  // fields below — the gateway refuses anything else, see the builder).
  eventId: string;
  eventKind: number;
  // The author being replied to (parent comment author for nested replies) —
  // drives the NIP-10 `p` tag and the "Replying to …" line.
  authorPubkey: string;
  authorName: string;
  excerpt?: string;
  // Set when replying to a comment rather than a top-level post: the parent
  // comment's UUID (index linkage) and its Nostr event id (NIP-10 `e` reply tag).
  parentCommentId?: string;
  parentCommentEventId?: string;
}

// The banner above the textarea, not a stored snapshot — a quote's excerpt is
// frozen into the published note (`quotePreviewContent`) and is sized by what
// is being quoted; this one is thrown away when the pane closes.
const BANNER_EXCERPT_CHARS = 120;

// A REPLY IS ADDRESSED TO THE CONVERSATION, NOT TO THE REMARK.
//
// A native comment is projected as a Post of `type: "note"` carrying its own
// event id in `version` — so the branch below is the ONLY thing that tells one
// from a top-level note, and without it this built `{eventId: <comment's own
// event>, eventKind: 1}` for every reply in every thread. `POST /replies`
// refuses that by design (400 `target_is_reply`: `comments.target_event_id` is
// the conversation's ROOT, replies-to-replies share it and nest via
// `parentCommentId`), so replying to a reply failed on every card surface from
// the day the Post model replaced `ConversationView` — which had carried the
// nesting and was the "see ConversationView" this file's interface used to
// point at. The article page's own `ReplySection` never lost it, which is why
// the same act worked there throughout.
//
// The `p` tag and the banner still name the COMMENT's author: that is who is
// being replied to. Only the thread address moves to the root.
export function replyTargetFromPost(post: Post): ReplyTarget | null {
  const pubkey = post.author.pubkey;
  if (!pubkey) return null;
  const conversation = post.conversation;
  return {
    eventId: conversation ? conversation.rootEventId : post.version ?? post.id,
    eventKind: conversation
      ? conversation.rootKind
      : post.type === "article"
        ? 30023
        : 1,
    authorPubkey: pubkey,
    ...(conversation
      ? {
          parentCommentId: conversation.commentId,
          // The NIP-10 `e` reply tag — the comment's own event id, which for a
          // comment Post is exactly `version`.
          parentCommentEventId: post.version ?? undefined,
        }
      : {}),
    // A member with no display name is named by their handle, as the byline
    // names them; the composer's own fallback covers neither being known.
    authorName: post.author.displayName ?? post.author.handle ?? "",
    excerpt: (post.body.text ?? "").slice(0, BANNER_EXCERPT_CHARS) || undefined,
  };
}
