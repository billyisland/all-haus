'use client'

import { useCallback, useRef, useState, type ReactNode, type RefObject } from 'react'
import { AnchoredPopover } from './AnchoredPopover'

// =============================================================================
// ConfirmDialog — the house's one "are you sure?", hung off the control that
// asked it.
//
// Built for W2's Block (walkthrough A7), and meant to be the home A12 (W5)
// moves the site's `window.confirm(` calls onto — so it is written for that
// job rather than for Block alone. Three decisions carry it:
//
//   · IT IS ANCHORED, NOT CENTRED. A confirmation is about the press that
//     raised it, so it opens off that control through `AnchoredPopover`, which
//     already solves the two hard parts: it portals out of a clipping
//     Glasshouse pane at the popover layer (no new z number, no hand-rolled
//     `fixed inset-0` scrim — the thing the DangerZone modal gets wrong), and
//     it moves focus in on open and back to the trigger on dismiss.
//   · IT IS A PAIRED ACTION DIALOG, the stated exception to the floating-✕
//     rule: the confirm and a labelled Cancel sit side by side, and Escape or
//     an outside press are Cancel too.
//   · IT SAYS THE CONSEQUENCE BEFORE THE PRESS. The body is the caller's, and
//     it should name what the act does to other people and to money — a
//     confirmation that only repeats the button's word is `confirm()` in a
//     nicer box. An error from the act lands IN the panel, so a failure is
//     never a silent close.
// =============================================================================

export function ConfirmDialog({
  anchorRef,
  open,
  title,
  children,
  confirmLabel,
  busy = false,
  confirmDisabled = false,
  error = null,
  onConfirm,
  onCancel,
  width = 300,
}: {
  anchorRef: RefObject<HTMLElement | null>
  open: boolean
  /** Also the dialog's accessible name. */
  title: string
  /** What the act does — see the header. */
  children: ReactNode
  confirmLabel: string
  busy?: boolean
  /** A gate the body owns — the delete modal's typed email. */
  confirmDisabled?: boolean
  error?: string | null
  onConfirm: () => void
  onCancel: () => void
  width?: number
}) {
  return (
    <AnchoredPopover
      anchorRef={anchorRef}
      open={open}
      onDismiss={() => {
        if (!busy) onCancel()
      }}
      width={width}
      over="paper"
      role="dialog"
      ariaLabel={title}
      className="p-4"
    >
      <h3 className="text-ui-sm font-medium text-black mb-2">{title}</h3>
      <div className="text-ui-xs text-grey-600 leading-relaxed space-y-2 mb-3">
        {children}
      </div>
      {error && <p className="text-ui-xs text-crimson mb-2">{error}</p>}
      <div className="flex items-center gap-4">
        <button
          onClick={onConfirm}
          disabled={busy || confirmDisabled}
          className="btn-accent btn-sm disabled:opacity-50"
        >
          {busy ? '…' : confirmLabel}
        </button>
        <button onClick={onCancel} disabled={busy} className="btn-text-muted">
          Cancel
        </button>
      </div>
    </AnchoredPopover>
  )
}

// =============================================================================
// useConfirm — the drop-in for `window.confirm(`.
//
// `confirm()` is synchronous and anchorless; this is neither, so a call site
// passes the control that was pressed and AWAITS the answer:
//
//   const { ask, dialog } = useConfirm()
//   async function onDelete(e: React.MouseEvent<HTMLElement>) {
//     if (!(await ask(e.currentTarget, { title, body, confirmLabel }))) return
//     …
//   }
//   … {dialog} somewhere in the tree (it portals, so where does not matter)
//
// The answer resolves on the press, so an error from the act that follows is
// the CALLER'S line to render, not the panel's. Where the act's failure
// belongs inside the panel (the Block and account-delete flows), use
// `ConfirmDialog` directly with `busy`/`error`.
//
// A second `ask` while one is open cancels the first (resolves it `false`),
// so an awaiting caller is never left hanging.
// =============================================================================

export interface ConfirmRequest {
  title: string
  body: ReactNode
  confirmLabel: string
  width?: number
}

export function useConfirm() {
  const anchorRef = useRef<HTMLElement | null>(null)
  const [req, setReq] = useState<
    (ConfirmRequest & { resolve: (ok: boolean) => void }) | null
  >(null)

  const ask = useCallback(
    (anchor: HTMLElement | null, request: ConfirmRequest) =>
      new Promise<boolean>((resolve) => {
        anchorRef.current = anchor
        setReq((prev) => {
          prev?.resolve(false)
          return { ...request, resolve }
        })
      }),
    [],
  )

  const settle = (ok: boolean) => {
    req?.resolve(ok)
    setReq(null)
  }

  const dialog = (
    <ConfirmDialog
      anchorRef={anchorRef}
      open={req !== null}
      title={req?.title ?? ''}
      confirmLabel={req?.confirmLabel ?? ''}
      width={req?.width}
      onConfirm={() => settle(true)}
      onCancel={() => settle(false)}
    >
      {req?.body}
    </ConfirmDialog>
  )

  return { ask, dialog }
}
