"use client";

// =============================================================================
// WriterAccessPanel — what a READER meets wherever writing would be
// (READER-WRITER-SPLIT-ADR §6).
//
// A reader is offered no writing control (web/CLAUDE.md › *A button that
// cannot do its job is not offered*), and the absence is EXPLAINED, once, by
// this one body: the ∀ menu's "Apply to write" row opens it (through the
// dashboard's overlay), a deep link to the dashboard or the editor lands on it,
// and `/write` and `/traffology` reached directly render it rather than a 403.
// The words are `content/writer-access.ts`, shared with modernhaus.
//
// The one act here is the application (D3's `POST /writer-applications`): one
// press, nothing asked (O4). A pending application reads back off
// `/auth/me`'s `writerApplication`, so the press is never offered twice. A 409
// `already_writer` means the grant landed while this was open — re-read the
// session, and the surface that rendered this one renders the real thing.
// =============================================================================

import { useState } from "react";
import { PageHeader, PageShell } from "../ui/PageShell";
import { useAuth } from "../../stores/auth";
import { auth } from "../../lib/api/auth";
import { ApiError, failureSentence } from "../../lib/api/client";
import {
  WRITER_ACCESS_TITLE,
  WRITER_ACCESS_BODY,
  WRITER_ACCESS_ASK,
  WRITER_APPLY,
  WRITER_APPLY_SENDING,
  WRITER_APPLY_FAILED,
  writerApplied,
  formatAppliedDate,
} from "../../content/writer-access";

export function WriterAccessPanel() {
  const application = useAuth((s) => s.user?.writerApplication ?? null);
  const [sending, setSending] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function apply() {
    setSending(true);
    setError(null);
    try {
      const { appliedAt } = await auth.applyToWrite();
      const user = useAuth.getState().user;
      if (user) useAuth.getState().setUser({ ...user, writerApplication: { appliedAt } });
    } catch (err) {
      if (err instanceof ApiError && err.status === 409) {
        await useAuth.getState().fetchMe();
      } else {
        setError(failureSentence(err, WRITER_APPLY_FAILED));
      }
    } finally {
      setSending(false);
    }
  }

  return (
    <div className="max-w-[520px]">
      <PageHeader title={WRITER_ACCESS_TITLE} />
      <p className="text-ui-sm text-black mb-3">{WRITER_ACCESS_BODY}</p>
      {application ? (
        <p className="text-ui-sm text-grey-600">
          {writerApplied(formatAppliedDate(application.appliedAt))}
        </p>
      ) : (
        <>
          <p className="text-ui-sm text-grey-600 mb-6">{WRITER_ACCESS_ASK}</p>
          <button type="button" onClick={apply} disabled={sending} className="btn">
            {sending ? WRITER_APPLY_SENDING : WRITER_APPLY}
          </button>
          {error && <p className="text-ui-xs text-crimson mt-3">{error}</p>}
        </>
      )}
    </div>
  );
}

/** A writer page reached directly by a reader (`/write`, `/traffology`): the
 *  same body as a page, never a 403. The band clears the fixed PublicNavBar
 *  LayoutShell mounts on every non-workspace route (as `TraffologyShell`). */
export function WriterAccessPage() {
  return (
    <div style={{ paddingTop: "var(--ah-bar-band, 0px)" }}>
      <PageShell width="article">
        <WriterAccessPanel />
      </PageShell>
    </div>
  );
}
