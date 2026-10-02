import { safeHttpUrl } from '../lib/external-links'
import { call, must, type GatewayAnswer } from './gateway'
import type { ActionContext } from './door'

// =============================================================================
// modernhaus — a picture: one file part off the member's form, rebuilt into
// the multipart body `POST /media/upload` reads (MODERNHAUS-ADR §D1.4), and
// the public address the route answers with. Used by the note, the reply and
// the upload page.
// =============================================================================

export type Upload = { kind: 'none' } | { kind: 'stored'; url: string } | { kind: 'refused'; answer: GatewayAnswer }

/** The named file part, if the member chose one. An empty file input posts a nameless, empty part. */
export function filePart(form: FormData, name: string): File | null {
  const v = form.get(name)
  return v instanceof File && v.size > 0 ? v : null
}

export async function uploadPicture(ctx: ActionContext, file: File | null): Promise<Upload> {
  if (!file) return { kind: 'none' }
  const body = new FormData()
  body.append('file', file, file.name || 'picture')
  const answer = must(await call<{ url?: string }>(ctx.gw, 'POST', '/media/upload', { form: body }), 'media upload')
  if (answer.status === 200 || answer.status === 201) {
    const url = safeHttpUrl(answer.body?.url)
    if (!url) throw new Error('media upload answered without a usable url')
    return { kind: 'stored', url }
  }
  return { kind: 'refused', answer }
}
