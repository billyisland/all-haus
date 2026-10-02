import {
  APPEAL_FILED_BODY,
  APPEAL_INCOMPLETE_BODY,
  APPEAL_FORM_BODY,
  APPEAL_FIELD_LABEL,
  APPEAL_PLACEHOLDER,
  APPEAL_SUBMIT,
} from '../../content/appeal'
import {
  EXPORT_WORKING_BODY,
  EXPORT_DONE_KEY_WARNING,
  EXPORT_DONE_EMAILED,
  EXPORT_USED_BODY,
  EXPORT_ERROR_BODY,
  EXPORT_LIMITED_BODY,
  EXPORT_BACK_TO_SETTINGS,
} from '../../content/account-export'
import { PostForm, Hidden } from '../html'
import { ROUTE_ERRORS } from '../outcomes'

// =============================================================================
// modernhaus — two rights a member exercises from an email (MODERNHAUS-ADR
// §D2.3, E6): an appeal, and the account export.
//
// AN APPEAL CANNOT SIT BEHIND A SESSION (security.md): the page is public, the
// token in the address is the credential, and the page says nothing about the
// case — the member is holding the email that does.
//
// THE GET NEVER SPENDS A TOKEN. Both pages render one POST button, as the
// emailed sign-in link does (§E2): a mail scanner that opens the link spends
// nothing. The export then streams the file on that POST.
// =============================================================================

export function AppealPage(props: { csrf: string; reportId: string; token: string | null; text?: string; error?: string | null }) {
  if (!props.token) return <p>{APPEAL_INCOMPLETE_BODY}</p>
  return (
    <>
      <p>{APPEAL_FORM_BODY}</p>
      {props.error && <p role="alert">{props.error}</p>}
      <PostForm action="appeal" csrf={props.csrf}>
        <Hidden values={{ reportId: props.reportId, token: props.token }} />
        <p>
          <label>
            {APPEAL_FIELD_LABEL}
            <br />
            <textarea name="text" rows={8} cols={60} maxLength={4000} required placeholder={APPEAL_PLACEHOLDER} defaultValue={props.text ?? ''} />
          </label>
        </p>
        <p>
          <button>{APPEAL_SUBMIT}</button>
        </p>
      </PostForm>
    </>
  )
}

export function AppealFiledPage() {
  return <p>{APPEAL_FILED_BODY}</p>
}

export function ExportPage(props: { csrf: string; token: string | null }) {
  if (!props.token) return <p>{EXPORT_USED_BODY}</p>
  return (
    <>
      <p>{EXPORT_WORKING_BODY}</p>
      <p>{EXPORT_DONE_KEY_WARNING}</p>
      <PostForm action="export_download" csrf={props.csrf}>
        <Hidden values={{ token: props.token }} />
        <p>
          <button>Download my export</button>
        </p>
      </PostForm>
      <p>{EXPORT_DONE_EMAILED}</p>
    </>
  )
}

export type ExportRefusal = 'used' | 'held' | 'limited' | 'error'

const EXPORT_REFUSAL_BODY: Record<ExportRefusal, string> = {
  used: EXPORT_USED_BODY,
  held: ROUTE_ERRORS.export_held.sentence,
  limited: EXPORT_LIMITED_BODY,
  error: EXPORT_ERROR_BODY,
}

export function ExportRefusedPage(props: { refusal: ExportRefusal }) {
  return (
    <>
      <p>{EXPORT_REFUSAL_BODY[props.refusal]}</p>
      <p>
        <a href="/modernhaus/settings/account#export">{EXPORT_BACK_TO_SETTINGS}</a>
      </p>
    </>
  )
}
