import { createElement } from 'react'
import { APPEAL_UNUSABLE, APPEAL_ERROR, APPEAL_FORM_TITLE, APPEAL_FILED_TITLE } from '../../content/appeal'
import { EXPORT_USED_TITLE, EXPORT_ERROR_TITLE, EXPORT_LIMITED_TITLE, EXPORT_HELD_TITLE } from '../../content/account-export'
import { refusalCode } from '../outcomes'
import { call, path } from '../gateway'
import { documentResponse, loadViewer } from '../page'
import { downloadResponse } from '../respond'
import type { ActionContext, ActionOutcome, Input, Registry } from '../door'
import { AppealPage, AppealFiledPage, ExportRefusedPage, type ExportRefusal } from '../pages/rights'
import { ok, str } from './shared'

// =============================================================================
// modernhaus — an appeal and the account export, each spent on its POST
// (MODERNHAUS-ADR §D2.4, E6).
//
// The appeal route is UNAUTHENTICATED and answers every refusal alike (a bad
// token, a closed window, a second appeal), so this page does too: one
// sentence, the full site's. The export is the one-use step-up; its file is
// streamed on this POST as the full site's page downloads it.
// =============================================================================

const raw = (v: Input[string]): string => (typeof v === 'string' ? v : '')

async function render(ctx: ActionContext, title: string, body: ReturnType<typeof createElement>, status: number): Promise<ActionOutcome> {
  // The appeal is for members with no session: the viewer is read, never required.
  const viewer = await loadViewer(ctx.gw)
  return {
    kind: 'response',
    response: await documentResponse({
      title,
      viewer,
      csrf: ctx.csrf,
      twin: null,
      outcome: null,
      body,
      status,
      cookies: ctx.gw.setCookies,
    }),
  }
}

async function appeal(ctx: ActionContext, input: Input): Promise<ActionOutcome> {
  const reportId = str(input.reportId)
  const token = str(input.token)
  const text = raw(input.text)
  const a = await call(ctx.gw, 'POST', path`/moderation/appeal/${reportId}`, { json: { token, text } })
  if (ok(a)) return render(ctx, APPEAL_FILED_TITLE, createElement(AppealFiledPage), 200)
  // 403 is the route's one uninformative refusal; a 400 is an empty text,
  // which the form says by asking again. Anything else is the page's own.
  const sentence = a.status === 403 || a.status === 404 ? APPEAL_UNUSABLE : APPEAL_ERROR
  return render(
    ctx,
    APPEAL_FORM_TITLE,
    createElement(AppealPage, { csrf: ctx.csrf, reportId, token, text, error: sentence }),
    a.status >= 400 && a.status < 500 ? a.status : 500,
  )
}

async function exportDownload(ctx: ActionContext, input: Input): Promise<ActionOutcome> {
  const token = str(input.token)
  const a = await call(ctx.gw, 'GET', '/account/export' + `?token=${encodeURIComponent(token)}`)
  if (a.status === 401) return { kind: 'answer', answer: a }
  if (ok(a) && a.body !== null) {
    return {
      kind: 'response',
      response: downloadResponse(JSON.stringify(a.body, null, 2), 'platform-account-export.json', ctx.gw.setCookies),
    }
  }
  // 403 is the spent or expired link, or the hold after an email change (which
  // answers before the claim, so the link survives it); 429 the route's own
  // limit, which answers before the handler and so spends nothing; anything
  // else is a fault.
  const held = a.status === 403 && refusalCode(a.status, a.body) === 'export_held'
  const refusal: ExportRefusal = held ? 'held' : a.status === 403 ? 'used' : a.status === 429 ? 'limited' : 'error'
  if (refusal === 'error') console.error('[modernhaus] account export failed', a.status)
  const title = { used: EXPORT_USED_TITLE, held: EXPORT_HELD_TITLE, limited: EXPORT_LIMITED_TITLE, error: EXPORT_ERROR_TITLE }[refusal]
  const status = { used: 403, held: 403, limited: 429, error: 502 }[refusal]
  return render(ctx, title, createElement(ExportRefusedPage, { refusal }), status)
}

export const RIGHTS_ACTIONS: Registry = {
  appeal: {
    kind: 'orchestrated',
    fields: { reportId: 'string', token: 'string', text: 'string' },
    run: appeal,
    defaultReturn: (i) => `/modernhaus/appeal/${encodeURIComponent(str(i.reportId))}`,
  },
  export_download: {
    kind: 'orchestrated',
    fields: { token: 'string' },
    run: exportDownload,
    defaultReturn: () => '/modernhaus/settings/account',
  },
}
