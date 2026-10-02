import {
  MUTE_LABEL,
  UNMUTE_LABEL,
  BLOCK_LABEL,
  UNBLOCK_LABEL,
  MUTE_BLOCK_UNAVAILABLE,
} from '../../content/social'
import { query } from '../gateway'
import { PostForm, Hidden } from '../html'
import type { Relation } from '../messages-loaders'

// =============================================================================
// modernhaus — mute and block (MODERNHAUS-ADR §D2.4, E6), where the full site
// mounts `MuteBlockControls`: a member's profile and a two-person DM thread.
//
// A BLOCK ENDS THINGS, so it is its own page that says what it ends before the
// press (security.md; the confirmation's words are the full site's). Mute,
// unmute and unblock are single presses, as they are on the full site.
// Only what the VIEWER has done is shown: a block the other party set is not
// disclosed here or anywhere.
// =============================================================================

export function RelationControls(props: {
  userId: string
  username: string
  name: string
  relation: Relation | null
  csrf: string
  back: string
}) {
  if (props.relation === null) return <p>{MUTE_BLOCK_UNAVAILABLE}</p>
  const { muted, blocked } = props.relation
  return (
    <PostForm action={muted ? 'unmute' : 'mute'} csrf={props.csrf}>
      <Hidden values={{ return: props.back, userId: props.userId }} />
      <p>
        <button>{muted ? UNMUTE_LABEL : MUTE_LABEL}</button>{' '}
        {blocked ? (
          <button formAction="/modernhaus/do/unblock">{UNBLOCK_LABEL}</button>
        ) : (
          <a href={`/modernhaus/confirm/block${query({ username: props.username, return: props.back })}`}>{BLOCK_LABEL}</a>
        )}
      </p>
    </PostForm>
  )
}

/** A member's profile, seen by somebody else: message them, mute or block them. */
export function ProfileSocial(props: {
  userId: string
  username: string
  name: string
  relation: Relation | null
  csrf: string
  back: string
}) {
  return (
    <>
      {props.relation?.blocked !== true && (
        <PostForm action="conversation_start" csrf={props.csrf}>
          <Hidden values={{ memberId: props.userId }} />
          <p>
            <button>Message</button>
          </p>
        </PostForm>
      )}
      <RelationControls {...props} />
    </>
  )
}
