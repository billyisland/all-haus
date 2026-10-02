import {
  SIGNIN_INTRO,
  SIGNIN_SUBMIT,
  SIGNIN_NEW_HERE,
  LINK_SENT_AGAIN,
  VERIFY_NO_TOKEN,
  VERIFY_REQUEST_NEW,
  signupIntro,
  SIGNUP_NAME_LABEL,
  SIGNUP_NAME_PLACEHOLDER,
  SIGNUP_SUBMIT,
  SIGNUP_BEEN_HERE,
  AGE_INTRO,
  AGE_SUBMIT,
  AGE_DECLINE,
  waitlistIntro,
  WAITLIST_SUBMIT,
  WAITLIST_HAVE_ACCOUNT,
  LINK_MAKE_ACCOUNT,
  LINK_JOIN_WAITLIST,
  LINK_LOG_IN,
  LINK_SIGN_OUT,
} from '../../content/auth'
import { PostForm, DateOfBirthBoxes, type DateOfBirthValues } from '../html'

// =============================================================================
// modernhaus — signing in, making an account, the age step and the waiting
// list (MODERNHAUS-ADR §D2.3 *Signing in*, E2). The words are the full site's,
// from `content/auth.ts`; Google sign-in stays on the full site (Decision 4).
// =============================================================================

function EmailField(props: { value?: string }) {
  return (
    <p>
      <label>
        {'Email '}
        <input type="email" name="email" required autoComplete="email" defaultValue={props.value ?? ''} />
      </label>
    </p>
  )
}

/** "New here?" — to whichever way in exists; the waiting list when unknown. */
function NewHere(props: { canSignUp: boolean }) {
  return (
    <p>
      {`${SIGNIN_NEW_HERE} `}
      {props.canSignUp ? (
        <a href="/modernhaus/signup">{LINK_MAKE_ACCOUNT}</a>
      ) : (
        <a href="/modernhaus/waitlist">{LINK_JOIN_WAITLIST}</a>
      )}
    </p>
  )
}

/**
 * `/modernhaus/signin`. `arrival` is an article's d-tag, carried through the
 * emailed link so a member who met a paywall lands back on the piece — the
 * one thing that survives the link being opened on another device.
 */
export function SigninPage(props: { csrf: string; arrival: string | null; sent: boolean; canSignUp: boolean }) {
  if (props.sent) {
    return (
      <p>
        <a href="/modernhaus/signin">{LINK_SENT_AGAIN}</a>
      </p>
    )
  }
  return (
    <>
      <p>{SIGNIN_INTRO}</p>
      <PostForm action="signin" csrf={props.csrf}>
        {props.arrival && <input type="hidden" name="arrival" value={props.arrival} />}
        <EmailField />
        <p>
          <button>{SIGNIN_SUBMIT}</button>
        </p>
      </PostForm>
      <NewHere canSignUp={props.canSignUp} />
    </>
  )
}

/**
 * `/modernhaus/auth/verify?token=`. THE GET NEVER CONSUMES THE TOKEN
 * (§D1.8.1): a mail scanner or a link preview that fetches the address would
 * otherwise spend a one-use link before the member ever sees it. The page is
 * one button, and the POST spends it.
 */
export function VerifyPage(props: { csrf: string; token: string | null; arrival: string | null; failed: boolean }) {
  if (props.failed || !props.token) {
    return (
      <>
        {!props.failed && <p>{VERIFY_NO_TOKEN}</p>}
        <p>
          <a href="/modernhaus/signin">{VERIFY_REQUEST_NEW}</a>
        </p>
      </>
    )
  }
  return (
    <PostForm action="verify" csrf={props.csrf}>
      <input type="hidden" name="token" value={props.token} />
      {props.arrival && <input type="hidden" name="arrival" value={props.arrival} />}
      <p>
        <button>Sign in</button>
      </p>
    </PostForm>
  )
}

export interface SignupValues {
  email: string
  displayName: string
  dob: DateOfBirthValues
}

/** `/modernhaus/signup`. Offered only while `GET /auth/open` says accounts can be made. */
export function SignupPage(props: { csrf: string; next: string | null; values: SignupValues }) {
  return (
    <>
      <p>{signupIntro(false)}</p>
      <PostForm action="signup" csrf={props.csrf}>
        {props.next && <input type="hidden" name="next" value={props.next} />}
        <EmailField value={props.values.email} />
        <p>
          <label>
            {`${SIGNUP_NAME_LABEL} `}
            <input
              type="text"
              name="displayName"
              required
              autoComplete="name"
              maxLength={100}
              placeholder={SIGNUP_NAME_PLACEHOLDER}
              defaultValue={props.values.displayName}
            />
          </label>
        </p>
        <DateOfBirthBoxes values={props.values.dob} />
        <p>
          <button>{SIGNUP_SUBMIT}</button>
        </p>
      </PostForm>
      <p>
        {`${SIGNUP_BEEN_HERE} `}
        <a href="/modernhaus/signin">{LINK_LOG_IN}</a>
      </p>
    </>
  )
}

/** `/modernhaus/age`. The one page an undeclared member can reach (§D2.2). */
export function AgePage(props: { csrf: string; next: string | null; values: DateOfBirthValues }) {
  return (
    <>
      <p>{AGE_INTRO}</p>
      <PostForm action="declare_age" csrf={props.csrf}>
        {props.next && <input type="hidden" name="next" value={props.next} />}
        <DateOfBirthBoxes values={props.values} />
        <p>
          <button>{AGE_SUBMIT}</button>
        </p>
      </PostForm>
      <PostForm action="signout" csrf={props.csrf}>
        <p>
          {`${AGE_DECLINE} `}
          <button>{LINK_SIGN_OUT}</button>
        </p>
      </PostForm>
    </>
  )
}

/** `/modernhaus/waitlist`. Once joined, the form is not offered again. */
export function WaitlistPage(props: { csrf: string; fromBeta: boolean; joined: boolean }) {
  return (
    <>
      {!props.joined && (
        <>
          <p>{waitlistIntro(props.fromBeta)}</p>
          <PostForm action="waitlist" csrf={props.csrf}>
            <EmailField />
            <p>
              <button>{WAITLIST_SUBMIT}</button>
            </p>
          </PostForm>
        </>
      )}
      <p>
        {`${WAITLIST_HAVE_ACCOUNT} `}
        <a href="/modernhaus/signin">{LINK_LOG_IN}</a>
      </p>
    </>
  )
}
