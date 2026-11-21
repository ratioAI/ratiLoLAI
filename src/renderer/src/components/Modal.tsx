import { useEffect, useRef, useState, type ReactNode } from 'react'
import { Loader2, Trash2 } from 'lucide-react'

/** True while a dialog is open – page-wide keyboard shortcuts must stay quiet underneath it. */
export function modalOpen(): boolean {
  return !!document.querySelector('[aria-modal="true"]')
}

/**
 * A dialog over the page: dims the rest, closes on Escape or a click beside it, and hands the
 * keyboard focus back to where it was. Escape is taken before any shortcut of the page under it,
 * so it closes only the dialog on top.
 */
export function Modal({
  onClose,
  children,
  className = 'max-w-md',
  label,
  z = 120
}: {
  onClose: () => void
  children: ReactNode
  /** width and padding of the box */
  className?: string
  label: string
  z?: number
}) {
  const box = useRef<HTMLDivElement>(null)
  const close = useRef(onClose)
  close.current = onClose
  useEffect(() => {
    const before = document.activeElement as HTMLElement | null
    box.current?.focus()
    const onKey = (event: KeyboardEvent): void => {
      if (event.key !== 'Escape') return
      // only the dialog on top reacts
      const dialogs = document.querySelectorAll('[aria-modal="true"]')
      if (dialogs[dialogs.length - 1] !== box.current) return
      event.stopImmediatePropagation()
      event.preventDefault()
      close.current()
    }
    window.addEventListener('keydown', onKey, true)
    return () => {
      window.removeEventListener('keydown', onKey, true)
      if (before?.isConnected) before.focus()
    }
  }, [])
  return (
    <div
      className="fixed inset-0 flex items-center justify-center p-8"
      style={{ zIndex: z, background: 'rgb(4 2 10 / 0.84)' }}
      onClick={onClose}
    >
      <div
        ref={box}
        role="dialog"
        aria-modal="true"
        aria-label={label}
        tabIndex={-1}
        className={`panel w-full outline-none ${className}`}
        onClick={(event) => event.stopPropagation()}
      >
        {children}
      </div>
    </div>
  )
}

/**
 * "Are you sure?" before something that cannot be undone. Stays open and says why when the action
 * fails.
 */
export function ConfirmDialog({
  title,
  children,
  confirmLabel = 'Delete',
  onConfirm,
  onCancel,
  z = 160
}: {
  title: string
  children?: ReactNode
  confirmLabel?: string
  onConfirm: () => unknown
  onCancel: () => void
  z?: number
}) {
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const run = async (): Promise<void> => {
    setBusy(true)
    setError(null)
    try {
      await onConfirm()
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : String(reason))
      setBusy(false)
    }
  }
  return (
    <Modal onClose={onCancel} label={title} className="max-w-md p-6" z={z}>
      <h2 className="mb-3 font-display text-xl font-extrabold">{title}</h2>
      {children && <div className="mb-5 text-sm leading-relaxed text-muted">{children}</div>}
      {error && <p className="mb-4 text-sm text-loss">Did not work: {error}</p>}
      <div className="flex justify-end gap-2">
        <button className="btn btn-ghost" onClick={onCancel} autoFocus>
          Cancel
        </button>
        <button className="btn btn-ghost border-loss/50 text-loss" disabled={busy} onClick={() => void run()}>
          {busy ? <Loader2 size={15} className="animate-spin" /> : <Trash2 size={15} />} {confirmLabel}
        </button>
      </div>
    </Modal>
  )
}
