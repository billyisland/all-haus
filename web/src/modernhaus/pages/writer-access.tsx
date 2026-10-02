import {
  WRITER_ACCESS_BODY,
  WRITER_ACCESS_ASK,
  WRITER_APPLY,
  writerApplied,
  formatAppliedDate,
} from '../../content/writer-access'
import { PostForm, Hidden, type Viewer } from '../html'

// =============================================================================
// modernhaus — what a READER meets where writing would be
// (READER-WRITER-SPLIT-ADR §6.3). The full site's `WriterAccessPanel`, as a
// page: every writing and dashboard page renders this for a reader rather than
// a form whose every press the gateway refuses. The words are
// `content/writer-access.ts`, shared with the full site; the one act is
// `writer_apply`, over the same `POST /writer-applications`.
// =============================================================================

export function WriterAccessPage(props: { viewer: Viewer; csrf: string; back: string }) {
  const application = props.viewer.writerApplication ?? null
  return (
    <>
      <p>{WRITER_ACCESS_BODY}</p>
      {application ? (
        <p>{writerApplied(formatAppliedDate(application.appliedAt))}</p>
      ) : (
        <>
          <p>{WRITER_ACCESS_ASK}</p>
          <PostForm action="writer_apply" csrf={props.csrf}>
            <Hidden values={{ return: props.back }} />
            <p>
              <button>{WRITER_APPLY}</button>
            </p>
          </PostForm>
        </>
      )}
    </>
  )
}
