import { call, must, type GatewayAnswer, type GatewayContext, type Method } from './gateway'
import { checkCsrf, CSRF_FIELD } from './csrf'
import { redirectResponse } from './respond'
import { refusalCode, safeReturn } from './outcomes'
import { faultResponse, gatewayContext } from './page'

// =============================================================================
// modernhaus — the ONE write door, `POST /modernhaus/do/<action>`
// (MODERNHAUS-ADR §D1.3). No page handles a POST itself.
//
// In order:
//   1. CSRF (§D1.6). A refusal is a 403 and NOTHING runs — no gateway call.
//   2. The action, looked up in the registry. Unknown is a 404.
//   3. The form, shaped into the action's input by the entry's own `fields`:
//      checkbox → boolean (absent = false), number, repeated field → list. The
//      gateway's zod schema stays the validator; the door only shapes.
//   4. The entry runs: one call (simple) or several over the same routes the
//      browser chains (orchestrated).
//   5. The answer: success is a 303 to the validated `return` with `?done=`;
//      the route's own refusal is a 303 with `?error=<code>` from the closed
//      vocabulary; 401 goes to sign-in and `age_required` to the age step, here
//      and never per action; a fault of ours (a throw, a 5xx, an unmapped
//      status) is the fault page, never a success and never "not signed in".
//
// There is no method override: each entry knows its method, and a hidden
// `_method` field would only be a second place for the two to disagree.
// =============================================================================

export type FieldKind = 'string' | 'boolean' | 'number' | 'list'
export type Input = Record<string, string | boolean | number | string[] | null>

/**
 * `back` overrides the form's `return` where the entry learnt a better
 * destination while it ran — a draft saved for the first time has a page only
 * once its id exists. It passes `safeReturn` like any return.
 */
export type ActionOutcome =
  | { kind: 'done'; code: string; back?: string }
  /** A refusal the entry named itself — a door-minted code such as
   *  `stale_order`, from the closed vocabulary like every other. */
  | { kind: 'error'; code: string; back?: string }
  | { kind: 'answer'; answer: GatewayAnswer; back?: string }
  /** The entry built its own response (the unlock renders; a 400 re-renders its form). */
  | { kind: 'response'; response: Response }

export interface ActionContext {
  req: Request
  gw: GatewayContext
  csrf: string
  /** The whole posted form — for the entries that read a FILE part, which
   *  `fields` does not shape (an upload, a picture on a note or a reply). */
  form: FormData
}

interface ActionBase {
  fields: Record<string, FieldKind>
  /** Where the member goes when the form sent no usable `return`. */
  defaultReturn: (input: Input) => string
}

export interface SimpleAction extends ActionBase {
  kind: 'simple'
  method: Method
  path: (input: Input) => string
  body?: (input: Input) => unknown
  /** The `?done=` code on a 2xx. */
  done: string
}

export interface OrchestratedAction extends ActionBase {
  kind: 'orchestrated'
  run: (ctx: ActionContext, input: Input) => Promise<ActionOutcome>
}

export type Action = SimpleAction | OrchestratedAction
export type Registry = Readonly<Record<string, Action>>

/**
 * A form's line breaks, as the member typed them. HTML submits a textarea's
 * newlines as CRLF (the form-submission value), where the full site's script
 * sends LF — so without this every multi-line note, reply, draft and message
 * from this register was stored with `\r\n`, and counted two characters per
 * break against a limit.
 */
export function normaliseLineBreaks(v: string): string {
  return v.replace(/\r\n?/g, '\n')
}

export function shapeInput(form: FormData, fields: Record<string, FieldKind>): Input {
  const input: Input = {}
  for (const [name, kind] of Object.entries(fields)) {
    const values = form
      .getAll(name)
      .filter((v): v is string => typeof v === 'string')
      .map(normaliseLineBreaks)
    switch (kind) {
      case 'boolean':
        input[name] = values.length > 0
        break
      case 'list':
        input[name] = values
        break
      case 'number': {
        const n = values[0] === undefined || values[0].trim() === '' ? NaN : Number(values[0])
        input[name] = Number.isFinite(n) ? n : null
        break
      }
      default:
        input[name] = values[0] ?? null
    }
  }
  return input
}

function withParam(path: string, key: 'done' | 'error', code: string): string {
  const u = new URL(path, 'http://modernhaus.invalid')
  u.searchParams.delete('done')
  u.searchParams.delete('error')
  u.searchParams.set(key, code)
  return u.pathname + u.search
}

function isAgeRequired(body: unknown): boolean {
  return !!body && typeof body === 'object' && (body as { error?: unknown }).error === 'age_required'
}

/** Handle one POST. The route file passes the live registry; tests pass their own. */
export async function handleDoor(req: Request, actionName: string, registry: Registry): Promise<Response> {
  const gw = gatewayContext(req)

  let form: FormData
  try {
    form = await req.formData()
  } catch {
    return faultResponse(400, [])
  }

  const submitted = form.get(CSRF_FIELD)
  const refusal = checkCsrf(req, typeof submitted === 'string' ? submitted : null)
  if (refusal !== null) {
    console.warn('[modernhaus] csrf refused', actionName, refusal)
    return faultResponse(403, [])
  }

  const action = Object.prototype.hasOwnProperty.call(registry, actionName) ? registry[actionName] : undefined
  if (!action) return faultResponse(404, [])

  const input = shapeInput(form, action.fields)
  const rawReturn = form.get('return')
  const back = safeReturn(typeof rawReturn === 'string' ? rawReturn : null) ?? action.defaultReturn(input)

  try {
    let outcome: ActionOutcome
    if (action.kind === 'simple') {
      const answer = await call(gw, action.method, action.path(input), {
        json: action.body ? action.body(input) : undefined,
      })
      outcome =
        answer.status >= 200 && answer.status < 300
          ? { kind: 'done', code: action.done }
          : { kind: 'answer', answer }
    } else {
      outcome = await action.run({ req, gw, csrf: typeof submitted === 'string' ? submitted : '', form }, input)
    }

    if (outcome.kind === 'response') return outcome.response
    const to = (outcome.back !== undefined ? safeReturn(outcome.back) : null) ?? back
    if (outcome.kind === 'done') return redirectResponse(withParam(to, 'done', outcome.code), gw.setCookies)
    if (outcome.kind === 'error') return redirectResponse(withParam(to, 'error', outcome.code), gw.setCookies)

    const { status, body } = must(outcome.answer, `do/${actionName}`)
    if (status === 401) {
      return redirectResponse(`/modernhaus/signin?return=${encodeURIComponent(to)}`, gw.setCookies)
    }
    if (status === 403 && isAgeRequired(body)) return redirectResponse('/modernhaus/age', gw.setCookies)
    const code = refusalCode(status, body)
    if (code === null) {
      console.error('[modernhaus] unmapped gateway answer', actionName, status)
      return faultResponse(500, gw.setCookies)
    }
    return redirectResponse(withParam(to, 'error', code), gw.setCookies)
  } catch (err) {
    console.error('[modernhaus] door fault', actionName, err)
    return faultResponse(500, gw.setCookies)
  }
}
